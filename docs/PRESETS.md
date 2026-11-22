# Presets

A preset is a JSON file with config keys that describe a team's own way of working: its pipeline,
its label conventions, its runner's commands and files. A config names it with `"preset"` and adds
the machine's own paths:

```json
{
  "port": 8790,
  "preset": "my-team.preset.json",
  "sources": {
    "workflows": "~/.claude/projects/my-app/<session>/subagents/workflows",
    "repo": "~/code/my-app", "branch": "develop",
    "lanes": "~/code/my-app/.runner/lanes.json", "queue": "~/code/my-app/.runner/queue.json",
    "locks": "~/code/my-app/.runner/locks", "progress": "~/code/my-app/.runner/progress.json"
  }
}
```

The preset is merged under the config (objects merge, arrays and values replace). Keep presets and
configs with private paths or names out of version control; `local/`, `config.json`,
`agent-theater.config.json` and `*.local.json` are ignored in this repository.
[presets/example-runner.json](../presets/example-runner.json) is a complete example for a runner with
lanes `S00`…`S15`, jobs like `S03-TASK-02`, a merge queue and test booths.

## Workflows

Lanes follow the workflow runs by default, and each workflow's own phases decide what its runs do. A
workflow whose phases take finished work to the branch (integrate, verify, merge, release, ship,
deploy, publish, tag, fix) and build nothing works the merge machine: its runs take no lane, their
merger stands at the machine, and the machine shows what the current phase does. Every other workflow
gets a lane per run with its phases as stations. When the phases leave a workflow in doubt, name it:

| Key | Meaning |
| --- | --- |
| `pipeline.mergeWorkflows` | Workflow names (or `"/regex/"`) that work the merge machine. |
| `pipeline.jobWorkflows` | Workflow names (or `"/regex/"`) that get lanes, whatever their phases. |

With a progress file the controller counts the project's jobs (`JOBS`, `FEATURES`) instead of runs
and agents; with a repository or a merge queue the yard's vault is named after the configured branch.

## The jobs model

```json
{ "pipeline": { "lanes": "jobs",
                "stations": [{ "tag": "SETUP", "kind": "setup", "roles": ["setup"] }, …],
                "laneTitles": { "S03": "Planning" } },
  "counters": { "jobs": "JOBS", "features": "FEATURES", "batch": "BATCH" } }
```

With `"lanes": "jobs"` a lane is a job lane (from `rules.laneOfJob`, the progress file, or the lanes
file), and an agent stands at the station whose `roles` include its role; a merger stands at the merge
machine; everyone else on the dock. The controller counts jobs (the progress file) instead of runs.
Without the key, lanes are workflow runs.

## Rules

| Key | Meaning |
| --- | --- |
| `rules.labels` | Ordered label rules; the first match wins (below). |
| `rules.jobId` | A job id (an anchored regex, case-insensitive), used for branch slugs, lock holders and standalone descriptions. |
| `rules.slugPrefix` | Removed from branch names before they are matched (default `^agent/`). |
| `rules.laneOfJob` | `{ "match": "^(S\\d{2})-", "value": "$1" }`: the lane of a job id. |
| `rules.laneId` | What a lane id looks like (default: up to six letters, digits or dashes). |
| `rules.booth` | `{ "match": "\\bbooth\\.sh\\s+(run|exclusive)\\s+(\\S+)\\s*(.*)$", "exclusive": "exclusive" }`: a command that queues for a test pod. Groups: 1 the mode (`exclusive` holds every pod), 2 the owner, 3 the command it runs. |
| `rules.lock` | `{ "match": "\\bhold\\.sh\\s+acquire\\s+(\\S+)(?:\\s+(\\S+))?" }`: a command that waits for a lock. Groups: 1 the lock, 2 the owner. |
| `rules.locks` | Folder names in the locks source: `{ "merge", "exclusive", "slotPrefix", "release" }`. `release` is the prefix of release-train locks (`release-`, so `release-0.3.1`); `""` turns them off. |
| `rules.liveChecks` | Regexes of commands that are long live checks of the product (default: e2e, playwright, cypress). |
| `rules.measures` | Regexes of commands that measure test times. |
| `rules.standaloneTags` | `[["\\brunner\\b", "RUNNER"], ["\\bplan-(\\d+)\\b", "PLAN-$1"]]`: tags for standalone subagents' descriptions, before the built-in words. |
| `rules.relaunchByLabel` | `true`: an agent ends when a newer run starts the same label (for runners that relaunch stopped jobs). |
| `rules.queue.history` | How the merge queue's entry history reads (release trains): `[{ "match": "^integrated into release (VERSION)", "status": "integrated", "release": "$1" }, ...]`, matched against each line's text after its ISO time; the first match gives the entry's status from then on. `VERSION` in a match stands for a release version. The default reads "added at", "integrated into release X", "moved out", "requeued", "merged into <branch> with release X" and "dropped". |
| `rules.queue.status` | The runner's own entry status names mapped to the theater's: `{ "waiting": "queued", "boarded": "integrated", "landed": "merged" }` (`queued`, `integrated`, `merged`, `moved-out`, `dropped`). |
| `rules.queue.releaseStatus` | The same for releases: `{ "testing": "verifying", "shipped": "passed" }` (`open`, `verifying`, `fixing`, `passed`). |
| `rules.owners` | Who a lock holder is: `[{ "match": "^bot@train-(VERSION)$", "word": "release $1", "kind": "check", "version": "$1" }]`. `kind` is `merger`, `fixer`, `check` (a release's check) or `controller`; `word` is what public mode shows, so keep it free of private names. Without a match, a holder of the form `<role>-<version>` or `<role>-<run stamp>` (`merger-20261122014912`, `fixer-0.1.2`, `release-0.1.2`) is read by its role word. |

### Label rules

```json
{ "match": "^(S\\d{2}-TASK-\\d{2})(?:\\s+(.+))?$", "job": "$1", "suffix": "$2", "tag": "$1",
  "rolesByJob": [{ "match": "-GATE$", "role": "verifier" }] }
```

- `match`: a regex on the workflow label (`flags`, default `i`).
- `job`, `suffix`, `tag`: templates with the match's groups (`$1`, `$2`). The job is upper-cased
  (`"upper": false` keeps it); the tag becomes a public tag (capitals, digits, `.` and `-`, at most 16).
  `tagStrip` removes a regex from the tag first; `tagFallback` replaces an empty tag.
- The role: `role` fixes it; `roles` maps the suffix's first word to a role (`""` for no suffix, `"*"`
  for anything else); `rolesByJob` sets the role of a label without a suffix by its job. Without any of
  them the suffix's keyword decides: none is the coder, then `setup`, `review`, `fix`, `prepare` or
  `integrate`, `verify` or `gate` or `check`, `merge`; anything else is a helper.

After the preset's rules come the built-in ones: `verb:topic` labels (`fix:queue` is a fixer tagged
QUEUE, `verify:all` a verifier tagged VERIFY) and labels that start with a keyword.
