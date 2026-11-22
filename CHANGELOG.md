# Changelog

## 0.2.0 (2026-11-22)

Release trains: the merge machine follows a runner that merges in releases instead of batches,
and still plays the batch history before it.

- The queue file's schema 2 is read: entries `queued`, `integrated` (in a release, waiting for its
  check), `merged` (with their release), `moved-out` and `dropped`; releases with their entries, check
  runs, failures, open failure and fix rounds; the old batches as `legacyBatches`. A read that catches
  the file half-written keeps the last good copy for up to two minutes.
- The `release-<version>` locks are read, and every lock owner by name.
- `queue.releases` and `queue.release` in the state: version, status, counted out of capacity, the open
  failure, fix rounds, the latest check, and what the runner does now (`merging`, `checking`,
  `integrating`, `fixing`, else the status). Reasons only in the private view, redacted.
- The machine works on the oldest unfinished release: its integrated jobs in the window (the latest
  four), its counter at counted/capacity, a plate "REL 0.1.1 CHECKING" under it with the open failure,
  fix rounds and the next release in small letters. It works while a release is integrated, checked or
  merged, and holds a steady red lamp while one is fixed. Jobs already integrated into the next release
  ride lowest on the queue column with a green seal; then the queued ones.
- Between the runner's merger runs, the merger stays at the machine while releases have work, saying
  what it waits for; a click opens the releases' timeline as its log.
- Git's one merge per release counts every job the release carried as merged (job counters, `merged`
  events, the parcels), with a `released` event; `integrated` events, and `bounced` for a job moved out
  of its release.
- The controller shows the machine's release (`project.release`) in place of a batch number.
- Test booths held by a release check, a fixer or the controller read REL, FIX and CTRL.
- Replay plays both histories: merge batches, and releases as they stood at each frame (entries from
  their history lines).

## 0.1.1 (2026-11-21)

- The plugin now runs in VS Code's chat panel and the desktop app. Both start Claude Code as an SDK
  session that reports no person at the prompt, so the plugin stayed idle there: no server, an empty
  pane. It now wakes up when an app attaches to the session, or when someone types `/theater`. A plain
  `claude -p` run still stays idle.
- The README says how to install from a terminal, VS Code and the desktop app (where `/plugin` is not
  available), and how to watch the stage in a VS Code tab with Simple Browser.

## 0.1.0 (2026-11-20)

The first public release.

- The live stage: a 960x540 pixel-art scene drawn in code at x2, with a controller, a dock of side
  agents, lane rows of stations, a queue column, a merge machine, test pods, a vault and a remote.
  Every role is a hand-drawn character with a walk cycle and work animations. Layouts for 16:9, 1:1,
  4:5 and 9:16, phone builds with big labels, crisp device-pixel scaling.
- Lanes from Claude Code workflows: one lane per workflow run, its stations the workflow's own phases,
  agents at the station of their phase, walking from station to station as the run moves on.
  Sessions are discovered under `projects/` in Claude Code's folder (`$CLAUDE_CONFIG_DIR`, else
  `~/.claude`).
- Live accuracy: agents end with their result, their run's record, a stop, or 5 minutes of quiet with
  nothing in flight; an agent waiting on a background command shows what that command does.
- Standalone subagents on the dock with a short tag.
- Speech bubbles: every agent says, in one short line, what it is doing right now, lettered in with a
  tiny pixel font; generic phrases in public mode, the agent's own words (redacted) in the private
  view. White while working, dotted grey while thinking, amber while waiting, cyan for background work.
- Click or tap an agent to open its log on the stage (`GET /api/agent`): steps only in public mode, the
  redacted transcript (task, messages, tool calls, results) in the private view. Keyboard users reach
  every agent through a list that appears on focus.
- Counters of runs and agents; done, stopped and pushed events; test pods from background tests.
- An event API (`POST /api/events` or a JSON Lines file) for other agent tools.
- Presets for a team's own pipeline: job lanes, fixed stations, label rules, test-booth and lock
  commands, a merge queue, lock owners, a progress file and git merges.
- Time-lapses of any past window (`/api/replay`) and a video exporter (`tools/render-video.mjs`) with
  title and end cards and multi-window cuts.
- Public mode by default: generic phrases only, no commands, paths, names or secrets.
- The README's pictures are drawn by the app itself: `tools/readme-media.mjs` films the sample in Node,
  and `tools/gif.mjs` writes the stage's palette indices straight into lossless GIFs.
- A Claude Code plugin that carries the whole app (the repository root is the plugin and its
  marketplace): it starts the server, adds `/theater`, a status-line entry and a pane of lanes and
  agents, and needs nothing from npm.
