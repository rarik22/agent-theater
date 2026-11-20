# Event API

Any agent tool can put its agents on the stage with small JSON events, posted to the server or
appended to a JSON Lines file. Event lanes and agents join the stage next to the Claude Code ones.

```sh
curl -s http://127.0.0.1:8790/api/events -H 'content-type: application/json' -d '[
  { "lane": "checkout", "stations": ["Plan", "Build", "Test"], "tag": "checkout" },
  { "agent": "bot-1", "lane": "checkout", "station": "Build", "action": "edit" }
]'
```

- `POST /api/events` accepts one event, a JSON array of events (at most 500), or JSON Lines
  (`content-type: application/x-ndjson`). Only JSON content types are accepted, a request from a page of
  another origin is refused, and a body is at most 256 kB. The answer is
  `{ "accepted": n, "refused": [{ "index", "error" }] }`.
- Or name a file in the config, `"sources": { "events": "~/agents/events.jsonl" }`: the server reads the
  lines appended to it on every update.
- Events live in memory. Restarting the server forgets them; time-lapses do not replay them.

## Events

| Event | Effect |
| --- | --- |
| `{ "lane": "checkout", "stations": ["Plan", "Build", "Test"] }` | A lane and its stations (1 to 6). `tag` sets its public name (default: the lane key). |
| `{ "agent": "bot-1", "lane": "checkout", "station": "Build", "action": "edit" }` | An agent at work. `station` is a station name (added to the lane when new) or an index. |
| `{ "agent": "bot-1", "role": "verifier" }` | Its character: `setup`, `coder`, `reviewer`, `fixer`, `preparer`, `merger`, `verifier` or `helper` (default: from the station's name). |
| `{ "agent": "bot-1", "text": "editing cart.ts" }` | What it says it is doing: its speech bubble and its log in the private view (`?public=0`), redacted. Public mode shows the action's phrase instead. |
| `{ "agent": "bot-1", "status": "done" }` | It finished (`done`) or stopped (`stopped`, `failed`) and leaves the stage. |
| `{ "lane": "checkout", "status": "done" }` | The lane's work is done (`done`) or stopped; it stays two minutes, then leaves. |
| `{ "progress": { "done": 3, "total": 10 } }` | The controller's main counter. |

- `action` is one of `edit`, `read`, `search`, `run`, `test`, `browser`, `docker`, `think`, `wait`.
  An agent that sends no action for `thinkAfterSeconds` (120) is shown thinking.
- An agent that sends nothing for `quietMinutes` (5) has ended. Send any event for it (its action
  again) to keep it on stage during long work.
- `time` (ISO or milliseconds) dates an event; the default is now.
- Keys (`lane`, `agent`) are short names: letters, digits, `. _ : -`, up to 64 characters. The stage
  shows only lane tags, station names and phrases for actions, never your keys or texts in public mode.
