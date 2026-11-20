// Agent Theater HD · hd-world.mjs
// The animated model of the HD stage. Each /api/state goes through the strict scene mapper (hd-scene:
// validated lanes and their stations, roles, kinds, queue, batch, slots, locks and events), then this
// module:
//   - keeps only what is really in the running batch in the merge window (a batch slug whose entry has
//     bounced, merged or been dropped has left the batch), and never shows a parcel twice;
//   - places every agent: at its lane's station, the merger at the merge machine, everyone else on the
//     dock next to the controller; agents are tracked by id, so a change of spot is a walk, and the next
//     agent of a job (a workflow run) takes over where the last one stood and walks to its own station;
//   - moves parcels: a new queue entry leaves its lane's last station into the column; a batch rides the
//     chute into the chamber; a merged parcel slides out of the chamber, flows down the pipe as a light,
//     enters the vault and a packet rises to the remote; a bounce flies home as a paper plane; a
//     finished run sends a parcel from its lane through the machine into the vault; a stopped run leaves
//     a grey puff at its chip; a push sends a packet from the vault up to the remote.
// Positions are numbers but always drawn rounded; every path point is a whole pixel. Pure (no DOM).
import { DEFAULT_STATIONS, laneHues, mapState, normalizeStations, preferredHue, safeWord } from './hd-scene.mjs';
import { batchProgress, mergeState, seedOf } from './hd-anim.mjs';
import { lookFor } from './hd-chars.mjs';
import { computeLayout, dockSlot, laneExit, normAspect, parcelPaths, pathLength, queueSlot, stationGeometry, windowBox, windowSlot } from './hd-layout.mjs';

export const SPEED = { walk: 28, belt: 60, chute: 44, out: 30, flow: 80, packet: 46 };
const HANDOFF_S = 180;
const RECENT_S = 300;
const BEAM_S = 0.45;
const PLANE_S = 2.2;
const LEFT_BATCH = new Set(['bounced', 'merged', 'dropped']);

export function createWorld({ aspect = '16:9', calm = false, big = false } = {}) {
  const A = normAspect(aspect);
  return {
    t: 0,
    aspect: A,
    calm,
    big,
    scene: null,
    layout: computeLayout([], A, { big }),
    rowsKey: '',
    hues: new Map(),
    agents: new Map(),
    parcels: new Map(),
    flows: [],
    packets: [],
    planes: [],
    beams: [],
    puffs: [],
    seen: new Set(),
    recent: new Map(),
    spots: new Map(),
    lastMerged: -Infinity,
    lastBounced: -Infinity,
    vaultIntake: -Infinity,
    cloudFlash: -Infinity,
    beacon: -Infinity,
    chipFlash: new Map(),
    podFlash: null,
    nowMs: 0,
    nowAt: 0,
    batchStartedMs: NaN,
    project: { done: null, total: null, features: null, labels: null },
    lanes: [],
    rowInfo: new Map(),
    yardLabels: null,
    batchN: null,
    // the merge machine's motion eases between states instead of snapping: gear angle and speed,
    // gauge needle, and the press jaw's swing (0 idle .. 1 working)
    gearAng: 0.2,
    gearW: 0.12,
    needle: 0,
    mergeEase: 0,
    mergedAt: new Map(),
    pods: [],
    podsHeldByMerge: [],
    lockLabel: '',
  };
}

/**
 * The scene of a state for this world's aspect: hd-scene's mapping, rows capped for the aspect, and the
 * merge window cut down to the entries really in the running batch.
 */
export function sceneFor(state, maxRows = 8) {
  const scene = mapState(state, maxRows);
  scene.window = batchWindow(scene);
  const inWindow = new Set(scene.window.map((e) => e.slug));
  scene.belt = scene.belt.filter((e) => !inWindow.has(e.slug));
  return scene;
}

/** Entries actually in the running batch: listed in it (or batched) and not bounced, merged or dropped. */
export function batchWindow(scene) {
  return scene.window.filter((e) => !LEFT_BATCH.has(scene.byStatus.get(e.slug)?.status));
}

