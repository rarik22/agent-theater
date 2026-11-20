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
| `POST /api/events` | The event API ([EVENTS.md](EVENTS.md)) |

Query flags on every `GET` endpoint:

- `public=0` shows redacted tool descriptions instead of the generic phrases. Public mode is the
  default.
- `sample=1` serves the labelled sample simulation instead of live data; with it, `at=<unix seconds>`
  serves the sample at that moment (for repeatable screenshots).

## State

```text
{ now, mode: "live"|"replay", sample, public,
  project: { name, done, total, features: { done, total } | null, batch,
             labels: { jobs, features, batch } },
  pipeline: { model: "runs"|"jobs", stations: [{ tag, kind }],
              lanes: [{ id, tag, stations: [{ tag, kind }], current, done, status, show, active,
                        progress: { done, total } }] },
  agents: [{ id, role, job, lane, station, stationTag, tag, place?, standalone?, title, label,
             since, activeAt, action: { kind, text, background? } }],
  queue: { entries: [{ slug, id, lane, status, title, kind, bounces, readyAt }],
           batch: { n, slugs, startedAt, status } | null, lastBatch },
  slots: [{ n, holder, job, lane, since }], exclusive: { holder, job, lane, since } | null,
  lock: { holder, job, lane, since } | null,
  events: [{ id, at, type, job, lane?, slug?, role?, text }],
  yard: { labels: { test, merge, develop, remote } },
  sources: { claude, workflows, subagents, progress, lanes, queue, locks, git, events } }
```

- **project**: `done`/`total` is the controller's main counter: workflow runs completed of those
  started in the last `countHours` (runs model), a preset's job totals (jobs model), or the last
  `progress` event of the event API. `features` is the second counter (agents finished of started, or
  a preset's tracked features). `batch` is the third (runs running now, or the running merge batch).
  `labels` are the words the controller shows for them. `name` is `projectName` from the config, or
  null; the stage never draws it.
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
  `action.text` is a generic phrase in public mode. `background: true` means the agent waits on a
  background command that is doing what the phrase says.
- **slots**: the test pods. With a locks source they are its owners; otherwise they hold the agents
  that run tests or checks in the background.
- **events**, oldest first, each with a stable `id`: `started` and `finished` (agents), `done` and
  `stopped` (workflow runs and event-API lanes), `pushed` (an agent ran `git push`), `merged` (git
  merges into the configured branch, or the queue file), `queued` and `bounced` (the queue file).
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
