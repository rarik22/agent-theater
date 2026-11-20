import type { On, SessionMachine } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { exitReason, launchPlan, listenerPid, settingsOf } from '../hooks/launch'
import { laneFigure, statusLine, summarize } from '../hooks/summary'

// The new state shape: pipeline lanes, labels, lane/station on agents. Some fields are
// missing on purpose.
const STATE = {
  now: '2026-11-20T04:00:00.000Z',
  mode: 'live',
  sample: false,
  public: true,
  project: {
    name: 'Demo',
    done: 18,
    total: 40,
    labels: { jobs: 'RUNS', features: 'AGENTS' },
    features: { done: 3, total: 9 },
  },
  pipeline: {
    lanes: [
      {
        id: 'W1',
        tag: 'BUILD-SITE',
        title: 'Build the site',
        status: 'running',
        stations: [
          { tag: 'SETUP', kind: 'setup' },
          { tag: 'CODE', kind: 'coder' },
          { tag: 'REVIEW', kind: 'reviewer' },
        ],
        current: 1,
        done: 1,
      },
      { id: 'W2', tag: 'DOCS', status: 'completed', stations: [{ tag: 'SETUP' }, { tag: 'CODE' }], current: null, done: 1 },
    ],
  },
  agents: [
    {
      id: 'a1',
      role: 'coder',
      job: 'J-1',
      tag: 'BUILD-SITE',
      lane: 'W1',
      station: 1,
      stationTag: 'CODE',
      action: { kind: 'edit', text: 'editing files' },
    },
    { id: 'a2', role: 'reviewer', tag: null, job: 'J-2', lane: 'W1', station: 2, action: { kind: 'read', text: 'reading code' } },
    { id: 'a3', role: 'helper', standalone: true, action: {} },
    { id: 'a4' },
  ],
  sources: {},
}

// The state the current server sends: no pipeline, no labels, no lane fields.
const OLD_STATE = {
  mode: 'live',
  sample: true,
  project: { name: 'Demo (sample)', done: 12, total: 40, phases: [] },
  agents: [{ id: 's1', role: 'preparer', job: 'BUG-42', action: { kind: 'browser', text: 'testing in the browser' } }],
}

const LINUX: SessionMachine = {
  sysname: 'Linux',
  release: '6.8.0',
  machine: 'x86_64',
  packageManagers: ['npm'],
  runtimes: ['node'],
}

const WINDOWS: SessionMachine = { ...LINUX, sysname: 'Windows_NT', release: '10.0.22631' }

type World = {
  isUp: boolean
  state: unknown
  statuses: (string | undefined)[]
  spawned: string[][]
  killed: number
  ran: string[][]
  opened: string[]
}