/** Short code for a holder on a pod or the vault display: the lane code, MERGE, or HOLD. */
export function holderLabel(owner, holder) {
  if (!holder) return '';
  if (holder.kind === 'lane') return holder.lane;
  if (holder.kind === 'merge') return 'MERGE';
  return 'HOLD';
}

/** Where an agent stands now, and which way it faces. */
export function agentTarget(L, a, dockIndex, dockCount) {
  if (a.place === 'lane') {
    const row = L.rowById.get(a.row);
    if (row) {
      const st = stationGeometry(L, row, a.station);
      const spread = a.count > 1 ? (a.slot - (a.count - 1) / 2) * 16 : 0;
      return { x: Math.round(st.agent.x + spread), y: st.agent.y, facing: 1 };
    }
  }
  if (a.place === 'merge') return { x: L.merger.x + (L.merge.flip ? -1 : 1) * a.slot * 18, y: L.merger.y, facing: L.merge.flip ? 1 : -1 };
  const d = dockSlot(L, dockIndex, dockCount);
  return { x: d.x, y: d.y, facing: 1 };
}

function walkPath(e, tx, ty) {
  const x = Math.round(e.x);
  const y = Math.round(e.y);
  if (y === ty) return [{ x: tx, y: ty }];
  // change level along the left aisle by the lane chips, or straight when it is short
  if (Math.abs(x - tx) < 40) return [{ x, y: ty }, { x: tx, y: ty }];
  return [{ x: tx, y }, { x: tx, y: ty }];
}

function syncAgents(world, scene, snap) {
  const L = world.layout;
  const incoming = new Map();
  const dockList = scene.agents.filter((a) => !(a.place === 'lane' && L.rowById.has(a.row)) && a.place !== 'merge');
  for (const a of scene.agents) {
    const lane = a.place === 'lane' && L.rowById.has(a.row);
    const placed = lane ? a : a.place === 'merge' ? a : { ...a, place: 'dock' };
    incoming.set(a.id, placed);
  }
  // agents that left: remember a lane agent's spot for the next agent of its job
  for (const e of world.agents.values()) {
    if (incoming.has(e.id) || e.state === 'out') continue;
    if (e.job && e.place === 'lane') world.spots.set(e.job, { x: e.x, y: e.y, row: e.row, t: world.t });
  }
  for (const a of incoming.values()) {
    const di = dockList.findIndex((d) => d.id === a.id);
    const tgt = agentTarget(L, a, Math.max(0, di), dockList.length);
    let e = world.agents.get(a.id);
    if (!e) {
      const seed = seedOf(a.id);
      e = { id: a.id, seed, look: lookFor(a.role, seed), x: tgt.x, y: tgt.y, path: [], walking: false, facing: tgt.facing, state: 'here', bornT: world.t };
      world.agents.set(a.id, e);
      if (!snap && !world.calm) {
        const spot = a.job && a.place === 'lane' ? world.spots.get(a.job) : null;
        // a colleague on the same job still in the lane (the sessions overlap): start where it stands
        const mate = a.job && a.place === 'lane' ? [...world.agents.values()].find((o) => o.id !== a.id && o.job === a.job && o.row === a.row && o.place === 'lane' && o.state === 'here') : null;
        if (spot && spot.row === a.row && world.t - spot.t < HANDOFF_S) {
          // the job handed over (coder to reviewer, and so on): the next agent starts at the spot the
          // last one left and walks to its own station
          e.x = Math.round(spot.x);
          e.y = Math.round(spot.y);
          world.spots.delete(a.job);
          for (const old of world.agents.values()) if (old.job === a.job && old.id !== a.id && !incoming.has(old.id)) old.silent = true;
        } else if (mate) {
          e.x = Math.round(mate.x);
          e.y = Math.round(mate.y);
        } else world.beams.push({ x: tgt.x, y: tgt.y, t0: world.t, kind: 'in' });
      }
    }
    if (e.role && e.role !== a.role) e.look = lookFor(a.role, e.seed);
    // a new line for the speech bubble is lettered in from now (a first state shows it whole)
    if (e.say !== a.say) e.sayT0 = snap ? -Infinity : world.t;
    Object.assign(e, { say: a.say, actSince: a.actSince, background: a.background });
    e.state = 'here';
    Object.assign(e, { role: a.role, kind: a.kind, job: a.job, lane: a.lane, tag: a.tag || null, place: a.place, row: a.place === 'lane' ? a.row : null, station: a.place === 'lane' ? a.station : null, tx: tgt.x, ty: tgt.y, restFacing: tgt.facing });
    if (snap || world.calm) {
      e.x = tgt.x;
      e.y = tgt.y;
      e.path = [];
      e.facing = tgt.facing;
    } else if (Math.round(e.x) !== tgt.x || Math.round(e.y) !== tgt.y) {
      const last = e.path[e.path.length - 1];
      if (!last || last.x !== tgt.x || last.y !== tgt.y) e.path = walkPath(e, tgt.x, tgt.y);
    } else e.path = [];
  }
  for (const e of [...world.agents.values()]) {
    if (incoming.has(e.id)) continue;
    if (e.silent || snap || world.calm) world.agents.delete(e.id);
    else if (e.state !== 'out') {
      e.state = 'out';
      e.outT = world.t;
      e.path = [];
      world.beams.push({ x: Math.round(e.x), y: Math.round(e.y), t0: world.t, kind: 'out' });
    }
  }
}

