# Agent Theater plugin

Works with Claude Code. The plugin brings Agent Theater into your coding session: it starts the
theater server (or uses one that is already running), keeps a line on the status bar, adds the
`/theater` command, and opens a compact pane beside the chat with your agents and their lanes. The
full animated pixel-art stage stays in the browser.

## Install

At the prompt of a terminal session:

```
/plugin install agent-theater --marketplace tarqmamdouh/agent-theater
```

Answer `y` to add the marketplace, then pick a scope (user is first; press Enter). A screen for the
plugin's options follows; the defaults work.

From a shell:

```sh
claude plugin install agent-theater --marketplace tarqmamdouh/agent-theater
```

`/plugin` opens a menu only a terminal can draw, so in VS Code, the desktop app and the web it answers
"/plugin isn't available in this environment". There:

- **VS Code:** run the shell line above in the editor's terminal, then start a new chat.
- **The desktop app:** click + next to the prompt box, then Plugins, Add marketplace with
  `tarqmamdouh/agent-theater`, then Add plugin.

In VS Code, **Simple Browser: Show** (command palette) with `http://127.0.0.1:8790` shows the full
stage in an editor tab.

## When it runs

The plugin polls the server, and starts one when autostart is on, only while someone is watching:

- a terminal session (Claude Code's REPL);
- a session an app attached to: VS Code's chat panel and the desktop app run Claude Code as an SDK
  session and attach a moment after it starts, and the plugin wakes up then;
- any session where a person typed `/theater`.

A plain `claude -p` run, or an SDK script with nothing attached, stays idle: no polls and no server.

Needs Node.js 24 or newer on the PATH. The repository root is the plugin, so an install carries the
whole app (about 6 MB, most of it the README's pictures) and nothing comes from npm.

## What it adds

- **Status line**: `Agent Theater · 4 agents working · 18/40 runs`. The count is every agent the
  server lists; `done/total` is the project's count, with the server's label for what it counts. It
  says `starting…` while the server starts, and why when it is not running.
- **`/theater`**: starts the server if none answers, opens the pane, and prints a link to the live
  view (`http://127.0.0.1:8790/`). `/theater stop` stops the server, but only one this session
  started.
- **Pane**: one progress bar per pipeline lane (stations passed out of the lane's stations, with the
  current station), the agents of each lane beneath it (role, what it works on, its station, what it
  is doing), then the agents outside any lane. Without lanes it shows the project's progress. An
  **Open in browser** button opens the full stage; where no browser can be opened, it copies the link.

The pane is text and bars on every surface. The VS Code surface has no `Client`, `Raster` or `Image`,
so the animated scene cannot run in a VS Code pane; the browser view is the place for it. On the
terminal the link is a real link; on the desktop app and VS Code the URL is shown as text next to the
button.

## How it finds and runs the server

1. **A server already running.** If `GET http://127.0.0.1:<port>/api/health` answers `{ "ok": true }`,
   the plugin uses that server and never stops it.
2. **The app it carries.** The marketplace lists the plugin with `"source": "./"`, so an install
   copies the whole repository into Claude Code's plugin cache
   (`<Claude Code's folder>/plugins/cache/agent-theater/agent-theater/<version>/`), `server.mjs`
   included. The plugin runs `node <plugin folder>/server.mjs --port <port>`.
3. **npm, as a fallback.** Only for a copy of the plugin without the app: `npx -y
   agent-theater@<version> --port <port>`, `<version>` being the plugin's own version from
   `plugin.json` (through `cmd.exe` on Windows, where `npx` is a script).

The server the plugin starts inherits Claude Code's environment, so it reads the same folder Claude
Code keeps its sessions in (`$CLAUDE_CONFIG_DIR` when it is set, else `~/.claude`).

The server only listens on 127.0.0.1. A server the plugin started is stopped when the session ends
(not on `/clear`), with `/theater stop`, or when the plugin reloads. When another Claude Code
session is already running a theater on the port, this session uses it; if that one goes away,
this session starts its own (with autostart on).

## Options

Set them on the install screen, in `/config`, or under `pluginConfigs` in `settings.json`.

| Option | Default | Meaning |
| --- | --- | --- |
| `port` | 8790 | Port of the server on 127.0.0.1, used to find one and to start one (`--port`). |
| `autostart` | on | Start the server when a session starts and none answers. Off: only `/theater` starts it. |
| `sample` | off | Show the labelled sample simulation (`?sample=1`) instead of live data. |
| `config` | none | A config file passed to a server the plugin starts, as `--config`. |

## Data and privacy

The plugin reads `GET /api/state?public=1` every 4 seconds from the server on 127.0.0.1 (every second
while the server starts). In public mode the server already strips commands, paths and names; the
plugin shows only the fields it receives (role, the job's tag or id, the station, the action's text,
lane progress) and adds nothing of its own: no working directory, no user names. The plugin itself
talks to 127.0.0.1 only.

## Develop

From the repository root, which is the plugin's folder:

```sh
claude plugin validate --strict .      # marketplace, manifest and hooks module
claude plugin test .                   # test/plugin/*.test.tsx against the engine's test kit
claude --plugin-dir .                  # a session with the plugin loaded from this folder
```

The hooks module is `hooks/register.tsx` (with `hooks/launch.ts` and `hooks/summary.ts`), its state
contract `types/index.d.ts`, the manifest `.claude-plugin/plugin.json`. Keep `version` there equal to
the version in `package.json`. The npm command lives in `cli/`, not `bin/`: a plugin's `bin/` folder
joins the PATH of every Claude Code session.

## License

PolyForm Internal Use License 1.0.0. See [LICENSE.md](../LICENSE.md).
