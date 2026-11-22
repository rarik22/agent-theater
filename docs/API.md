# API

The server listens on `127.0.0.1` only and answers requests whose `Host` is `127.0.0.1`, `localhost`
or `[::1]` on its port.

| Endpoint | Returns |
| --- | --- |
| `GET /api/state` | The current state as JSON |
| `GET /api/stream` | Server-Sent Events: the same state as an unnamed `message` event (`data: {...}`) every `pushSeconds` |
| `GET /api/replay?hours=8&frames=240` | A time-lapse: events plus evenly spaced state frames for the last N hours |
| `GET /api/replay?from=<ISO>&to=<ISO>&frames=600` | The same for a past window (at most `replay.maxHours`; a window ending after now stops at now; a bad window answers 400 with `{ error }`) |
| `GET /api/health` | `{ ok, now, sources }` |
| `GET /api/agent?id=<agent id>` | An agent's log (below): what a click on an agent opens. 400 for a malformed id, 404 for one the theater does not know |
| `POST /api/events` | The event API ([EVENTS.md](EVENTS.md)) |

Query flags on every `GET` endpoint:

- `public=0` shows redacted tool descriptions instead of the generic phrases. Public mode is the
  default.
- `sample=1` serves the labelled sample simulation instead of live data; with it, `at=<unix seconds>`
  serves the sample at that moment (for repeatable screenshots).

## State

```text
{ now, mode: "live"|"replay", sample, public,
  project: { name, done, total, features: { done, total } | null, batch, release?,
             labels: { jobs, features, batch } },
  pipeline: { model: "runs"|"jobs", stations: [{ tag, kind }],
              lanes: [{ id, tag, stations: [{ tag, kind }], current, done, status, show, active,
                        progress: { done, total } }] },
  agents: [{ id, role, job, lane, station, stationTag, tag, place?, standalone?, idle?, title, label,
             since, activeAt, say, action: { kind, text, since, background? } }],
  queue: { entries: [{ slug, id, lane, status, title, kind, bounces, readyAt,
                       release?, integratedAt?, mergedAt? }],
           batch: { n, slugs, startedAt, status } | null, lastBatch,
           releases?: [release], release?: release | null },
  slots: [{ n, holder, job, lane, since }], exclusive: { holder, job, lane, since } | null,
  lock: { holder, job, lane, since } | null,
  events: [{ id, at, type, job, lane?, slug?, role?, text }],
  yard: { labels: { test, merge, develop, remote } },
  sources: { claude, workflows, subagents, progress, lanes, queue, locks, git, events } }
```