function setPath(p, pts, speed) {
  p.path = pts.map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) }));
  p.speed = speed;
}
function markRecent(world, key) {
  if (key) world.recent.set(key, world.t);
}
const isRecent = (world, key) => key && world.recent.has(key) && world.t - world.recent.get(key) < RECENT_S;

function noteMerge(world) {
  world.lastMerged = world.t;
  if (world.podsHeldByMerge.length) world.podFlash = { kind: 'pass', t0: world.t, pods: new Set(world.podsHeldByMerge) };
}

function startMerge(world, p) {
  const L = world.layout;
  const P = parcelPaths(L);
  markRecent(world, `merged:${p.slug}`);
  if (p.job) markRecent(world, `merged:${p.job.toLowerCase()}`);
  noteMerge(world);
  if (world.calm) {
    world.parcels.delete(p.slug);
    world.vaultIntake = world.t;
    world.cloudFlash = world.t + 1;
    return;
  }
  const win = windowBox(L);
  const lead = p.mode === 'belt' ? [{ x: P.qx, y: P.bend.y }, P.intake, { x: win.x + 6, y: win.y + 6 }] : [];
  const y0 = p.mode === 'belt' ? win.y + 6 : Math.round(p.y);
  p.mode = 'merging';
  setPath(p, [...lead, { x: P.exitX, y: y0 }], SPEED.out);
}

function launchPlane(world, lane) {
  const L = world.layout;
  const win = windowBox(L);
  const row = lane ? L.rowById.get(lane) : null;
  const to = row ? { x: row.chip.x + row.chip.w + 2, y: row.chip.y + 2 } : { x: L.ctrl.x + L.ctrl.w - 10, y: L.ctrl.y + L.ctrl.h };
  world.planes.push({ from: { x: win.x + win.w / 2, y: win.y - 8 }, to, t0: world.t, lane });
}

/**
 * A finished run: a parcel leaves its lane's last station into the queue column, rides the chute into
 * the machine and through it, then flows down the pipe into the vault (a packet rises to the remote).
 * A run whose lane has no row lights the machine and sends the flow only.
 */
function finishRun(world, ev) {
  const L = world.layout;
  const row = ev.lane ? L.rowById.get(ev.lane) : null;
  noteMerge(world);
  if (world.calm) {
    world.vaultIntake = world.t;
    world.cloudFlash = world.t + 1;
    return;
  }
  if (!row) {
    world.flows.push({ d: 0 });
    return;
  }
  const P = parcelPaths(L);
  const win = windowBox(L);
  const exit = laneExit(L, row);
  const slug = `run:${ev.id}`;
  const p = { slug, job: ev.job, lane: ev.lane, x: exit.x, y: exit.y, path: [], mode: 'merging', speed: SPEED.chute };
  setPath(p, [{ x: P.qx, y: exit.y }, { x: P.qx, y: P.bend.y }, P.intake, { x: win.x + 6, y: win.y + 6 }, { x: P.exitX, y: win.y + 6 }], SPEED.chute);
  world.parcels.set(slug, p);
}

