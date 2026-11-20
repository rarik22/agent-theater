// SAMPLE data (only with ?sample=1): a deterministic, clearly labelled simulation used for development
// and screenshots when nothing is running. It never mixes with live data.
//
// Six lanes each run one workflow over and over. A workflow is a list of phases (the lane's stations);
// each run sends one agent per phase, so the next agent takes over where the last one stood and walks to
// its station. Feature runs end in the merge queue (a batch merges them or bounces one back); the other
// runs finish ("done") or, now and then, are stopped. Background tests hold the four test pods. Two side
// agents (a verifier and a helper) come and go on the dock, the merger works the merge machine while a
// batch runs, and work is pushed to the remote every few minutes.

const WORKFLOWS = {
  feature: {
    gap: 40,
    stations: [
      { tag: 'PLAN', kind: 'setup', role: 'setup', d: 25 },
      { tag: 'BUILD', kind: 'coder', role: 'coder', d: 90 },
      { tag: 'REVIEW', kind: 'reviewer', role: 'reviewer', d: 35 },
      { tag: 'SHIP', kind: 'preparer', role: 'preparer', d: 20 },
    ],
  },
  bugfix: {
    gap: 35,
    stations: [
      { tag: 'REPRODUCE', kind: 'setup', role: 'setup', d: 25 },
      { tag: 'FIX', kind: 'fixer', role: 'fixer', d: 60 },
      { tag: 'VERIFY', kind: 'reviewer', role: 'verifier', d: 30 },
    ],
  },
  docs: {
    gap: 40,
    stations: [
      { tag: 'DRAFT', kind: 'coder', role: 'coder', d: 70 },
      { tag: 'REVIEW', kind: 'reviewer', role: 'reviewer', d: 30 },
    ],
  },
  release: {
    gap: 50,
    stations: [
      { tag: 'SETUP', kind: 'setup', role: 'setup', d: 20 },
      { tag: 'BUILD', kind: 'coder', role: 'coder', d: 50 },
      { tag: 'TEST', kind: 'reviewer', role: 'verifier', d: 40 },
      { tag: 'REVIEW', kind: 'reviewer', role: 'reviewer', d: 25 },
      { tag: 'FIX', kind: 'fixer', role: 'fixer', d: 25 },
      { tag: 'PREP', kind: 'preparer', role: 'preparer', d: 20 },
    ],
  },
};
for (const wf of Object.values(WORKFLOWS)) {
  let at = 0;
  for (const s of wf.stations) {
    s.from = at;
    at += s.d;
    s.to = at;
  }
  wf.run = at;
  wf.period = at + wf.gap;
}

const LANES = [
  { id: 'API', wf: 'feature', offset: 0, tags: ['LOGIN-FORM', 'SEARCH-API', 'RATE-LIMIT'] },
  { id: 'WEB', wf: 'bugfix', offset: 61, tags: ['FIX-LOGIN', 'FIX-CACHE', 'FIX-UPLOAD'] },
  { id: 'DOCS', wf: 'docs', offset: 23, tags: ['API-GUIDE', 'CHANGELOG'] },
  { id: 'REL', wf: 'release', offset: 97, tags: ['REL-1.4.0', 'REL-1.4.1', 'REL-1.5.0'] },
  { id: 'APP', wf: 'feature', offset: 128, tags: ['DARK-MODE', 'EXPORT-CSV'] },
  { id: 'CLI', wf: 'bugfix', offset: 14, tags: ['FIX-FLAGS', 'FIX-PATHS'] },
];