- **project**: `done`/`total` is the controller's main counter: workflow runs completed of those
  started in the last `countHours` (runs model; merge workflows' runs not counted), a progress file's job totals (jobs model, or the runs model with a progress file), or the last
  `progress` event of the event API. `features` is the second counter (agents finished of started, or
  a preset's tracked features). `batch` is the third (runs running now, or the running merge batch).
  With release trains, `release` is the version on the merge machine and the controller shows it in
  place of the batch (labelled `REL` unless the counters are named in the config). `labels` are the
  words the controller shows for them. `name` is `projectName` from the config, or null; the stage
  never draws it.
- **pipeline.lanes**: the lanes the stage can show, in order. `id` is the chip code (at most six
  capitals, digits or dashes, unique among the lanes), `tag` a public name (at most 16 characters).
  `stations` are 1 to 6 stations, each with a tag (at most 12 characters) and the `kind` of console it
  shows: `setup`, `coder`, `reviewer`, `fixer` or `preparer`. `current` is the station of the run's
  latest agent, `done` the number of stations completed. `status` is `running`, `completed`, `killed`
  (stopped), `waiting` or `idle`. `show` marks lanes that may take a row; `active` lanes have an agent
  at a station now.
- **agents**: `role` is `setup`, `coder`, `reviewer`, `fixer`, `preparer`, `merger`, `verifier` or
  `helper`. An agent with a `lane` and a `station` stands at that station; `place: "merge"` stands at
  the merge machine; anyone else stands on the dock. `job` keys hand-overs: agents of one workflow run
  share it (`RUN-<run id>`), so the next phase's agent walks over from the last one's spot.
  `action.kind` is `edit`, `read`, `search`, `run`, `test`, `browser`, `docker`, `think` or `wait`;
  `action.text` is a generic phrase in public mode; `action.since` is when the action started.
  `background: true` means the agent waits on a background command that is doing what the phrase says.
  `say` is the line its speech bubble shows: the generic phrase in public mode; in the private view
  the first sentence of the agent's latest message (redacted, at most 140 characters) while it is less
  than 15 minutes old, else the action's text.
- **queue**: the merge queue file. With merge batches an entry's `status` is `ready`, `batched`,
  `bounced`, `held`, `merged` or `dropped`, and `batch` is the running batch. With release trains (a
  schema-2 queue file, see [SOURCES.md](SOURCES.md)) it is `queued` (waiting for the next release),
  `integrated` (merged into the release branch `release`, waiting for that release's check; never
  merged and never queued), `merged` (its release reached the branch: `release`, `mergedAt`),
  `moved-out` (taken out of its release, back in its lane) or `dropped`. Merged and dropped entries
  stay listed for `recentQueueMinutes`.
- **queue.releases** (whenever the merge machine works on releases): the unfinished releases and those
  that passed in the last `recentQueueMinutes`, in version order. `queue.release` is the one on the
  merge machine: the oldest unfinished release (releases reach the branch in order), else the one that
  just passed. A merge workflow's live run (see **agents**) is enough on its own: without a queue file
  the list holds one release made from that run, `status: "running"`, its `version` from the run's
  subject or labels (or null), `counted` and `capacity` null, and `since` and `phase` its current phase.

  ```text
  { version, status: "open"|"verifying"|"fixing"|"passed", activity, gate, capacity, counted,
    entries: [slug], fixes, fixRounds, failures, openFailure: { stage, at, entries, reason? } | null,
    checks, check: { n, result, startedAt, finishedAt, reason? } | null,
    openedAt, closedAt, passedAt, lastIntegratedAt, tag }
  ```

  `activity` is what the runner does with it now. The live merge workflow's phase says it first
  (integrate: `integrating`; verify, check, test: `checking`; merge, release, ship, publish, tag:
  `merging`; fix, and a review after a fix: `fixing`; anything else: `working`), for the release the
  run names, else the one that phase can act on (an integration the open release, a fix the one that is
  fixing, a check or a merge the oldest unfinished one). The record and the lock owners add: `merging`
  (the branch's merge lock is held, for the oldest unfinished release), `checking` (a check run is
  running, or `release-<v>` holds the exclusive hold or every test booth), `integrating` (a merger
  holds the `release-<v>` lock), `fixing` (status fixing, or a fixer holds its lock or a booth), else
  its status (`open`, `verifying`, `passed`). `counted` counts its counted entries (`entries` lists
  them in integration order, without those moved out); fix merges (`fixes`) never count. `fixRounds` is
  the sum of its per-entry fix rounds. `reason` fields are only in the private view, redacted. In replay
  frames no lock owners are known, so `activity` comes from the merge runs and the record, and `fixRounds` counts
  the fix merges made by then.
- **agents** of merge workflows (a workflow whose phases take work to the branch and build nothing,
  or one named in `pipeline.mergeWorkflows`): their runs take no lane; the merger (integrate, verify,
  merge phases) stands at the machine with `place: "merge"`, a fixer or reviewer on the dock. Job
  workflows' runs are the lanes, their phases the stations. Between merge runs no merger is live; while releases have work (an unfinished release, or jobs queued for one) the state keeps a
  merger at the machine: `id: "release-merger"`, `idle: true`, `place: "merge"`, its `say` what it
  waits for ("waiting for the fix", "waiting for jobs (7/10)"). `GET /api/agent?id=release-merger`
  returns the releases' timeline as its log.
- **slots**: the test pods. With a locks source they are its owners; otherwise they hold the agents
  that run tests or checks in the background. Holders are job ids, known queue slugs, or public words:
  `release 0.1.2` (a release check), `fixer 0.1.2`, `controller 0.1.2`, `merger`, `agent`.
- **events**, oldest first, each with a stable `id`: `started` and `finished` (agents), `done` and
  `stopped` (workflow runs and event-API lanes), `pushed` (an agent ran `git push`), `merged` (git
  merges into the configured branch, or the queue file), `queued` and `bounced` (the queue file). With
  release trains: `integrated` (a job joined a release, with `release`), `bounced` also for a job moved
  out of its release, `released` (a release merged into the branch), and one `merged` per job the
  release carried (git shows one merge per release).
- **sources**: each source is `ok`, `unavailable` (configured but unreadable) or `off`. **Missing
  sources are never filled in**: their values are empty or `null`.

## Replay

```text
{ mode: "replay", sample, public, from, to, hours, window, frameCount, stepMs,
  project, sources, notes, events: [...], frames: [state, ...] }
```

Each frame uses the state schema with `mode: "replay"`; its `events` are the events since the previous
frame, so playing the frames in order replays the timeline. Past frames are rebuilt from the journals,
run records and transcripts' tool-use history (lanes, stations and agents), the queue file and git
(the yard and counters). A short agent session between two frames still shows for one frame, and the
sessions of one run hand over in one frame, so a time-lapse never skips work or teleports anyone.
Event-API agents are live only. To play a time-lapse, map `frames` onto 15 to 60 seconds.

## Agent log

`GET /api/agent?id=<id>` answers for any agent in the state (live, a time-lapse frame, the sample with
`sample=1`, or the event API's `ev-…` ids) and for agents that left the stage recently. The id is looked
up among the agents the sources listed; no path or file name is ever taken from the request.

```text
{ id, role, tag, title, label, lane, stationTag, status, since, activeAt, say, action, public,
  entries: [...], omitted }
```

- **status**: `working` (on stage now), `finished`, `failed`, `stopped`, or `ended` (it went quiet).
- **Public mode**: `entries` are steps only, `{ t, kind, text, count, until }`: when an action started,
  its generic phrase, how many tool calls in a row it covered and when the last one was. Nothing from
  the transcript itself.
- **Private view** (`public=0`): the transcript as `{ t, type, ... }` entries, every text redacted
  (secrets, e-mail addresses, home folders) and cut to a length: `task` and `user` (messages to the
  agent), `say` (what it wrote), `tool` (`name`, `kind`, `text`: a short description, `detail`: its
  command, file, pattern or address, `background`), `result` (`text`, `error`, `chars` when cut),
  `notice` (a background command ended: `status`), `stop`, and `event` for event-API agents.
- **omitted**: how many earlier entries are left out (a number, or `"some"` when a very long transcript
  was read from near its end). At most 1500 entries are kept.