/** A run stopped before it finished: a grey puff at its lane chip (no paper plane: nothing bounced). */
function stopRun(world, ev) {
  const row = ev.lane ? world.layout.rowById.get(ev.lane) : null;
  if (!row || world.calm) return;
  world.puffs.push({ x: row.chip.x + row.chip.w + 4, y: row.chip.y + 8, t0: world.t, colour: 'grey' });
}

/** A push: a packet rises from the vault to the remote, and the cloud flashes when it arrives. */
function pushPacket(world) {
  if (world.calm) {
    world.cloudFlash = world.t;
    return;
  }
  world.packets.push({ d: 0 });
}

function startBounce(world, p) {
  markRecent(world, `bounced:${p.slug}`);
  if (p.job) markRecent(world, `bounced:${p.job.toLowerCase()}`);
  world.lastBounced = world.t;
  if (world.podsHeldByMerge.length) world.podFlash = { kind: 'fail', t0: world.t, pods: new Set(world.podsHeldByMerge) };
  world.parcels.delete(p.slug);
  if (!world.calm) launchPlane(world, p.lane);
}

function syncParcels(world, scene, snap) {
  const L = world.layout;
  const P = parcelPaths(L);
  const calm = snap || world.calm;
  const onBelt = new Set(scene.belt.map((e) => e.slug));
  const inWin = new Set(scene.window.map((e) => e.slug));
  scene.belt.forEach((e, i) => {
    const slot = queueSlot(L, i, scene.belt.length);
    let p = world.parcels.get(e.slug);
    if (!p) {
      p = { slug: e.slug, job: e.job, lane: e.lane, x: slot.x, y: slot.y, path: [], mode: 'belt', speed: SPEED.belt };
      world.parcels.set(e.slug, p);
      const row = e.lane ? L.rowById.get(e.lane) : null;
      if (!calm && row) {
        const exit = laneExit(L, row);
        Object.assign(p, exit);
        setPath(p, [{ x: P.qx, y: exit.y }, slot], SPEED.belt);
      } else if (!calm) {
        Object.assign(p, { x: P.qx, y: L.queue.y0 + 4 });
        setPath(p, [slot], SPEED.belt);
      }
    } else if (calm) Object.assign(p, slot, { path: [] });
    else if (p.mode !== 'belt' || p.tx !== slot.x || p.ty !== slot.y) {
      const last = p.path[p.path.length - 1];
      if (p.mode === 'belt' && last && last.x === P.qx) p.path[p.path.length - 1] = { ...slot };
      else setPath(p, [{ x: P.qx, y: Math.round(p.y) }, slot], SPEED.belt);
    }
    Object.assign(p, { mode: 'belt', tx: slot.x, ty: slot.y, lane: e.lane || p.lane, job: e.job || p.job });
  });
  scene.window.forEach((e, j) => {
    const slot = windowSlot(L, j);
    let p = world.parcels.get(e.slug);
    if (!p) {
      p = { slug: e.slug, job: e.job, lane: e.lane, x: slot.x, y: slot.y, path: [], mode: 'window', speed: SPEED.chute };
      world.parcels.set(e.slug, p);
      if (!calm) {
        Object.assign(p, { x: P.qx, y: P.bend.y });
        setPath(p, [P.intake, slot], SPEED.chute);
      }
    } else if (calm) Object.assign(p, slot, { path: [] });
    else if (p.mode === 'belt') setPath(p, [{ x: P.qx, y: P.bend.y }, P.intake, slot], SPEED.chute);
    else if (p.mode === 'window' && (p.tx !== slot.x || p.ty !== slot.y)) setPath(p, [slot], SPEED.chute);
    Object.assign(p, { mode: 'window', tx: slot.x, ty: slot.y, lane: e.lane || p.lane, job: e.job || p.job });
  });
  for (const p of [...world.parcels.values()]) {
    if (p.mode === 'merging' || onBelt.has(p.slug) || inWin.has(p.slug)) continue;
    const st = scene.byStatus.get(p.slug)?.status;
    if (snap) world.parcels.delete(p.slug);
    else if (st === 'merged') startMerge(world, p);
    else if (st === 'bounced') startBounce(world, p);
    else {
      world.parcels.delete(p.slug);
      if (!world.calm) world.puffs.push({ x: Math.round(p.x) + 8, y: Math.round(p.y) + 6, t0: world.t, colour: 'grey' });
    }
  }
}