// Action cycles per role while an agent works its station (one step every 7 s).
const CYCLES = {
  setup: ['run', 'docker', 'run', 'docker'],
  coder: ['think', 'read', 'edit', 'edit', 'search', 'edit', 'run', 'edit'],
  reviewer: ['read', 'read', 'think', 'search', 'test', 'edit'],
  fixer: ['read', 'edit', 'edit', 'test'],
  preparer: ['run', 'run', 'think'],
  verifier: ['read', 'test', 'think', 'search'],
  helper: ['read', 'edit', 'search', 'think'],
};
// Background runs that hold a test pod: [station role, share of the station from, to, action kind].
const BOOTH = [
  ['coder', 0.55, 0.8, 'test'],
  ['verifier', 0.1, 0.9, 'test'],
  ['preparer', 0.2, 0.9, 'browser'],
];

const B = 70; // seconds between merge batches
const GAUGE = 45; // seconds a batch spends in verification
const PUSH = 300; // a push to the remote every 5 minutes (at 150 s into each)

const PHRASES = { edit: 'writing code', read: 'reading code', search: 'searching the code', run: 'running a command', test: 'running tests', browser: 'testing in the browser', docker: 'starting containers', think: 'thinking', wait: 'waiting' };
// What sample agents say in the private view (?sample=1&public=0): made-up, neutral sentences.
const SAYINGS = {
  edit: ['Writing the {t} change.', 'Updating the {t} handler.', 'Adding tests for {t}.', 'Tidying up the {t} code.'],
  read: ['Reading how {t} works today.', 'Going through the {t} code.', 'Checking the notes on {t}.'],
  search: ['Looking for every caller of {t}.', 'Searching for the old {t} helpers.'],
  run: ['Building {t}.', 'Running the linter on {t}.', 'Checking the {t} build output.'],
  test: ['Running the {t} tests.', 'Running the whole test suite for {t}.'],
  browser: ['Trying {t} in the browser.', 'Clicking through {t} end to end.'],
  docker: ['Starting the containers for {t}.', 'Bringing up a clean database for {t}.'],
  think: ['Working out the cleanest way to do {t}.', 'Weighing two ways to handle {t}.'],
  wait: ['Waiting for a free test booth.', 'Waiting for the tests to finish.'],
};
const topicOf = (tag) => (/^REL-/.test(tag) ? `release ${tag.slice(4)}` : tag.toLowerCase().replace(/^fix-/, '').replace(/-/g, ' '));
function sampleSay(kind, tag, step) {
  const list = SAYINGS[kind] || SAYINGS.think;
  return list[((step % list.length) + list.length) % list.length].replace('{t}', topicOf(tag));
}

const iso = (sec) => new Date(sec * 1000).toISOString();
const mod = (a, n) => ((a % n) + n) % n;

const wfOf = (i) => WORKFLOWS[LANES[i].wf];
const runStart = (i, k) => k * wfOf(i).period - LANES[i].offset;
const runAt = (i, g) => Math.floor((g + LANES[i].offset) / wfOf(i).period);
const runKey = (i, k) => `run-${LANES[i].id.toLowerCase()}-${k}`;
const tagOf = (i, k) => LANES[i].tags[mod(k, LANES[i].tags.length)];
const isFeature = (i) => LANES[i].wf === 'feature';
/** A run the controller stops halfway through its second station (bugfix and docs lanes, now and then). */
const stoppedAt = (i, k) => {
  if (isFeature(i) || LANES[i].wf === 'release' || mod(k + i, 6) !== 2) return null;
  const s = wfOf(i).stations[1];
  return runStart(i, k) + s.from + Math.round(s.d * 0.6);
};
const runEnd = (i, k) => runStart(i, k) + wfOf(i).run;
const bounced = (i, k) => mod(k + i, 7) === 3;
const batchStartFor = (q) => Math.ceil(q / B) * B;
const settleAt = (i, k) => batchStartFor(runEnd(i, k)) + GAUGE;

/** The station run k of lane i works at second g: { s, idx, p } (p: seconds into it), or null. */
function stationAt(i, k, g) {
  const p = g - runStart(i, k);
  const stop = stoppedAt(i, k);
  if (stop !== null && g >= stop) return null;
  const list = wfOf(i).stations;
  for (let idx = 0; idx < list.length; idx += 1) if (p >= list[idx].from && p < list[idx].to) return { s: list[idx], idx, p: p - list[idx].from };
  return null;
}

