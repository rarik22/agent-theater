// Agent Theater for Claude Code: starts (or reuses) the local theater server, keeps a status
// line entry, adds /theater, and draws a compact pane of the agents and their lanes.
//
// The server: a server.mjs in the plugin's own folder when there is one, else
// `npx -y agent-theater@<this plugin's version>`. A server that already answers /api/health
// on the port is reused and never stopped; only a server this session started is stopped.

import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  HookStream,
  ProcessSpawnChunk,
  ProcessSpawnResult,
  Register,
  RenderSurface,
  Timer,
} from 'claude-code'

import type { TheaterAgent, TheaterView } from '../types'
import {
  browserOpener,
  DEFAULT_PORT,
  exitReason,
  type Launch,
  launchPlan,
  listenerPid,
  pinnable,
  type Settings,
  settingsOf,
} from './launch'
import { agentLine, laneFigure, liveLine, statusLine, summarize } from './summary'

type Engine = EngineInterface
type Child = HookStream<ProcessSpawnChunk, ProcessSpawnResult>
type Probe = { kind: 'down' } | { kind: 'json'; body: unknown } | { kind: 'other' }

const PANE = 'agent-theater'
const COMMAND = 'theater'
const POLL_MS = 4000
const FAST_POLL_MS = 1000
const FETCH_TIMEOUT_MS = 3000
// npx may download the package on its first run
const START_TIMEOUT_MS = 90_000
const AUTO_START_GAP_MS = 60_000
const MAX_AUTO_STARTS = 3

function blankView(port: number, url: string): TheaterView {
  return {
    status: 'idle',
    port,
    url,
    message: null,
    isOwned: false,
    mode: null,
    isSample: false,
    project: null,
    jobs: null,
    features: null,
    lanes: [],
    agents: [],
    moreAgents: 0,
  }
}

// Change the tag when TheaterView's fields change: a value an earlier version stored is
// then read as the blank view.
const viewAtom = atom(
  { plugin: 'agent-theater', key: 'view' } as const,
  blankView(DEFAULT_PORT, `http://127.0.0.1:${DEFAULT_PORT}/`),
  { shape: 'view-1' },
)

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function urlsOf(settings: Settings) {
  const base = `http://127.0.0.1:${settings.port}`

  return {
    view: `${base}/${settings.sample ? '?sample=1' : ''}`,
    // public=1 asks for the redacted state (also the server's default)
    state: `${base}/api/state?public=1${settings.sample ? '&sample=1' : ''}`,
    health: `${base}/api/health`,
  }
}

function freshRuntime(settings: Settings) {
  const urls = urlsOf(settings)

  return {
    cfg: settings,
    urls,
    view: blankView(settings.port, urls.view),
    lastJson: '',
    lastStatus: undefined as string | undefined,
    child: null as Child | null,
    launch: null as Launch | null,
    failure: null as string | null,
    isLaunching: false,
    isStarting: false,
    startedAt: 0,
    autoStarts: 0,
    lastAutoStart: Number.NEGATIVE_INFINITY,
    isUserStopped: false,
    isWindows: false,
    isInteractive: false,
    isClosing: false,
    isPolling: false,
    timer: null as Timer | null,
  }
}

// The module's own state: a reload starts it over, and the unload before a reload ends the
// child it held.
let rt = freshRuntime(settingsOf({}))

async function setView($: Engine, patch: Partial<TheaterView>): Promise<void> {
  const next: TheaterView = { ...rt.view, ...patch, port: rt.cfg.port, url: rt.urls.view }
  rt.view = next
  const json = JSON.stringify(next)
  if (json !== rt.lastJson) {
    rt.lastJson = json
    await update($, viewAtom, () => next)
  }
  const line = statusLine(next)
  if (line !== rt.lastStatus) {
    rt.lastStatus = line
    $.ui.status(line)
  }
}

async function fail($: Engine, message: string, isFinal: boolean): Promise<void> {
  rt.failure = message
  if (isFinal) rt.autoStarts = MAX_AUTO_STARTS
  await setView($, { status: 'error', message, isOwned: false })
}

function withTimeout<T>($: Engine, work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = $.clock.after(ms, () => reject(new Error('timed out')))
    work.then(
      value => {
        timer.cancel()
        resolve(value)
      },
      (error: unknown) => {
        timer.cancel()
        reject(error)
      },
    )
  })
}

async function probe($: Engine, url: string): Promise<Probe> {
  let response
  try {
    response = await withTimeout($, $.http.fetch(url), FETCH_TIMEOUT_MS)
  } catch {
    return { kind: 'down' }
  }
  if (!response.ok) return { kind: 'other' }
  try {
    return { kind: 'json', body: JSON.parse(response.text) as unknown }
  } catch {
    return { kind: 'other' }
  }
}

