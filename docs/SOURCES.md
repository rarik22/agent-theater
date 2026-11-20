# Data sources

The theater only reads. Every reader tolerates a missing file, unknown fields and lines it cannot
parse: what it cannot read it leaves out, and `/api/health` reports the source as `unavailable`.

## Claude Code

Claude Code keeps each session under `~/.claude/projects/<project>/`. The adapter reads these shapes
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

### `sources.locks`

A folder with one subfolder per lock, each holding an `owner` file of the form `holder unixSeconds`:
`<rules.locks.merge>/owner` (the merge lock, shown on the vault), `<rules.locks.exclusive>/owner` (a hold
on every test pod) and `<rules.locks.slotPrefix>1/owner` … `<slotPrefix><slotCount>/owner` (one per test
pod).

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