function boothsAt(g) {
  const wants = [];
  for (let i = 0; i < LANES.length; i += 1) {
    const k = runAt(i, g);
    const at = stationAt(i, k, g);
    if (!at) continue;
    for (const [role, a, b, kind] of BOOTH) {
      if (at.s.role !== role) continue;
      const from = Math.round(at.s.d * a);
      const to = Math.round(at.s.d * b);
      if (at.p >= from && at.p < to) wants.push({ i, k, kind, since: runStart(i, k) + at.s.from + from });
    }
  }
  return wants.sort((x, y) => x.since - y.since || x.i - y.i);
}

/** Queue entries of feature runs around second g (ready, batched, then merged or bounced for 15 s). */
function entriesAt(g) {
  const out = [];
  for (let i = 0; i < LANES.length; i += 1) {
    if (!isFeature(i)) continue;
    const kNow = runAt(i, g);
    for (let k = kNow - 3; k <= kNow; k += 1) {
      const q = runEnd(i, k);
      if (q > g) continue;
      const start = batchStartFor(q);
      const settle = start + GAUGE;
      let status;
      if (g < start) status = 'ready';
      else if (g < settle) status = 'batched';
      else if (g < settle + 15) status = bounced(i, k) ? 'bounced' : 'merged';
      else continue;
      out.push({ i, k, slug: runKey(i, k), id: runKey(i, k), lane: LANES[i].id, status, title: null, kind: 'run', bounces: status === 'bounced' ? 1 : 0, readyAt: iso(q), batchStart: start });
    }
  }
  return out.sort((a, b) => a.readyAt.localeCompare(b.readyAt));
}

function batchAt(g) {
  const n = Math.floor(g / B);
  const start = n * B;
  const slugs = entriesAt(start).filter((e) => e.batchStart === start).map((e) => e.slug);
  return { n, start, slugs, running: g < start + GAUGE && slugs.length > 0 };
}

function agentsAt(g, publicMode = true) {
  const agents = [];
  const wants = boothsAt(g);
  const inBooth = wants.slice(0, 4);
  for (let i = 0; i < LANES.length; i += 1) {
    const k = runAt(i, g);
    const at = stationAt(i, k, g);
    if (!at) continue;
    const role = at.s.role;
    const cycle = CYCLES[role];
    let kind = cycle[Math.floor(at.p / 7) % cycle.length];
    let text = PHRASES[kind];
    let background = false;
    const want = wants.find((w) => w.i === i && w.k === k);
    if (want) {
      background = true;
      if (inBooth.includes(want)) {
        kind = want.kind;
        text = `${kind === 'browser' ? 'running a live check' : 'running tests'} (background)`;
      } else {
        kind = 'wait';
        text = 'waiting for a test booth';
      }
    }
    const step = Math.floor(at.p / 7);
    const action = { kind, text, since: iso(background && want.since ? want.since : g - (at.p % 7)) };
    if (background) action.background = true;
    agents.push({
      say: publicMode ? text : sampleSay(kind, tagOf(i, k), step + i),
      id: `sample-${LANES[i].id.toLowerCase()}-${k}-${at.idx}`,
      role,
      job: runKey(i, k),
      lane: LANES[i].id,
      station: at.idx,
      stationTag: at.s.tag,
      tag: tagOf(i, k),
      title: tagOf(i, k),
      label: `${LANES[i].wf} ${at.s.tag.toLowerCase()}`,
      since: iso(runStart(i, k) + at.s.from),
      activeAt: iso(g),
      action,
    });
  }
  const batch = batchAt(g);
  agents.push({
    id: 'sample-merger',
    role: 'merger',
    job: null,
    lane: null,
    station: null,
    stationTag: null,
    tag: 'MERGE',
    place: 'merge',
    title: 'Merge batch',
    label: 'merge batch',
    since: iso(batch.start),
    activeAt: iso(g),
    action: batch.running ? { kind: 'test', text: 'verifying the batch', since: iso(batch.start) } : { kind: 'wait', text: 'waiting for parcels', since: iso(batch.start) },
    say: batch.running ? (publicMode ? 'verifying the batch' : 'Checking the merge batch before it lands.') : publicMode ? 'waiting for parcels' : 'Waiting for the next finished runs.',
  });
  // a verifier on the dock for 7 minutes of every 15, a helper for 5 minutes of every 10
  const side = [
    { name: 'verify', role: 'verifier', tag: 'AUDIT', every: 900, from: 0, to: 420, step: 9 },
    { name: 'helper', role: 'helper', tag: 'DOCS-SYNC', every: 600, from: 120, to: 420, step: 11 },
  ];
  for (const s of side) {
    const p = mod(g, s.every);
    if (p < s.from || p >= s.to) continue;
    const start = g - p + s.from;
    const cycle = CYCLES[s.role];
    const n = Math.floor((g - start) / s.step);
    const kind = cycle[n % cycle.length];
    agents.push({ id: `sample-${s.name}-${start}`, role: s.role, job: null, lane: null, station: null, stationTag: null, tag: s.tag, standalone: true, title: s.tag, label: s.tag.toLowerCase(), since: iso(start), activeAt: iso(g), action: { kind, text: PHRASES[kind], since: iso(start + n * s.step) }, say: publicMode ? PHRASES[kind] : sampleSay(kind, s.tag, n) });
  }
  return agents;
}

