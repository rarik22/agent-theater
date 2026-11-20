// Agent Theater HD · hd-scene.mjs
// Maps one /api/state object to what the stage shows: which lanes get a row (each with its own stations),
// where every agent stands, which parcels wait on the belt or sit in the merge window, which test pods
// are held, and which events the stage animates. Pure and strict: it only uses what the state says, it
// validates every field, and it never passes on free text (commands, paths, names).

export const ROLES = ['setup', 'coder', 'reviewer', 'fixer', 'preparer', 'merger', 'verifier', 'helper'];
export const KINDS = ['edit', 'read', 'search', 'run', 'test', 'browser', 'docker', 'think', 'wait'];
/** Console kinds a station can have (the five station consoles). */
export const STATION_KINDS = ['setup', 'coder', 'reviewer', 'fixer', 'preparer'];
export const MAX_STATIONS = 6;
/** The eight lane hues of the palette (hd-palette LANE_RAMPS). */
export const LANE_HUES = ['ember', 'gold', 'moss', 'jade', 'sky', 'lilac', 'rose', 'sand'];
/** Stations of a lane that brings none, and of the default pipeline. */
export const DEFAULT_STATIONS = Object.freeze([
  { tag: 'SETUP', kind: 'setup' },
  { tag: 'CODE', kind: 'coder' },
  { tag: 'REVIEW', kind: 'reviewer' },
  { tag: 'FIX', kind: 'fixer' },
  { tag: 'PREP', kind: 'preparer' },
]);
export const EVENT_TYPES = ['merged', 'bounced', 'done', 'stopped', 'pushed'];
const LANE_STATUS = ['running', 'completed', 'killed', 'waiting', 'idle'];
const QUEUE_STATUS = ['ready', 'batched', 'merged', 'bounced', 'held', 'dropped'];

const ROLE_SET = new Set(ROLES);
const KIND_SET = new Set(KINDS);
const STATION_KIND_SET = new Set(STATION_KINDS);

/** A lane id is a short chip code: capitals, digits and dashes, at most 6 characters. */
export const isLaneId = (s) => typeof s === 'string' && /^[A-Z0-9][A-Z0-9-]{0,5}$/.test(s);
/** A public tag: capitals, digits, dot and dash, at most 16 characters. */
export const safeTag = (s) => (typeof s === 'string' && /^[A-Z0-9][A-Z0-9.-]{0,15}$/.test(s) ? s : null);
/** A station tag: capitals, digits, space, dot and dash, at most 12 characters. */
export const safeStationTag = (s) => (typeof s === 'string' && /^[A-Z0-9][A-Z0-9 .-]{0,11}$/.test(s) ? s.trimEnd() : null);
/** A key that is only compared, never drawn (agent and run ids, job keys). */
export const safeKey = (s) => (typeof s === 'string' && s.length > 0 && s.length <= 80 ? s : null);
const safeSlug = (s) => (typeof s === 'string' && /^[a-z0-9][a-z0-9._/:-]{0,80}$/i.test(s) ? s.toLowerCase() : null);
const whole = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
/** A word for an LCD or a yard plate: capitals and digits (spaces for plates), 1..8 characters. */
export const safeWord = (s, { spaces = false } = {}) => (typeof s === 'string' && (spaces ? /^[A-Z0-9][A-Z0-9 ]{0,7}$/ : /^[A-Z0-9]{1,8}$/).test(s) ? s.trimEnd() : null);

/** One station list, validated: 1..MAX_STATIONS stations with a tag and a console kind. */
export function normalizeStations(list, fallback = DEFAULT_STATIONS) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (out.length >= MAX_STATIONS) break;
    if (!s || typeof s !== 'object') continue;
    const kind = STATION_KIND_SET.has(s.kind) ? s.kind : null;
    const tag = safeStationTag(s.tag);
    if (!kind && !tag) continue;
    out.push({ tag: tag || '', kind: kind || STATION_KINDS[Math.min(out.length, STATION_KINDS.length - 1)] });
  }
  return out.length ? out : fallback.map((s) => ({ ...s }));
}

/** One lane of the pipeline, validated (null when its id is not a valid chip code). */
export function normalizeLane(l, defaults = DEFAULT_STATIONS, index = 0) {
  if (!l || typeof l !== 'object' || !isLaneId(l.id)) return null;
  const stations = normalizeStations(l.stations, defaults);
  const done = Math.min(stations.length, whole(l.done) ?? 0);
  const cur = whole(l.current);
  const prog = l.progress && whole(l.progress.done) !== null && whole(l.progress.total) ? { done: Math.min(l.progress.done, l.progress.total), total: l.progress.total } : null;
  return {
    id: l.id,
    tag: safeTag(l.tag),
    stations,
    done,
    current: cur !== null && cur < stations.length ? cur : null,
    status: LANE_STATUS.includes(l.status) ? l.status : 'running',
    show: l.show !== false,
    active: l.active === true,
    progress: prog,
    order: index,
  };
}