function handleEvents(world, scene, snap) {
  for (const ev of scene.events) {
    if (world.seen.has(ev.id)) continue;
    world.seen.add(ev.id);
    if (snap) continue;
    world.beacon = world.t;
    if (ev.type === 'done') {
      finishRun(world, ev);
      continue;
    }
    if (ev.type === 'stopped') {
      stopRun(world, ev);
      continue;
    }
    if (ev.type === 'pushed') {
      pushPacket(world);
      continue;
    }
    const keys = [ev.slug, ev.job && ev.job.toLowerCase()].filter(Boolean);
    if (!keys.length) continue;
    if (ev.type === 'merged') {
      if (keys.some((k) => isRecent(world, `merged:${k}`))) continue;
      const p = [...world.parcels.values()].find((q) => keys.includes(q.slug) || (q.job && keys.includes(q.job.toLowerCase())));
      if (p && p.mode !== 'merging') startMerge(world, p);
      else if (!p) {
        // the merge happened without a parcel on stage: it still lights the machine and reaches develop
        markRecent(world, `merged:${keys[0]}`);
        noteMerge(world);
        if (!world.calm) world.flows.push({ d: 0 });
      }
    } else if (ev.type === 'bounced') {
      if (keys.some((k) => isRecent(world, `bounced:${k}`))) continue;
      markRecent(world, `bounced:${keys[0]}`);
      world.lastBounced = world.t;
      if (world.podsHeldByMerge.length) world.podFlash = { kind: 'fail', t0: world.t, pods: new Set(world.podsHeldByMerge) };
      if (!world.calm) launchPlane(world, ev.lane);
    }
  }
  if (world.seen.size > 4000) world.seen = new Set([...world.seen].slice(-2000));
}

/**
 * Switch the export shape (and the phone build with big labels): rebuild the layout and put everything
 * straight at its place.
 */
export function setAspect(world, aspect, big = world.big) {
  world.aspect = normAspect(aspect);
  world.big = Boolean(big);
  world.layout = computeLayout(world.scene ? world.scene.rows : [], world.aspect, { big: world.big, stations: world.defaultStations || DEFAULT_STATIONS });
  world.rowsKey = '';
  if (world.lastState) applyState(world, world.lastState, { first: true });
}

/** Forget everything (before and after a time-lapse). */
export function resetWorld(world) {
  const fresh = createWorld({ aspect: world.aspect, calm: world.calm, big: world.big });
  for (const k of Object.keys(fresh)) world[k] = fresh[k];
}

