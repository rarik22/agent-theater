# Data sources

The theater only reads. Every reader tolerates a missing file, unknown fields and lines it cannot
parse: what it cannot read it leaves out, and `/api/health` reports the source as `unavailable`.

## Claude Code

Claude Code keeps each session under `projects/<project>/` in its folder: `$CLAUDE_CONFIG_DIR` when
that is set, else `~/.claude` (`sources.claude` names another). The adapter reads these shapes
(as of Claude Code 2.1; fields not listed are ignored, so additions do not break it):

| Path (under the session folder `<project>/<session>/`) | Used for |
| --- | --- |
| `../<session>.jsonl` | The session transcript. Only the `Workflow` tool's uses (`input.script`, `input.args`, `input.name`) and their results (`Run ID: wf_…`, `Script file: …`) are read, to find a running run's script. The first read starts at most 64 MB from the end; later reads take only new lines. |
| `subagents/workflows/wf_<run>/journal.jsonl` | One JSON object per line: `{"type":"started","agentId","label","phase"}`, `{"type":"result","agentId"}`, `{"type":"failed","agentId"}`. |
| `subagents/workflows/wf_<run>/agent-<id>.jsonl` | An agent's transcript: lines with `timestamp`; assistant lines' `tool_use` blocks (`id`, `name`, `input`); `tool_use_id` on results; task notifications (`<tool-use-id>…</tool-use-id>`) that end background commands; the `[Request interrupted by user]` marker. |
| `workflows/wf_<run>.json` | A finished run's record: `workflowName`, `phases[].title`, `status` (`completed`, `killed`, `failed`), `startTime`, `durationMs`, `args`. |
| `workflows/scripts/<name>-wf_<run>.js` | A persisted inline script; its `export const meta = { name, phases: [{ title }] }`. |
| `subagents/agent-<id>.jsonl` and `agent-<id>.meta.json` | Standalone subagents; the meta's `description` (private), `agentType`, and `finished`. |

How a run's phases are found, first match wins: the run record; the script named by its launch (an
inline `script`, or the `Script file:` path in the launch result); a persisted inline script; else the
phases its agents were started in, in order.

What a run is about (its lane's tag): a token-like `id`, `slug`, `job`, `name`, `task`, `ticket` or
`target` in its args (letters, digits, `. _ -`, up to 32 characters), else its workflow name. Free-text
args are never used.

Sessions are discovered when their transcript or subagent folders changed within the last
`max(countHours, eventsHours)` hours (24 by default); `sources.projects` narrows them by folder name.

## Runner files (optional)

A preset can add a runner's own files. Each is optional; give its path in `sources`.

### `sources.lanes`

```json
{ "lanes": { "S03": { "job": "s03-task-02" } }, "waiting": { "S06": {} } }
```

Lane ids must match `rules.laneId`. A lane with a job is active; a waiting lane is drawn amber in the
controller.

### `sources.queue`

```json
{ "entries": [{ "slug": "s05-task-02", "id": "S05-TASK-02", "lane": "S05", "status": "ready",
                "title": "…", "kind": "core", "readyAt": "ISO", "mergedAt": "ISO", "updatedAt": "ISO",
                "bounces": [{ "at": "ISO", "batch": 2, "reason": "…" }] }],
  "batches": [{ "n": 3, "slugs": ["s12-task-01"], "status": "running", "startedAt": "ISO", "finishedAt": "ISO" }] }
```

`status` is `ready`, `batched`, `merged`, `bounced`, `held` or `dropped` (`phase` is read as `lane`
too). Ready entries ride the queue column; a running batch's entries sit in the merge machine.
Bounce reasons appear only in the private view.

**Release trains (schema 2).** A runner that merges in releases instead of batches writes:

```json
{ "schema": 2,
  "entries": [{ "slug": "s05-task-02", "id": "S05-TASK-02", "phase": "S05", "kind": "core",
                "status": "integrated", "release": "0.3.1", "integratedAt": "ISO", "readyAt": "ISO",
                "mergedAt": "ISO", "history": ["ISO added at <sha>", "ISO integrated into release 0.3.1 at <sha>"] }],
  "releases": [{ "version": "0.3.1", "status": "fixing", "capacity": 10, "gate": false,
                 "openedAt": "ISO", "closedAt": "ISO", "passedAt": "ISO", "tag": "v0.3.1",
                 "entries": [{ "type": "entry"|"release-fix", "slug": "…", "id": "…", "counted": true, "at": "ISO" }],
                 "runs": [{ "n": 1, "result": "running"|"passed"|"failed"|"flake"|"interrupted",
                            "startedAt": "ISO", "finishedAt": "ISO", "reason": "…" }],
                 "failures": [{ "stage": "integrate"|"check", "at": "ISO", "entries": ["…"], "reason": "…" }],
                 "openFailure": { "stage": "…", "at": "ISO", "entries": ["…"], "reason": "…" } | null,
                 "fixRounds": { "<slug>": 2 }, "movedOut": [{ "slug": "…" }] }],
  "legacyBatches": [ /* the merge batches, as `batches` above */ ] }
```

An entry is `queued`, `integrated` (in a release branch that has not passed), `merged` (its release
reached the branch), `moved-out` or `dropped`. Its `history` lines (`added at`, `integrated into
release <v>`, `moved out`, `requeued`, `merged into <branch> with release <v>`, `dropped`) let replay
rebuild its status at any time; entries without history (merged by a merge batch) are replayed from
`legacyBatches`. Releases run in version order and the merge machine works on the oldest unfinished
one: its integrated entries sit in the machine, entries already integrated into the next release ride
lowest on the queue column, then the queued ones. Git shows one merge per release (`Merge branch
'release/<v>' into <branch>`); the theater counts each job the release carried as merged then. Reasons
appear only in the private view, redacted. A read that catches the file half-written keeps the last
good copy for up to two minutes. The status names and history wording above are defaults: a preset maps another
runner's (`rules.queue`), and reads its lock holders (`rules.owners`); see [PRESETS.md](PRESETS.md).
The queue only adds detail: what the machine does comes first from the merge workflow's live run.

### `sources.locks`

A folder with one subfolder per lock, each holding an `owner` file of the form `holder unixSeconds`:
`<rules.locks.merge>/owner` (the merge lock, shown on the vault), `<rules.locks.exclusive>/owner` (a hold
on every test pod) and `<rules.locks.slotPrefix>1/owner` … `<slotPrefix><slotCount>/owner` (one per test
pod). With release trains, `<rules.locks.release><version>/owner` (default `release-0.3.1`) is held by
the merger while it integrates into that release, or by its fixer; the merge lock is the target
branch's (set `rules.locks.merge` to `develop` when the runner names it so); a release check holds the
exclusive hold and every pod as `release-<version>`. The theater reads these to tell what the runner
does with each release (see `queue.releases` in [API.md](API.md)).

### `sources.progress`

```json
{ "base": "abc1234", "totals": { "jobs": 12, "done": 5, "features": 1 },
  "lanes": { "S03": "Planning" },
  "jobs": [{ "id": "S03-TASK-02", "lane": "S03", "kind": "core", "title": "…", "status": "done" }] }
```

The controller's `JOBS done/total` and `FEATURES done/total` (jobs of `kind: "feature"`). Jobs merged
into `sources.branch` after the `base` commit are counted as done from git. `phases` and `develop` are
read as `lanes` and `base` too.

### `sources.repo`

`git log <branch> --first-parent --merges` with subjects `Merge branch '<slug>' into <branch>`. Each
merge lights the merge machine and flows into the vault.