/** Everything beneath the plugin: a theater server that answers while `isUp`. */
function world(
  on: On,
  options: { isUp?: boolean; state?: unknown; hasLocal?: boolean; machine?: SessionMachine; exit?: string } = {},
): World {
  const seen: World = {
    isUp: options.isUp ?? false,
    state: options.state ?? STATE,
    statuses: [],
    spawned: [],
    killed: 0,
    ran: [],
    opened: [],
  }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('command.register', () => ({ value: { command: 'theater' } }))
  on('ui.open', (_, e) => {
    seen.opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.status', (_, e) => {
    seen.statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('http.fetch', (_, e) => {
    if (!seen.isUp) throw new Error('connect ECONNREFUSED')
    const body = e.url.includes('/api/health') ? { ok: true, now: STATE.now, sources: {} } : seen.state

    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('fs.exists', () => ({ value: options.hasLocal ?? false }))
  on('fs.read', () => ({ value: JSON.stringify({ name: 'agent-theater', version: '0.1.0' }) }))
  on('session.machine', () => ({ value: options.machine ?? LINUX }))
  on('process.run', (_, e) => {
    seen.ran.push([...e.argv])

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* (_, e, next) {
    seen.spawned.push([...e.argv])
    if (options.exit !== undefined) {
      yield { stream: 'stderr' as const, text: options.exit }

      return { value: { code: 1, signal: null } }
    }
    seen.isUp = true
    try {
      yield { stream: 'stdout' as const, text: 'Agent Theater on http://127.0.0.1:8790\n' }
      await new Promise<void>(resolve => next.signal.addEventListener('abort', () => resolve()))
    } finally {
      seen.isUp = false
      seen.killed += 1
    }

    return { value: { code: null, signal: 'SIGTERM' } }
  })

  return seen
}

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const END = { reason: 'prompt_input_exit', sessionId: 's', resume: { id: 's' } } as const
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const PANE = {
  plugin: 'agent-theater',
  component: 'Pane',
  requestId: 'agent-theater',
  props: {
    title: 'Agent Theater',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('reuses a running theater, shows the status line, and never stops it', async ($, on) => {
  const seen = world(on, { isUp: true })
  const clock = mock.clock(on)

  await $.session.start(START)
  await clock.settle()

  expect(seen.statuses.at(-1)).toBe('Agent Theater · 4 agents working · 18/40 runs')
  expect(seen.spawned).toEqual([])

  await clock.advance(4000)
  await $.session.end(END)
  expect(seen.spawned).toEqual([])
  expect(seen.killed).toBe(0)
  expect(seen.ran).toEqual([])
})

test('starts the server with npx when none runs, and stops it when the session ends', async ($, on) => {
  const seen = world(on)
  const clock = mock.clock(on)

  await $.session.start(START)
  await clock.settle()

  expect(seen.spawned).toEqual([['npx', '-y', 'agent-theater@0.1.0', '--port', '8790']])
  expect(seen.statuses.at(-1)).toBe('Agent Theater · starting…')

  await clock.advance(1000)
  expect(seen.statuses.at(-1)).toBe('Agent Theater · 4 agents working · 18/40 runs')

  await $.session.end(END)
  expect(seen.killed).toBe(1)
  expect(seen.statuses.at(-1)).toBeUndefined()
})

test('prefers a server.mjs in the plugin folder', async ($, on) => {
  const seen = world(on, { hasLocal: true })
  const clock = mock.clock(on)

  await $.session.start(START)
  await clock.settle()

  const [argv] = seen.spawned
  expect(argv?.[0]).toBe('node')
  expect(argv?.[1]?.endsWith('/server.mjs')).toBe(true)
  expect(argv?.slice(2)).toEqual(['--port', '8790'])
  await $.session.end(END)
})

test('on Windows, npx runs through cmd.exe on the configured port', { options: { port: 8795 } }, async ($, on) => {
  const seen = world(on, { machine: WINDOWS })
  const clock = mock.clock(on)

  await $.session.start(START)
  await clock.settle()

  expect(seen.spawned).toEqual([['cmd.exe', '/d', '/s', '/c', 'npx', '-y', 'agent-theater@0.1.0', '--port', '8795']])
  await clock.advance(1000)
  await $.session.end(END)
  expect(seen.killed).toBe(1)
})

test('a server that cannot start says why', async ($, on) => {
  const seen = world(on, { exit: 'could not start: listen EADDRINUSE: address already in use 127.0.0.1:8790\n' })
  const clock = mock.clock(on)

  await $.session.start(START)
  await clock.settle()

  expect(seen.statuses.at(-1)).toBe('Agent Theater · port 8790 is in use · /theater retries')
})

test('with autostart off nothing starts until /theater', { options: { autostart: false } }, async ($, on) => {
  const seen = world(on)
  const clock = mock.clock(on)

  await $.session.start(START)
  await clock.settle()
  expect(seen.spawned).toEqual([])
  expect(seen.statuses.at(-1)).toBe('Agent Theater · off · /theater starts it')

  const ran = await $.command.run({
    command: 'theater',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(ran.text).toContain('[http://127.0.0.1:8790/](http://127.0.0.1:8790/)')
  expect(seen.spawned.length).toBe(1)
  expect(seen.opened).toEqual(['agent-theater'])

  await clock.advance(1000)
  const stop = await $.command.run({
    command: 'theater',
    args: 'stop',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(stop.text).toBe('Agent Theater: stopped the server this session started.')
  expect(seen.killed).toBe(1)
})

test('/theater stop leaves a server it did not start running', async ($, on) => {
  const seen = world(on, { isUp: true })
  const clock = mock.clock(on)

  await $.session.start(START)
  await clock.settle()
  const stop = await $.command.run({
    command: 'theater',
    args: 'stop',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(stop.text).toContain('did not start the server on port 8790')
  expect(seen.isUp).toBe(true)
  await $.session.end(END)
  expect(seen.isUp).toBe(true)
})

test('the pane lists lanes with bars and agents with their steps, on every surface', async ($, on) => {
  world(on, { isUp: true })
  const clock = mock.clock(on)
  await $.session.start(START)
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /4 agents working · 18\/40 runs/ }))?.text).toBeDefined()
    expect((await ui.find({ text: /W1 BUILD-SITE/ }))?.text).toContain('1/3 · CODE')
    expect((await ui.find({ text: /W2 DOCS/ }))?.text).toContain('2/2 · completed')
    expect((await ui.find({ type: 'Text', text: /coder/ }))?.text).toContain('BUILD-SITE · CODE — editing files')
    expect((await ui.find({ type: 'Text', text: /reviewer/ }))?.text).toContain('J-2 · REVIEW — reading code')
    expect(await ui.find({ type: 'Button', key: 'open' })).toBeDefined()
    if (surface === 'terminal') expect(await ui.find({ type: 'Link' })).toBeDefined()
    await ui.unmount()
  }
})

test('the pane draws the current server state, which has no lanes or labels', async ($, on) => {
  world(on, { isUp: true, state: OLD_STATE })
  const clock = mock.clock(on)
  await $.session.start(START)
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /1 agent working · 12\/40 · sample/ })).toBeDefined()
    expect((await ui.find({ text: /Demo \(sample\)/ }))?.text).toContain('12/40')
    expect((await ui.find({ type: 'Text', text: /preparer/ }))?.text).toContain('BUG-42 — testing in the browser')
    await ui.unmount()
  }
})

test('the pane offers a start while the server is down', async ($, on) => {
  world(on, { exit: 'boom' })
  const clock = mock.clock(on)
  await $.session.start(START)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Not running: the server exited \(code 1\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'start' })).toBeDefined()
  await ui.unmount()
})

test('the command row draws a Link on the terminal', async $ => {
  const ui = await $.ui.mount({
    plugin: 'agent-theater',
    surface: 'terminal',
    component: 'CommandOutput',
    props: {
      command: 'theater',
      args: '',
      text: 'Agent Theater live view:\n\n[http://127.0.0.1:8790/](http://127.0.0.1:8790/)',
      isErrored: false,
    },
  })
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe('http://127.0.0.1:8790/')
  await ui.unmount()
})

test('summaries never throw on missing or odd fields', () => {
  for (const raw of [null, undefined, 42, 'x', [], {}, { agents: 'no' }, { project: { done: 'a', total: null } }]) {
    const view = summarize(raw)
    expect(view.agents).toEqual([])
    expect(view.jobs).toBeNull()
  }
  const view = summarize(STATE)
  expect(view.agents.map(agent => agent.role)).toEqual(['coder', 'reviewer', 'helper', 'agent'])
  expect(view.agents[1]?.station).toBe('REVIEW')
  expect(view.features).toEqual({ done: 3, total: 9, label: 'agents' })
  expect(view.lanes.map(laneFigure)).toEqual(['1/3 · CODE', '2/2 · completed'])
})

test('status lines', () => {
  const base = {
    port: 8790,
    url: 'http://127.0.0.1:8790/',
    message: null,
    isOwned: false,
    mode: 'live',
    isSample: false,
    project: null,
    jobs: null,
    features: null,
    lanes: [],
    agents: [],
    moreAgents: 0,
  }
  expect(statusLine({ ...base, status: 'live' })).toBe('Agent Theater · no agents working')
  expect(statusLine({ ...base, status: 'live', mode: 'replay', jobs: { done: 1, total: 2, label: null } })).toBe(
    'Agent Theater · no agents working · 1/2 · replay',
  )
  expect(statusLine({ ...base, status: 'idle' })).toBeUndefined()
})

test('launch plans, exit reasons and the Windows listener', () => {
  const settings = settingsOf({ port: 9000, config: ' /tmp/c.json ' })
  expect(launchPlan({ settings, root: '/p', hasLocalServer: false, machine: LINUX, version: '1.2.3' })).toEqual({
    launch: 'npx',
    argv: ['npx', '-y', 'agent-theater@1.2.3', '--port', '9000', '--config', '/tmp/c.json'],
  })
  expect(launchPlan({ settings, root: '/p', hasLocalServer: false, machine: { ...LINUX, runtimes: ['bun'] }, version: null })).toEqual({
    error: 'Node.js 24 or newer is not on the PATH',
    isFinal: true,
  })
  expect(exitReason('', { code: 0, signal: null }, 'local', 8790).message).toContain('Node.js 24')
  expect(exitReason('Agent Theater on http://127.0.0.1:8790\n', { code: 0, signal: null }, 'local', 8790).message).toBe(
    'the server was stopped',
  )
  expect(exitReason('npm error 404 Not Found', { code: 1, signal: null }, 'npx', 8790).message).toBe(
    'agent-theater is not on npm yet',
  )
  const netstat = '  TCP    127.0.0.1:8790         0.0.0.0:0              LISTENING       4242\r\n  TCP    127.0.0.1:8791  0.0.0.0:0  LISTENING  7'
  expect(listenerPid(netstat, 8790)).toBe(4242)
  expect(listenerPid(netstat, 9999)).toBeNull()
  expect(settingsOf({ port: 70000 }).port).toBe(8790)
})