/** Every run of lane i that overlaps (fromSec, toSec]. */
function runsBetween(i, fromSec, toSec) {
  const out = [];
  for (let k = runAt(i, fromSec) - 2; k <= runAt(i, toSec); k += 1) out.push(k);
  return out;
}

function eventsBetween(fromSec, toSec) {
  const events = [];
  const add = (at, type, extra) => {
    if (at > fromSec && at <= toSec) events.push({ id: `${type}:${extra.key}:${at * 1000}`, at: iso(at), atSec: at, type, ...extra });
  };
  for (let i = 0; i < LANES.length; i += 1) {
    const lane = LANES[i].id;
    for (const k of runsBetween(i, fromSec, toSec)) {
      const job = runKey(i, k);
      const stop = stoppedAt(i, k);
      wfOf(i).stations.forEach((s, idx) => {
        const start = runStart(i, k) + s.from;
        const end = runStart(i, k) + s.to;
        if (stop !== null && start >= stop) return;
        const key = `sample-${lane.toLowerCase()}-${k}-${idx}`;
        add(start, 'started', { job, lane, role: s.role, key, text: `lane ${lane} ${s.tag.toLowerCase()} started` });
        if (stop === null || end <= stop) add(end, 'finished', { job, lane, role: s.role, key, text: `lane ${lane} ${s.tag.toLowerCase()} finished` });
      });
      if (stop !== null) add(stop, 'stopped', { job, lane, key: job, text: `lane ${lane} run stopped` });
      else if (isFeature(i)) {
        add(runEnd(i, k), 'queued', { job, lane, slug: job, key: job, text: `lane ${lane} queued for merge` });
        if (bounced(i, k)) add(settleAt(i, k), 'bounced', { job, lane, slug: job, key: job, text: `lane ${lane} bounced back to its lane` });
        else add(settleAt(i, k), 'merged', { job, lane, slug: job, key: job, text: `lane ${lane} merged` });
      } else add(runEnd(i, k), 'done', { job, lane, key: job, text: `lane ${lane} run finished` });
    }
  }
  for (let t = Math.floor(fromSec / PUSH) * PUSH + PUSH / 2; t <= toSec; t += PUSH) add(t, 'pushed', { job: null, key: 'push', text: 'work pushed to the remote' });
  const order = { queued: 0, started: 1, finished: 2, stopped: 3, done: 4, bounced: 5, merged: 6, pushed: 7 };
  return events.sort((a, b) => a.atSec - b.atSec || order[a.type] - order[b.type]);
}