/** Apply one /api/state. `first` places everything without animation. */
export function applyState(world, state, { first = false } = {}) {
  const L0 = world.layout;
  const scene = sceneFor(state, L0.maxRows);
  const snap = first || !world.scene;
  world.lastState = state;
  world.hues = laneHues(scene.rowIds, world.hues);
  world.defaultStations = normalizeStations(state?.pipeline?.stations, DEFAULT_STATIONS);
  const key = `${scene.rows.map((r) => `${r.id}=${r.stations.map((st) => `${st.tag}/${st.kind}`).join('|')}`).join(',')}#${world.defaultStations.map((st) => st.tag).join('|')}`;
  if (key !== world.rowsKey || !world.scene) {
    world.layout = computeLayout(scene.rows, world.aspect, { big: world.big, stations: world.defaultStations });
    world.rowsKey = key;
  }
  world.rowInfo = new Map(scene.rows.map((r) => [r.id, { done: r.done, current: r.current, status: r.status }]));
  world.lanes = scene.lanes.slice(0, 16).map((l) => ({
    id: l.id,
    active: l.active || scene.agents.some((a) => a.lane === l.id),
    waiting: l.status === 'waiting',
    completed: l.status === 'completed',
    done: l.progress ? l.progress.done : l.done,
    total: l.progress ? l.progress.total : l.stations.length,
    hue: world.hues.get(l.id) || preferredHue(l.id),
  }));
  const yl = state?.yard?.labels || {};
  world.yardLabels = {
    test: safeWord(yl.test, { spaces: true }) || 'TEST',
    merge: safeWord(yl.merge, { spaces: true }) || 'MERGE',
    develop: safeWord(yl.develop, { spaces: true }) || 'DEVELOP',
    remote: safeWord(yl.remote, { spaces: true }) || 'REMOTE',
  };
  world.scene = scene;
  const now = Date.parse(state?.now);
  if (Number.isFinite(now)) {
    world.nowMs = now;
    world.nowAt = world.t;
  }
  world.batchStartedMs = Date.parse(state?.queue?.batch?.startedAt);
  const whole = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  const feat = state?.project?.features;
  const lbl = state?.project?.labels || {};
  world.project = {
    done: whole(state?.project?.done),
    total: whole(state?.project?.total),
    features: feat && whole(feat.done) !== null && whole(feat.total) !== null ? { done: feat.done, total: feat.total } : null,
    labels: { jobs: safeWord(lbl.jobs) || 'JOBS', features: safeWord(lbl.features) || 'FEATURES', batch: safeWord(lbl.batch) || 'BATCH' },
  };
  world.batchN = whole(state?.project?.batch) ?? whole(Number(state?.queue?.batch?.n));
  const slots = Array.isArray(state?.slots) ? state.slots : [];
  world.pods = scene.pods.map((p, i) => ({ ...p, label: holderLabel(slots.find((s) => Number(s?.n) === i + 1) || slots[i], p.holder) }));
  world.podsHeldByMerge = world.pods.map((p, i) => (p.holder && p.holder.kind === 'merge' ? i : -1)).filter((i) => i >= 0);
  world.lockLabel = holderLabel(state?.lock, scene.lock);
  // git is the truth for "merged into develop": a job merged there has left the merge window and the
  // queue, even while the merge-queue file still lists it (its bookkeeping can lag by hours), unless it
  // was queued again after that merge.
  for (const ev of Array.isArray(state?.events) ? state.events : []) {
    if (!ev || ev.type !== 'merged') continue;
    const at = Date.parse(ev.at);
    if (!Number.isFinite(at)) continue;
    for (const k of [ev.slug, ev.job]) if (typeof k === 'string' && k) {
      const key = k.toLowerCase().replace(/^agent\//, '');
      if (!(world.mergedAt.get(key) >= at)) world.mergedAt.set(key, at);
    }
  }
  const mergedAlready = (e) => [e.slug, e.job && e.job.toLowerCase()].filter(Boolean).some((k) => {
    const at = world.mergedAt.get(String(k).replace(/^agent\//, ''));
    return at !== undefined && !(e.readyAt > at);
  });
  scene.window = scene.window.filter((e) => !mergedAlready(e));
  scene.belt = scene.belt.filter((e) => !mergedAlready(e));
  syncAgents(world, scene, snap);
  // events first, so a parcel that merges in this update rides out of the chamber instead of vanishing
  handleEvents(world, scene, snap);
  syncParcels(world, scene, snap);
  return scene;
}

function follow(e, dt) {
  let left = e.speed * dt;
  while (left > 0 && e.path.length) {
    const q = e.path[0];
    const dx = q.x - e.x;
    const dy = q.y - e.y;
    const d = Math.hypot(dx, dy);
    if (d <= left) {
      e.x = q.x;
      e.y = q.y;
      e.path.shift();
      left -= d;
    } else {
      e.x += (dx / d) * left;
      e.y += (dy / d) * left;
      left = 0;
    }
  }
  return e.path.length === 0;
}

/**
 * The merge machine eases between states: the gear spins up and down (time constant 0.5 s) instead of
 * jumping between speeds, the gauge needle swings to its new reading, the press jaw fades in and out.
 */
function easeMerge(world, dt) {
  const sc = world.scene;
  const ms = mergeState({ batchRunning: Boolean(sc?.batchRunning), windowCount: sc ? sc.window.length : 0, sinceMerged: world.t - world.lastMerged, sinceBounced: world.t - world.lastBounced });
  const working = ms === 'working' && !world.calm;
  const k = (tau) => 1 - Math.exp(-Math.max(0, dt) / tau);
  world.gearW += ((working ? 1.6 : 0.12) - world.gearW) * k(0.5);
  world.gearAng += world.gearW * dt;
  const nowMs = world.nowMs + (world.t - world.nowAt) * 1000;
  const reading = ms === 'pass' ? 1 : batchProgress(world.batchStartedMs, nowMs);
  world.needle += (reading - world.needle) * k(0.35);
  world.mergeEase += ((working ? 1 : 0) - world.mergeEase) * k(0.4);
}

/** Advance the animation by dt seconds (`speed` scales motion for time-lapses). */
export function step(world, dt, speed = 1) {
  world.t += dt;
  const L = world.layout;
  for (const e of [...world.agents.values()]) {
    if (e.state === 'out') {
      if (world.t - e.outT > BEAM_S * 0.6) world.agents.delete(e.id);
      continue;
    }
    if (e.path.length) {
      const q = e.path[0];
      if (q.x !== Math.round(e.x)) e.facing = q.x > e.x ? 1 : -1;
      e.speed = SPEED.walk * speed;
      follow(e, dt);
      e.walking = e.path.length > 0;
      if (!e.walking) e.facing = e.restFacing ?? 1;
    } else {
      e.walking = false;
      e.facing = e.restFacing ?? 1;
    }
  }
  for (const p of [...world.parcels.values()]) {
    if (!p.path.length) continue;
    const base = p.speed;
    p.speed = base * speed;
    const done = follow(p, dt);
    p.speed = base;
    if (done && p.mode === 'merging') {
      world.parcels.delete(p.slug);
      world.flows.push({ d: 0 });
    }
  }
  const pipeLen = pathLength(L.pipe);
  for (const fl of world.flows) {
    fl.d += SPEED.flow * dt * speed;
    if (fl.d >= pipeLen && !fl.done) {
      fl.done = true;
      world.vaultIntake = world.t;
      world.packets.push({ d: 0 });
    }
  }
  world.flows = world.flows.filter((fl) => !fl.done);
  const upLen = pathLength(L.uplink);
  for (const pk of world.packets) {
    pk.d += SPEED.packet * dt * speed;
    if (pk.d >= upLen && !pk.done) {
      pk.done = true;
      world.cloudFlash = world.t;
    }
  }
  world.packets = world.packets.filter((pk) => !pk.done);
  for (const pl of world.planes) if (!pl.done && world.t - pl.t0 >= PLANE_S / speed) {
    pl.done = true;
    if (pl.lane) world.chipFlash.set(pl.lane, world.t);
    world.puffs.push({ x: pl.to.x, y: pl.to.y, t0: world.t, colour: 'red' });
  }
  world.planes = world.planes.filter((pl) => !pl.done);
  easeMerge(world, dt);
  world.beams = world.beams.filter((b) => world.t - b.t0 < BEAM_S);
  world.puffs = world.puffs.filter((p) => world.t - p.t0 < 0.5);
  if (world.podFlash && world.t - world.podFlash.t0 > 2.5) world.podFlash = null;
}

/** Where a flying plane is now: a thrown arc from the merge machine to its lane's chip. */
export function planeAt(world, pl, speed = 1) {
  const u = Math.max(0, Math.min(1, ((world.t - pl.t0) * speed) / PLANE_S));
  const mid = { x: (pl.from.x + pl.to.x) / 2, y: Math.max(20, Math.min(pl.from.y, pl.to.y) - 110) };
  const x = (1 - u) * (1 - u) * pl.from.x + 2 * (1 - u) * u * mid.x + u * u * pl.to.x;
  const y = (1 - u) * (1 - u) * pl.from.y + 2 * (1 - u) * u * mid.y + u * u * pl.to.y;
  return { x: Math.round(x), y: Math.round(y), u, dir: pl.to.x < pl.from.x ? -1 : 1 };
}

/** True while a parcel is travelling on the column (the rollers turn only then). */
export function beltMoving(world) {
  for (const p of world.parcels.values()) if (p.path.length && p.mode === 'belt') return true;
  return false;
}

export { PLANE_S, BEAM_S };