/** Every lane of the state's pipeline (unique ids, in the server's order). */
export function pipelineLanes(state) {
  const defaults = normalizeStations(state?.pipeline?.stations, DEFAULT_STATIONS);
  const seen = new Set();
  const out = [];
  (Array.isArray(state?.pipeline?.lanes) ? state.pipeline.lanes : []).forEach((l, i) => {
    const lane = normalizeLane(l, defaults, i);
    if (!lane || seen.has(lane.id)) return;
    seen.add(lane.id);
    out.push(lane);
  });
  return out;
}

/** Words for a speech bubble: a string without control characters, one line, at most 160 characters. */
export function cleanSay(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** One agent from the state, validated: unknown roles become helpers and unknown actions thinking. */
export function normalizeAgent(a) {
  if (!a || typeof a !== 'object') return null;
  const id = safeKey(a.id);
  if (!id) return null;
  const role = ROLE_SET.has(a.role) ? a.role : 'helper';
  const kind = KIND_SET.has(a.action?.kind) ? a.action.kind : 'think';
  const since = Date.parse(a.since);
  const actSince = Date.parse(a.action?.since);
  return {
    id,
    role,
    kind,
    // the bubble's words: the state's `say` (a generic phrase in public mode), else the action's text
    say: cleanSay(a.say ?? a.action?.text),
    actSince: Number.isFinite(actSince) ? actSince : null,
    background: a.action?.background === true,
    job: safeKey(a.job),
    lane: isLaneId(a.lane) ? a.lane : null,
    station: whole(a.station),
    tag: safeTag(a.tag),
    merge: a.place === 'merge',
    since: Number.isFinite(since) ? since : 0,
  };
}

/**
 * The lanes that get a row: lanes the server wants shown, at most `max`. When there are more, lanes with
 * an agent at a station come first, then active lanes, then the rest; rows keep the server's order.
 */
export function pickRows(lanes, agents, max = 8) {
  const shown = lanes.filter((l) => l.show);
  if (shown.length <= max) return shown;
  const staffed = new Set(agents.filter((a) => a.lane && a.station !== null).map((a) => a.lane));
  const score = (l) => (staffed.has(l.id) ? 2 : l.active ? 1 : 0);
  return [...shown]
    .sort((x, y) => score(y) - score(x) || x.order - y.order)
    .slice(0, max)
    .sort((x, y) => x.order - y.order);
}

/** A stable small hash of a lane id (FNV-1a). */
export function laneHash(id) {
  let h = 2166136261;
  for (const ch of String(id)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** The hue a lane prefers when it is free. */
export const preferredHue = (id) => LANE_HUES[laneHash(id) % LANE_HUES.length];

/**
 * Lane hues for the rows: each lane prefers the hue of its id's hash, and a row keeps the hue it already
 * has, so colours stay put while lanes come and go. Visible rows never share a hue (there are 8 of each).
 */
export function laneHues(rowIds, prev = new Map()) {
  const out = new Map();
  const used = new Set();
  for (const id of rowIds) {
    const h = prev.get(id);
    if (h && !used.has(h)) {
      out.set(id, h);
      used.add(h);
    }
  }
  for (const id of rowIds) {
    if (out.has(id)) continue;
    const n = laneHash(id);
    let k = 0;
    while (k < LANE_HUES.length && used.has(LANE_HUES[(n + k) % LANE_HUES.length])) k += 1;
    const h = LANE_HUES[(n + k) % LANE_HUES.length];
    out.set(id, h);
    used.add(h);
  }
  return out;
}

/**
 * Where each agent belongs: its lane's station when the lane has a row and the agent a station (clamped
 * to that lane's stations), the merge machine (place merge, or a merger outside any lane), else the dock.
 */
export function placeAgents(agents, rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byKey = new Map();
  const out = [];
  const order = (a, b) => a.since - b.since || a.id.localeCompare(b.id);
  for (const a of [...agents].sort(order)) {
    let place;
    const row = a.lane ? byId.get(a.lane) : null;
    if (row && a.station !== null) {
      const station = Math.min(a.station, row.stations.length - 1);
      place = { place: 'lane', row: row.id, station, key: `${row.id}:${station}` };
    } else if (a.merge || (a.role === 'merger' && !a.lane)) place = { place: 'merge', key: 'merge' };
    else place = { place: 'dock', key: 'dock' };
    const list = byKey.get(place.key) || [];
    const item = { ...a, ...place, slot: list.length };
    list.push(item);
    byKey.set(place.key, list);
    out.push(item);
  }
  for (const item of out) item.count = byKey.get(item.key).length;
  return out;
}

/** The merge queue: parcels on the belt (oldest lowest) and parcels in the merge window. */
export function queueScene(state) {
  const entries = Array.isArray(state?.queue?.entries) ? state.queue.entries : [];
  const batch = state?.queue?.batch && Array.isArray(state.queue.batch.slugs) ? state.queue.batch : null;
  const items = [];
  for (const e of entries) {
    const slug = safeSlug(e?.slug);
    if (!slug) continue;
    const status = QUEUE_STATUS.includes(e.status) ? e.status : 'ready';
    const readyAt = Date.parse(e.readyAt);
    items.push({ slug, job: safeKey(e.id), lane: isLaneId(e.lane) ? e.lane : null, status, readyAt: Number.isFinite(readyAt) ? readyAt : 0 });
  }
  const belt = items.filter((e) => e.status === 'ready' || e.status === 'held').sort((a, b) => a.readyAt - b.readyAt || a.slug.localeCompare(b.slug));
  const window = [];
  const inWindow = new Set();
  if (batch) {
    for (const raw of batch.slugs) {
      const slug = safeSlug(raw);
      if (!slug || inWindow.has(slug)) continue;
      const e = items.find((x) => x.slug === slug);
      window.push({ slug, job: e?.job || null, lane: e ? e.lane : null, status: 'batched' });
      inWindow.add(slug);
    }
  }
  for (const e of items) if (e.status === 'batched' && !inWindow.has(e.slug)) {
    window.push({ ...e });
    inWindow.add(e.slug);
  }
  const bounced = new Set(items.filter((e) => e.status === 'bounced' && e.lane).map((e) => e.lane));
  const byStatus = new Map(items.map((e) => [e.slug, e]));
  return { belt, window, bounced, byStatus, batchRunning: Boolean(batch) };
}

/** Who holds a lock or slot, as the stage colours it: a lane, the merge batch, or someone else. */
export function holderOf(owner) {
  if (!owner || typeof owner !== 'object') return null;
  if (!owner.holder && !owner.job && !owner.lane) return null;
  if (isLaneId(owner.lane)) return { kind: 'lane', lane: owner.lane };
  if (typeof owner.holder === 'string' && /merge/i.test(owner.holder)) return { kind: 'merge', lane: null };
  return { kind: 'other', lane: null };
}

/** Test pods (always 4 drawn; a missing or unavailable slot is an empty pod), the exclusive hold and the lock. */
export function podScene(state) {
  const slots = Array.isArray(state?.slots) ? state.slots : [];
  const pods = [0, 1, 2, 3].map((i) => {
    const s = slots.find((x) => Number(x?.n) === i + 1) || slots[i] || null;
    return { n: i + 1, holder: s && !s.unavailable ? holderOf(s) : null, unavailable: !s || Boolean(s.unavailable) };
  });
  return { pods, exclusive: holderOf(state?.exclusive), lock: holderOf(state?.lock) };
}

/** The events the stage animates (merges, bounces, finished and stopped runs, pushes). */
export function stageEvents(state) {
  return (Array.isArray(state?.events) ? state.events : [])
    .filter((e) => e && typeof e.id === 'string' && e.id.length <= 200 && EVENT_TYPES.includes(e.type))
    .map((e) => ({ id: e.id, type: e.type, slug: safeSlug(e.slug), job: safeKey(e.job), lane: isLaneId(e.lane) ? e.lane : null }));
}

/** The whole scene for one state; `maxRows` caps the lane rows for the aspect. */
export function mapState(state, maxRows = 8) {
  const raw = Array.isArray(state?.agents) ? state.agents : [];
  const agents = raw.map(normalizeAgent).filter(Boolean);
  const lanes = pipelineLanes(state);
  const rows = pickRows(lanes, agents, maxRows);
  const placed = placeAgents(agents, rows);
  return {
    lanes,
    rows,
    rowIds: rows.map((r) => r.id),
    agents: placed,
    ...queueScene(state),
    ...podScene(state),
    events: stageEvents(state),
    sample: state?.sample === true,
    public: state?.public !== false,
    replay: state?.mode === 'replay',
    agentsKnown: Array.isArray(state?.agents),
  };
}

// ---------------------------------------------------------------- words for screen readers (public-safe)
const KIND_WORDS = { edit: 'writing code', read: 'reading', search: 'searching the code', run: 'running a command', test: 'running tests', browser: 'testing in a browser', docker: 'starting containers', think: 'thinking', wait: 'waiting' };
const ROLE_WORDS = { setup: 'setup agent', coder: 'coder', reviewer: 'reviewer', fixer: 'fixer', preparer: 'preparer', merger: 'merger', verifier: 'verifier', helper: 'helper' };

/** A short description of the scene built only from roles, lane codes and action kinds (never server text). */
export function describeScene(scene) {
  if (!scene.agentsKnown) return 'No agent data.';
  const parts = scene.agents.slice(0, 12).map((a) => `${a.place === 'lane' ? `lane ${a.row} ` : ''}${ROLE_WORDS[a.role]} ${KIND_WORDS[a.kind]}`);
  const n = scene.agents.length;
  const lead = n === 0 ? 'No agents are working.' : `${n} ${n === 1 ? 'agent' : 'agents'}: ${parts.join('; ')}${n > 12 ? '; and more' : ''}.`;
  const r = scene.rows.length ? ` ${scene.rows.length} ${scene.rows.length === 1 ? 'lane' : 'lanes'} on stage.` : '';
  const q = scene.belt.length ? ` ${scene.belt.length} waiting for merge.` : '';
  const b = scene.window.length ? ` Merge batch of ${scene.window.length} running.` : '';
  return `${lead}${r}${q}${b}${scene.sample ? ' Sample data.' : ''}`;
}