/** Lane state at g: status, current station, stations done, progress. */
function lanesAt(g, agents) {
  return LANES.map((l, i) => {
    const wf = wfOf(i);
    const k = runAt(i, g);
    const at = stationAt(i, k, g);
    const stop = stoppedAt(i, k);
    const p = g - runStart(i, k);
    let status;
    let done;
    if (at) {
      status = 'running';
      done = at.idx;
    } else if (stop !== null && g >= stop) {
      status = 'killed';
      done = wf.stations.filter((s) => runStart(i, k) + s.to <= stop).length;
    } else if (p >= wf.run) {
      done = wf.stations.length;
      const q = entriesAt(g).find((e) => e.i === i && e.k === k);
      status = q && (q.status === 'ready' || q.status === 'batched') ? 'waiting' : 'completed';
    } else {
      status = 'idle';
      done = 0;
    }
    return {
      id: l.id,
      tag: tagOf(i, k),
      title: tagOf(i, k),
      workflow: l.wf.toUpperCase(),
      stations: wf.stations.map((s) => ({ tag: s.tag, kind: s.kind })),
      current: at ? at.idx : null,
      done,
      status,
      show: true,
      active: agents.some((a) => a.lane === l.id),
      progress: { done, total: wf.stations.length },
    };
  });
}

/** Counters since `epoch`: runs finished of runs started, and agents (stations) finished of started. */
function countersAt(g, epoch) {
  let runsDone = 0;
  let runsStarted = 0;
  let agentsDone = 0;
  let agentsStarted = 0;
  for (let i = 0; i < LANES.length; i += 1) {
    for (const k of runsBetween(i, epoch, g)) {
      const start = runStart(i, k);
      const stop = stoppedAt(i, k);
      if (start > epoch && start <= g) runsStarted += 1;
      const end = stop ?? runEnd(i, k);
      if (end > epoch && end <= g) runsDone += 1;
      for (const s of wfOf(i).stations) {
        const a = start + s.from;
        const b = start + s.to;
        if (stop !== null && a >= stop) continue;
        if (a > epoch && a <= g) agentsStarted += 1;
        if ((stop === null || b <= stop) && b > epoch && b <= g) agentsDone += 1;
      }
    }
  }
  // runs and agents already under way at the epoch count in the totals too
  return { runs: { done: runsDone, total: Math.max(runsDone, runsStarted + LANES.length) }, agents: { done: agentsDone, total: Math.max(agentsDone, agentsStarted + LANES.length) } };
}