const isTheaterHealth = (got: Probe): boolean => got.kind === 'json' && isObject(got.body) && got.body.ok === true

function schedule($: Engine, ms: number): void {
  if (rt.isClosing || !rt.isInteractive) return
  rt.timer?.cancel()
  rt.timer = $.clock.after(ms, () => {
    rt.timer = null
    void tick($)
  })
}

async function tick($: Engine): Promise<void> {
  try {
    await poll($)
  } catch (error) {
    $.ui.log(`agent-theater: poll failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  }
  schedule($, rt.isStarting ? FAST_POLL_MS : POLL_MS)
}

async function poll($: Engine): Promise<void> {
  if (rt.isPolling || rt.isClosing) return
  rt.isPolling = true
  try {
    const got = await probe($, rt.urls.state)
    if (got.kind === 'json' && isObject(got.body)) {
      rt.isStarting = false
      rt.failure = null
      rt.autoStarts = 0
      await setView($, { ...summarize(got.body), status: 'live', message: null, isOwned: rt.child !== null })

      return
    }
    const now = await $.clock.now()
    if (rt.child !== null) {
      if (!rt.isStarting) {
        await setView($, { status: 'error', message: 'the server does not answer', isOwned: true })
      } else if (now - rt.startedAt > START_TIMEOUT_MS) {
        await stopServer($)
        await fail($, 'the server did not answer in time', false)
      } else {
        await setView($, { status: 'starting', message: null, isOwned: true })
      }

      return
    }
    if (got.kind === 'other') {
      const isTheater = isTheaterHealth(await probe($, rt.urls.health))
      await fail($, isTheater ? 'the server answered with an error' : `port ${rt.cfg.port} is used by another program`, false)

      return
    }
    const mayAutoStart =
      rt.cfg.autostart &&
      rt.isInteractive &&
      !rt.isUserStopped &&
      rt.autoStarts < MAX_AUTO_STARTS &&
      now - rt.lastAutoStart >= AUTO_START_GAP_MS
    if (mayAutoStart) {
      await startServer($, 'auto')

      return
    }
    await setView(
      $,
      rt.cfg.autostart && !rt.isUserStopped
        ? { status: 'error', message: rt.failure ?? 'not running', isOwned: false }
        : { status: 'offline', message: null, isOwned: false },
    )
  } finally {
    rt.isPolling = false
  }
}

async function pluginVersion($: Engine): Promise<string | null> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as unknown

    return pinnable(isObject(manifest) ? manifest.version : undefined)
  } catch {
    return null
  }
}

async function watchChild($: Engine, child: Child, launch: Launch): Promise<void> {
  let tail = ''
  let ended: ProcessSpawnResult | null = null
  let couldNotRun = false
  try {
    for (;;) {
      const step = await child.next()
      if (step.done === true) {
        ended = step.value
        break
      }
      tail = (tail + step.value.text).slice(-4000)
    }
  } catch {
    couldNotRun = true
  }
  // stopped on purpose, or replaced: nothing to report
  if (rt.child !== child) return
  rt.child = null
  rt.launch = null
  rt.isStarting = false
  $.ui.log(`agent-theater: the server ended (${ended?.code ?? ended?.signal ?? 'did not start'}): ${tail.slice(-1500)}`, {
    to: 'debug',
  })
  if (couldNotRun) {
    await fail($, `could not run ${launch === 'npx' ? 'npx' : 'node'} (is Node.js 24 or newer installed?)`, true)
  } else {
    const { message, isFinal } = exitReason(tail, ended, launch, rt.cfg.port)
    await fail($, message, isFinal)
  }
  // a theater that answers now (another session took the port first) is picked up here
  schedule($, FAST_POLL_MS)
}

async function startServer($: Engine, why: 'auto' | 'command'): Promise<'running' | 'reused' | 'started' | 'failed'> {
  if (rt.child !== null || rt.isLaunching) return 'running'
  rt.isLaunching = true
  try {
    const now = await $.clock.now()
    if (why === 'auto') {
      rt.autoStarts += 1
      rt.lastAutoStart = now
    }
    const health = await probe($, rt.urls.health)
    if (isTheaterHealth(health)) {
      // a server this session did not start: use it, never stop it
      schedule($, 0)

      return 'reused'
    }
    if (health.kind !== 'down') {
      await fail($, `port ${rt.cfg.port} is used by another program`, false)

      return 'failed'
    }
    const root = $.plugin.root
    const machine = await $.session.machine().catch(() => null)
    rt.isWindows = machine?.sysname === 'Windows_NT'
    const plan = launchPlan({
      settings: rt.cfg,
      root,
      hasLocalServer: await $.fs.exists(`${root}/server.mjs`).catch(() => false),
      machine,
      version: await pluginVersion($),
    })
    if ('error' in plan) {
      await fail($, plan.error, plan.isFinal)

      return 'failed'
    }
    const child = $.process.spawn({ argv: plan.argv, cwd: root })
    rt.child = child
    rt.launch = plan.launch
    rt.isStarting = true
    rt.startedAt = now
    void watchChild($, child, plan.launch)
    await setView($, { status: 'starting', message: null, isOwned: true })
    schedule($, FAST_POLL_MS)

    return 'started'
  } finally {
    rt.isLaunching = false
  }
}

// npx runs the server as a grandchild, which Windows does not end with its parent
async function sweepWindows($: Engine): Promise<void> {
  if ((await probe($, rt.urls.health)).kind === 'down') return
  const listed = await $.process.run(['netstat', '-ano', '-p', 'TCP'], { timeoutMs: 10_000 }).catch(() => null)
  const pid = listed === null ? null : listenerPid(listed.stdout, rt.cfg.port)
  if (pid !== null) {
    await $.process.run(['taskkill', '/PID', String(pid), '/T', '/F'], { timeoutMs: 10_000 }).catch(() => null)
  }
}

async function stopServer($: Engine): Promise<'stopped' | 'none'> {
  const child = rt.child
  if (child === null) return 'none'
  const launch = rt.launch
  rt.child = null
  rt.launch = null
  rt.isStarting = false
  try {
    // ending the stream ends the child
    await child.return({ code: null, signal: 'SIGTERM' })
  } catch {
    // already gone
  }
  if (launch === 'npx' && rt.isWindows) await sweepWindows($)

  return 'stopped'
}

async function openBrowser($: Engine, surface: RenderSurface): Promise<void> {
  const url = rt.urls.view
  const machine = await $.session.machine().catch(() => null)
  const argv = machine === null ? null : browserOpener(machine, url)
  if (argv !== null) {
    const ran = await $.process.run(argv, { timeoutMs: 15_000 }).catch(() => null)
    if (ran !== null && ran.exitCode === 0) return
  }
  const copied = await $.ui.copy({ text: url, surface }).catch(() => null)
  $.ui.toast(copied?.isCopied === true ? `Copied ${url}: paste it in your browser` : `Open ${url} in your browser`)
}

/** Start on the person's word: autostart limits and an earlier stop no longer hold. */
async function startFromPerson($: Engine): Promise<string> {
  rt.isUserStopped = false
  rt.autoStarts = 0
  if (rt.view.status === 'live') return ''
  const started = await startServer($, 'command')
  if (started === 'started') return ' (starting the server)'
  if (started === 'failed') return ` (not running: ${rt.view.message ?? 'it could not start'})`

  return ''
}

async function stopFromPerson($: Engine): Promise<string> {
  if ((await stopServer($)) === 'stopped') {
    rt.isUserStopped = true
    await setView($, { status: 'offline', message: null, isOwned: false })
    schedule($, POLL_MS)

    return 'Agent Theater: stopped the server this session started.'
  }
  if (isTheaterHealth(await probe($, rt.urls.health))) {
    return `Agent Theater: this session did not start the server on port ${rt.cfg.port}, so it keeps running.`
  }

  return `Agent Theater: no server is running on port ${rt.cfg.port}.`
}

export const register: Register = (on, options) => {
  rt = freshRuntime(settingsOf(options))

  on('session.start', async ($, e, next) => {
    rt.isInteractive = e.isInteractive
    rt.isClosing = false
    await $.command.register({
      name: 'theater',
      description: 'Agent Theater: open the live stage of your agents (pane and browser link); "stop" stops its server',
      argumentHint: '[stop]',
    })
    await setView($, blankView(rt.cfg.port, rt.urls.view))
    // the first poll reuses a running server, or starts one when autostart is on
    schedule($, 0)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // a /clear or a /resume keeps the process, and with it the server; an exit unloads the
    // module, which ends the child even if this hook ran out of time
    if (e.reason !== 'clear' && e.reason !== 'resume') {
      rt.isClosing = true
      rt.timer?.cancel()
      rt.timer = null
      await stopServer($).catch(() => 'none')
      $.ui.status(undefined)
    }

    return next(e)
  })

  on('command.run', { command: 'theater' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'stop') return { text: await stopFromPerson($), isTextDisplayOnly: true }
    if (arg !== '' && arg !== 'open') {
      return {
        text: 'Usage: `/theater` opens the pane and the live view link, starting the server if needed; `/theater stop` stops the server this session started.',
        isTextDisplayOnly: true,
      }
    }
    const note = await startFromPerson($)
    await $.ui.open({ id: PANE, title: 'Agent Theater' }).catch(() => null)

    return { text: `Agent Theater live view${note}:\n\n[${rt.urls.view}](${rt.urls.view})`, isTextDisplayOnly: true }
  }).catch(() => ({ text: 'Agent Theater: the command failed (the debug log has the reason).', isTextDisplayOnly: true }))

  // The command's row: a Link on the terminal; the other surfaces draw the markdown link.
  on('ui.render', { component: 'CommandOutput', props: { command: COMMAND } }, ($, e, next) => {
    const url = rt.urls.view
    if (e.surface !== 'terminal' || e.props.isErrored || !e.props.text.includes(`(${url})`)) return next(e)
    const { Box, Text, Link } = $.ui.resolve(e)
    const [first = 'Agent Theater live view:'] = e.props.text.split('\n')

    return (
      <Box flexDirection="column">
        <Text>{first}</Text>
        <Link href={url} label={url} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const view = await read($, viewAtom)
    const { Box, Text, Link, Button, Progress } = $.ui.resolve(e)
    const isLive = view.status === 'live'
    const headline = {
      idle: 'Looking for the theater server…',
      starting: 'Starting the theater server…',
      live: liveLine(view),
      offline: 'The theater server is off.',
      error: `Not running: ${view.message ?? 'the server stopped'}`,
    }[view.status]
    const jobsBar =
      view.jobs !== null && view.jobs.total > 0 ? (
        <Progress
          label={view.project ?? 'Project'}
          value={view.jobs.done}
          max={view.jobs.total}
          valueText={`${view.jobs.done}/${view.jobs.total}${view.jobs.label !== null ? ` ${view.jobs.label}` : ''}`}
        />
      ) : null

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          <Text weight="semibold" wrap="truncate-end">
            {headline}
          </Text>
          {isLive && jobsBar}
        </Box>
      )
    }

    const row = (agent: TheaterAgent) => {
      const { head, tail } = agentLine(agent)

      return (
        <Text wrap="truncate-end">
          <Text weight="semibold">{agent.role}</Text>
          {head !== '' ? ` ${head}` : ''}
          {tail !== '' && <Text dimColor>{` — ${tail}`}</Text>}
        </Text>
      )
    }
    const laneIds = new Set(view.lanes.map(lane => lane.id))
    const loose = view.agents.filter(agent => agent.lane === null || !laneIds.has(agent.lane))
    const featuresBar =
      view.features !== null && view.features.total > 0 ? (
        <Progress
          label={view.features.label ?? 'Features'}
          value={view.features.done}
          max={view.features.total}
          valueText={`${view.features.done}/${view.features.total}`}
        />
      ) : null

    return (
      <Box flexDirection="column">
        <Text weight="semibold" wrap="truncate-end">
          {headline}
        </Text>
        {e.surface === 'terminal' ? (
          <Link href={view.url} label={view.url} />
        ) : (
          <Text dimColor wrap="truncate-end">
            {view.url}
          </Text>
        )}
        <Box flexDirection="row" gap={1}>
          <Button key="open" label="Open in browser" onPress={press => openBrowser($, press.surface)} />
          {!isLive && view.status !== 'starting' && (
            <Button key="start" label="Start" onPress={() => startFromPerson($)} />
          )}
        </Box>
        {isLive && view.lanes.length === 0 && jobsBar !== null && <Box marginTop={1}>{jobsBar}</Box>}
        {isLive && view.lanes.length === 0 && featuresBar}
        {isLive &&
          view.lanes.map(lane => (
            <Box key={`lane-${lane.id}`} flexDirection="column" marginTop={1}>
              <Progress
                label={[lane.id, lane.tag].filter(part => part !== null).join(' ')}
                value={lane.total > 0 ? lane.done : undefined}
                max={lane.total > 0 ? lane.total : undefined}
                valueText={laneFigure(lane)}
              />
              {view.agents.filter(agent => agent.lane === lane.id).map(row)}
            </Box>
          ))}
        {isLive && loose.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {view.lanes.length > 0 && <Text dimColor>Other agents</Text>}
            {loose.map(row)}
          </Box>
        )}
        {isLive && view.agents.length === 0 && (
          <Box marginTop={1}>
            <Text dimColor>No agents are working right now.</Text>
          </Box>
        )}
        {isLive && view.moreAgents > 0 && <Text dimColor>{`and ${view.moreAgents} more in the browser view`}</Text>}
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {view.isOwned
              ? 'Started by this session · /theater stop stops it'
              : isLive
                ? 'Using a theater server that was already running'
                : 'The full animated stage runs in the browser'}
          </Text>
        </Box>
      </Box>
    )
  })
}