/** Sample state at virtual second `g` (the live schema, with sample: true). */
export function sampleStateAt(cfg, gSeconds, { publicMode = true, eventsFromSec, shownAt, doneEpoch } = {}) {
  const g = Math.floor(gSeconds);
  const agents = agentsAt(g, publicMode);
  const lanes = lanesAt(g, agents);
  const epoch = Math.min(g, doneEpoch ?? Math.floor(g / 3600) * 3600);
  const counters = countersAt(g, epoch);
  const entries = entriesAt(g).map(({ i, k, batchStart, ...e }) => e);
  const batch = batchAt(g);
  const booths = boothsAt(g).slice(0, 4);
  const mapTime = shownAt || ((sec) => iso(sec));
  const maxEvents = (cfg && cfg.maxEvents) || 60;
  const slotCount = (cfg && cfg.slotCount) || 4;
  const events = eventsBetween(eventsFromSec ?? g - 600, g)
    .slice(-maxEvents)
    .map(({ atSec, ...e }) => ({ ...e, at: mapTime(atSec) }));
  return {
    now: mapTime(g),
    mode: 'live',
    sample: true,
    public: publicMode,
    notice: 'sample data',
    project: {
      name: 'Sample project',
      done: counters.runs.done,
      total: counters.runs.total,
      features: counters.agents,
      batch: lanes.filter((l) => l.status === 'running').length,
      labels: { jobs: 'RUNS', features: 'AGENTS', batch: 'LIVE' },
    },
    pipeline: { stations: WORKFLOWS.feature.stations.map((s) => ({ tag: s.tag, kind: s.kind })), lanes },
    agents,
    queue: { entries, batch: batch.running ? { n: batch.n, slugs: batch.slugs, startedAt: iso(batch.start), status: 'running' } : null, lastBatch: null },
    slots: Array.from({ length: slotCount }, (_, idx) => {
      const b = booths[idx];
      if (!b) return { n: idx + 1, holder: null, job: null, lane: null, since: null };
      return { n: idx + 1, holder: LANES[b.i].id, job: runKey(b.i, b.k), lane: LANES[b.i].id, since: iso(b.since) };
    }),
    exclusive: null,
    lock: batch.running ? { holder: 'merge batch', job: null, lane: null, since: iso(batch.start) } : null,
    events,
    yard: { labels: { test: 'TEST', merge: 'MERGE', develop: 'DONE', remote: 'REMOTE' } },
    sources: { sample: 'sample' },
  };
}

export function sampleState(cfg, { now = Date.now(), publicMode = true } = {}) {
  return sampleStateAt(cfg, now / 1000, { publicMode });
}

/** Sample time-lapse: about `frames * 8` simulated seconds spread over the requested window. */
export function sampleReplay(cfg, { now = Date.now(), hours, frames, publicMode = true, fromMs, toMs } = {}) {
  const R = { defaultHours: 8, maxHours: 48, defaultFrames: 240, maxFrames: 900, ...((cfg && cfg.replay) || {}) };
  const windowed = Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs;
  if (windowed) now = Math.min(toMs, now);
  const h = windowed ? (now - fromMs) / 3600_000 : Math.min(Math.max(Number(hours) || R.defaultHours, 0.25), R.maxHours);
  const n = Math.min(Math.max(Math.round(Number(frames) || R.defaultFrames), 2), R.maxFrames);
  const from = now - h * 3600_000;
  const stepMs = (now - from) / (n - 1);
  const virtualStep = 8;
  const gEnd = Math.floor(now / 1000);
  const gStart = gEnd - virtualStep * (n - 1);
  const shownAt = (sec) => new Date(from + ((sec - gStart) / (virtualStep * (n - 1))) * (now - from)).toISOString();
  const out = [];
  const all = [];
  for (let i = 0; i < n; i += 1) {
    const g = gStart + i * virtualStep;
    const frame = sampleStateAt(cfg, g, { publicMode, eventsFromSec: i === 0 ? g : g - virtualStep, shownAt, doneEpoch: gStart });
    frame.mode = 'replay';
    all.push(...frame.events);
    out.push(frame);
  }
  return {
    mode: 'replay',
    sample: true,
    public: publicMode,
    notice: 'sample data',
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    hours: h,
    frameCount: out.length,
    stepMs: Math.round(stepMs),
    project: { ...out.at(-1).project },
    sources: out.at(-1).sources,
    notes: ['Sample data: a simulation for development and screenshots, not real agents.'],
    events: all,
    frames: out,
  };
}

/** A sample moment (unix seconds, at or after `fromSec`) with every role and every console kind busy on stage. */
export function sampleFullMoment(fromSec = 1_795_000_000, limit = 6 * 3600) {
  const roles = ['setup', 'coder', 'reviewer', 'fixer', 'preparer', 'merger', 'verifier', 'helper'];
  for (let g = Math.floor(fromSec); g < fromSec + limit; g += 1) {
    const agents = agentsAt(g);
    const have = new Set(agents.map((a) => a.role));
    if (!roles.every((r) => have.has(r))) continue;
    const kinds = new Set(agents.filter((a) => a.lane).map((a) => wfOf(LANES.findIndex((l) => l.id === a.lane)).stations[a.station].kind));
    if (kinds.size === 5 && agents.find((a) => a.role === 'merger').action.kind === 'test') return g;
  }
  return null;
}

// ---------------------------------------------------------------- an agent's log (a click on it)
const SAMPLE_TOOLS = {
  edit: ['Edit', (s) => `src/${s}.ts`, 'The file was updated.'],
  read: ['Read', (s) => `src/${s}.ts`, '214 lines'],
  search: ['Grep', (s) => `${s.replace(/-/g, ' ')}  in src/`, '6 matches in 3 files'],
  run: ['Bash', () => 'npm run build', 'Build finished in 41 s.'],
  test: ['Bash', (s) => `npm test -- ${s}`, '24 passed, 0 failed'],
  browser: ['Bash', (s) => `npx playwright test ${s}`, '5 passed'],
  docker: ['Bash', () => 'docker compose up -d', 'Containers started.'],
  wait: ['Monitor', () => 'the background tests', null],
};

/**
 * A sample agent's log, as /api/agent answers for live agents: replayed second by second from the same
 * simulation the stage shows, so every step in it is one the stage played. Null for an unknown id.
 */
export function sampleAgentLog(id, gSeconds, { publicMode = true } = {}) {
  if (typeof id !== 'string' || !/^sample-[a-z0-9-]{1,48}$/.test(id)) return null;
  const g = Math.floor(gSeconds);
  let head = agentsAt(g, publicMode).find((a) => a.id === id) || null;
  let end = g;
  const working = Boolean(head);
  for (let t = g - 1; !head && t > g - 900; t -= 1) {
    head = agentsAt(t, publicMode).find((a) => a.id === id) || null;
    end = t;
  }
  if (!head) return null;
  const start = Math.max(Math.floor(Date.parse(head.since) / 1000), end - 900);
  const slug = String(head.tag || 'task').toLowerCase();
  const entries = [];
  let lastKey = null;
  if (!publicMode) entries.push({ t: iso(start), type: 'task', text: `Sample data. You are the ${head.role} for ${head.tag || 'this task'}${head.stationTag ? `: work the ${head.stationTag} phase of the run and hand it on` : ''}. Keep it small and leave the tests green.` });
  for (let t = start; t <= end; t += 1) {
    const a = agentsAt(t, publicMode).find((x) => x.id === id);
    if (!a) continue;
    const key = `${a.action.kind}|${a.say}|${a.action.background ? 1 : 0}`;
    if (key === lastKey) {
      const last = entries[entries.length - 1];
      if (publicMode && last) last.until = iso(t);
      continue;
    }
    lastKey = key;
    if (publicMode) {
      const last = entries[entries.length - 1];
      if (last && last.text === a.action.text) {
        last.count += 1;
        last.until = iso(t);
      } else entries.push({ t: iso(t), kind: a.action.kind, text: a.action.text, count: 1, until: iso(t) });
      continue;
    }
    entries.push({ t: iso(t), type: 'say', text: a.say });
    const tool = SAMPLE_TOOLS[a.action.kind];
    if (!tool) continue;
    const [name, what, result] = tool;
    entries.push({ t: iso(t), type: 'tool', name, kind: a.action.kind, text: `${name} ${what(slug)}`, detail: what(slug), background: a.action.background || undefined });
    if (result) entries.push({ t: iso(t + 2), type: 'result', text: result });
  }
  return {
    id,
    role: head.role,
    tag: head.tag,
    title: head.title,
    label: head.label,
    lane: head.lane,
    stationTag: head.stationTag,
    status: working ? 'working' : 'finished',
    since: head.since,
    activeAt: iso(end),
    say: working ? head.say : null,
    action: working ? head.action : null,
    public: publicMode,
    sample: true,
    entries,
    omitted: 0,
  };
}
