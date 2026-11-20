// Agent Theater HD · hd-stage.mjs
// The browser side of the HD stage: a clean, live, always-animated view. It reads /api/stream (falling
// back to polling /api/state), steps the world at the display rate and blits the indexed frame with
// nearest-neighbour scaling at the largest whole scale that fits the window (in device pixels, inside
// the safe area); the layout follows the window's shape (16:9 wide, 9:16 on a phone held upright, 4:5
// tall, 1:1 otherwise). On a phone a whole scale that would leave much of the screen empty gives way to
// the largest fractional scale, still nearest-neighbour, so the stage uses the full width. Full animation runs from
// the moment the page opens; ?calm=1 (and only that) softens it by running the stage clock at half
// speed, which never freezes it. ?replay=<from>,<to>&duration=45 plays a past window as a time-lapse
// with a small readout of the replayed clock. Videos are made by tools/render-video.mjs, which loads
// hd-recorder.mjs into the page through the DevTools protocol; the page itself has no export UI.
// Codes strictly to the /api/state schema and never invents data.
import { describeScene } from './hd-scene.mjs';
import { toRGBA } from './hd-gfx.mjs';
import { ASPECTS, SCALE, aspectForWindow, fitScale, normAspect } from './hd-layout.mjs';
import { createRenderer, drawCard, renderFrame } from './hd-render.mjs';
import { applyState, createWorld, resetWorld, setAspect, step } from './hd-world.mjs';

// ---------------------------------------------------------------- settings
const params = new URLSearchParams(location.search);
const SAMPLE = params.get('sample') === '1';
const SAMPLE_AT = Number(params.get('at'));
const PUBLIC = params.get('public') !== '0';
const PROBE = params.get('probe') === '1';
// Headless Chrome screenshots use --virtual-time-budget, which waits for every fetch to end; an open
// event stream never ends, so there (or with ?feed=poll) the stage polls /api/state every 2 s instead.
const POLL = params.get('feed') === 'poll' || (params.get('feed') !== 'sse' && /HeadlessChrome/.test(navigator.userAgent));
// Calm is an explicit choice only (?calm=1): the system's reduced-motion setting does not freeze the stage.
const SOFT = params.get('calm') === '1';
const TZ = params.get('tz') || undefined;
const parseAspect = (v) => {
  const a = String(v || '').replace('x', ':');
  return ASPECTS[a] ? a : null;
};
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- canvas
const canvas = $('stage');
const ctx = canvas.getContext('2d', { alpha: false });
// The x2 output canvas (1920x1080, 1440x1440 or 1440x1800) that tools/render-video.mjs records from.
const out = document.createElement('canvas');
out.setAttribute('aria-hidden', 'true');
out.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none';
document.body.appendChild(out);
const octx = out.getContext('2d', { alpha: false });
const small = document.createElement('canvas');
const sctx = small.getContext('2d', { alpha: false });
const pinnedAspect = parseAspect(params.get('aspect'));
/** The safe area (CSS px) left by notches and home indicators: env(safe-area-inset-*) read from a probe. */
const safeProbe = document.createElement('div');
safeProbe.setAttribute('aria-hidden', 'true');
safeProbe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
document.body.appendChild(safeProbe);
function viewport() {
  const cs = getComputedStyle(safeProbe);
  const px = (v) => Math.max(0, parseFloat(v) || 0);
  const inset = { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  return { vw, vh, inset, w: Math.max(1, vw - inset.left - inset.right), h: Math.max(1, vh - inset.top - inset.bottom) };
}
// phone-sized screens (the short side at most 500 CSS px) use the full width rather than a small whole scale
const phoneSized = () => Math.min(window.innerWidth, window.innerHeight) <= 500;
const fitMode = params.get('fit'); // 'whole' or 'fill' to force either rule
// the phone build (big labels, compact controller) for a phone held sideways: ?big=1 forces it, ?big=0 never
const bigParam = params.get('big');
const wantBig = () => (bigParam === '1' ? true : bigParam === '0' ? false : phoneSized());
const world = createWorld({ aspect: pinnedAspect || aspectForWindow(viewport().w, viewport().h), calm: false, big: wantBig() });
const rd = createRenderer();
let image = null;

function setupCanvas() {
  const { w, h } = ASPECTS[world.aspect];
  small.width = w;
  small.height = h;
  image = sctx.createImageData(w, h);
  if (out.width !== w * SCALE || out.height !== h * SCALE) {
    out.width = w * SCALE;
    out.height = h * SCALE;
  }
  fit();
}

/**
 * Size the canvas in device pixels (CSS px x devicePixelRatio): the largest whole scale that fits the
 * safe area, centred on whole device pixels; a fractional nearest-neighbour scale when even 1x does not
 * fit, or on a phone when the whole scale would leave more than a fifth of the screen empty.
 */
// devW x devH: the art in device pixels; boxW x boxH: the canvas backing store; ox, oy: where the art
// sits in it (drawn 1:1). The browser lays out in 1/64 CSS px, so with a fractional devicePixelRatio
// (2.625, 1.5, 1.25) only some device sizes and offsets map exactly onto device pixels; the box is the
// nearest such size (at most one quantum larger, or smaller by cropping a few pixels of the stage's dark
// margin), so the browser never resamples the canvas and every art pixel stays a uniform block.
const fitState = { scale: 1, exact: true, devW: 0, devH: 0, dpr: 1, left: 0, top: 0, boxW: 0, boxH: 0, ox: 0, oy: 0, quantum: 1 };
/** The fewest device pixels that are a whole number of 1/64 CSS px at this devicePixelRatio. */
function quantum(dpr) {
  for (let q = 1; q <= 64; q += 1) {
    const css64 = (q / dpr) * 64;
    if (Math.abs(css64 - Math.round(css64)) < 1e-6) return q;
  }
  return 1;
}
function boxSize(art, avail, q) {
  if (art % q === 0) return art;
  const up = Math.ceil(art / q) * q;
  return up <= avail ? up : Math.floor(art / q) * q;
}
function fit() {
  const { w, h } = ASPECTS[world.aspect];
  const dpr = window.devicePixelRatio || 1;
  const vp = viewport();
  const fill = fitMode === 'whole' ? 0 : fitMode === 'fill' ? 0.999 : phoneSized() ? 0.8 : 0;
  const s = fitScale(vp.w, vp.h, dpr, w, h, { fill });
  const q = quantum(dpr);
  const availW = Math.floor(vp.w * dpr);
  const availH = Math.floor(vp.h * dpr);
  const boxW = boxSize(s.devW, availW, q);
  const boxH = boxSize(s.devH, availH, q);
  if (canvas.width !== boxW || canvas.height !== boxH) {
    canvas.width = boxW;
    canvas.height = boxH;
  }
  canvas.style.width = `${boxW / dpr}px`;
  canvas.style.height = `${boxH / dpr}px`;
  // centred inside the safe area, on offsets that are whole quanta (exact device pixels)
  const snap = (v) => Math.max(0, Math.round(v / q) * q);
  const left = snap(vp.inset.left * dpr + (availW - boxW) / 2);
  const top = snap(vp.inset.top * dpr + (availH - boxH) / 2);
  canvas.style.left = `${left / dpr}px`;
  canvas.style.top = `${top / dpr}px`;
  Object.assign(fitState, { scale: s.scale, exact: s.exact, devW: s.devW, devH: s.devH, dpr, left, top, boxW, boxH, ox: Math.floor((boxW - s.devW) / 2), oy: Math.floor((boxH - s.devH) / 2), quantum: q });
}

// ---------------------------------------------------------------- data feed
const feed = { latest: null, lastAt: 0, es: null, poll: null, everData: false, failed: false, t0: performance.now() };
function apiUrl(path, extra) {
  const q = new URLSearchParams(extra || {});
  if (!PUBLIC) q.set('public', '0');
  if (SAMPLE) q.set('sample', '1');
  // ?sample=1&at=<unix seconds> plays the sample from a fixed moment (screenshots that need every role)
  if (SAMPLE && Number.isFinite(SAMPLE_AT) && SAMPLE_AT > 0 && path !== '/api/replay') q.set('at', String(Math.floor(SAMPLE_AT + (performance.now() - feed.t0) / 1000)));
  const s = q.toString();
  return path + (s ? `?${s}` : '');
}
const looksLikeState = (s) => s && typeof s === 'object' && !Array.isArray(s) && ('agents' in s || 'queue' in s || 'slots' in s);

function receive(s, via) {
  if (!looksLikeState(s)) return;
  if (via === 'stream' && feed.poll) {
    clearInterval(feed.poll);
    feed.poll = null;
  }
  const first = !feed.everData;
  feed.latest = s;
  feed.lastAt = performance.now();
  feed.everData = true;
  feed.failed = false;
  if (!replay.active) {
    applyState(world, s, { first });
    noteScene(first);
  }
}

function connect() {
  if (POLL || (SAMPLE && Number.isFinite(SAMPLE_AT) && SAMPLE_AT > 0)) return startPolling();
  if ('EventSource' in window) {
    try {
      const es = new EventSource(apiUrl('/api/stream'));
      feed.es = es;
      es.onmessage = (ev) => {
        try {
          receive(JSON.parse(ev.data), 'stream');
        } catch {
          /* skip a malformed frame */
        }
      };
      es.onerror = () => {
        if (performance.now() - feed.lastAt > 5000) startPolling();
      };
    } catch {
      startPolling();
    }
  } else startPolling();
  setTimeout(() => {
    if (!feed.everData) startPolling();
  }, 3000);
}

function startPolling() {
  if (feed.poll) return;
  const tick = async () => {
    try {
      const r = await fetch(apiUrl('/api/state'), { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      receive(await r.json(), 'poll');
    } catch {
      feed.failed = true;
    }
  };
  tick();
  feed.poll = setInterval(tick, 2000);
}

const offline = () => !replay.active && (!feed.everData ? feed.failed : performance.now() - feed.lastAt > 9000);

// ---------------------------------------------------------------- time-lapse
const replay = { active: false, frames: [], from: 0, to: 0, t0: 0, dur: 1, idx: -1, purpose: 'view', endedAt: 0, speed: 1 };

/** Fetch a time-lapse: { hours } for the last N hours, or { from, to } (ISO) for a past window. */
async function fetchReplay(win, frames) {
  const q = win.from ? { from: win.from, to: win.to, frames: String(frames) } : { hours: String(win.hours || 8), frames: String(frames) };
  const r = await fetch(apiUrl('/api/replay', q), { cache: 'no-store' });
  if (!r.ok) throw new Error(`the server answered HTTP ${r.status}${r.status === 400 ? `: ${(await r.json().catch(() => ({}))).error || ''}` : ''}`);
  const data = await r.json();
  if (!data || !Array.isArray(data.frames) || data.frames.length < 2) throw new Error('the server returned no time-lapse frames');
  return data;
}

function startReplay(data, durSec, delaySec = 0, purpose = 'view') {
  const frames = data.frames.map((f) => ({ ms: Date.parse(f && f.now), f })).filter((x) => Number.isFinite(x.ms)).sort((a, b) => a.ms - b.ms);
  if (frames.length < 2) throw new Error('the time-lapse has no usable frames');
  replay.data = data;
  replay.frames = frames;
  replay.from = Date.parse(data.from) || frames[0].ms;
  replay.to = Date.parse(data.to) || frames[frames.length - 1].ms;
  replay.t0 = performance.now() + delaySec * 1000;
  replay.dur = Math.max(1, durSec) * 1000;
  replay.idx = 0;
  replay.purpose = purpose;
  replay.endedAt = 0;
  replay.active = true;
  replay.speed = 2.5;
  resetWorld(world);
  applyState(world, frames[0].f, { first: true });
}

/** The replayed clock (ms) right now, or null when no time-lapse plays. */
function replayClock(now = performance.now()) {
  if (!replay.active) return null;
  const p = Math.min(1, Math.max(0, (now - replay.t0) / replay.dur));
  return replay.from + p * (replay.to - replay.from);
}

function tickReplay(now) {
  if (!replay.active) return;
  const sim = replayClock(now);
  let steps = 0;
  while (replay.idx + 1 < replay.frames.length && replay.frames[replay.idx + 1].ms <= sim && steps < 30) {
    replay.idx += 1;
    steps += 1;
    applyState(world, replay.frames[replay.idx].f);
  }
  if (sim >= replay.to && !replay.endedAt) replay.endedAt = now;
  if (replay.endedAt && replay.purpose === 'view' && now - replay.endedAt > 4000) {
    // view mode loops: hold the end for a moment, then play the window again
    startReplay(replay.data, replay.dur / 1000, 0, 'view');
  }
  if (replay.endedAt && replay.purpose === 'once' && now - replay.endedAt > 2500) stopReplay();
}

function stopReplay() {
  if (!replay.active) return;
  replay.active = false;
  replay.speed = 1;
  resetWorld(world);
  if (feed.latest) applyState(world, feed.latest, { first: true });
}

const clockFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });

// ---------------------------------------------------------------- words outside the canvas
const srEl = $('sr');
let lastLabel = '';
let lastLabelAt = 0;
let lastAnnounce = 0;
const announced = new Set();
function noteScene(first) {
  const sc = world.scene;
  if (!sc) return;
  const now = performance.now();
  if (now - lastLabelAt > 5000) {
    const label = `Pixel-art stage of AI agents at work. ${describeScene(sc)}`;
    if (label !== lastLabel) canvas.setAttribute('aria-label', label);
    lastLabel = label;
    lastLabelAt = now;
  }
  for (const ev of sc.events) {
    if (announced.has(ev.id)) continue;
    announced.add(ev.id);
    if (first || replay.active || now - lastAnnounce < 5000 || !srEl) continue;
    const where = ev.lane ? `Lane ${ev.lane}` : 'A job';
    const said = { merged: `${where} merged.`, bounced: `${where} bounced back.`, done: `${where} finished a run.`, stopped: `${where} stopped a run.`, pushed: 'Work was pushed to the remote.' }[ev.type];
    if (!said) continue;
    srEl.textContent = said;
    lastAnnounce = now;
  }
  if (PROBE) writeProbe();
}

function writeProbe() {
  const el = $('probe');
  if (el && world.scene) el.textContent = JSON.stringify(probe());
}
/** QA probe: what the stage draws, in state terms, so it can be compared with /api/state. */
function probe() {
  const sc = world.scene;
  return {
    aspect: world.aspect,
    output: [out.width, out.height],
    rows: sc ? sc.rowIds : [],
    stations: world.layout.rows.map((r) => ({ id: r.id, n: r.n, tags: r.stations.map((s) => s.tag) })),
    perRow: Boolean(world.layout.perRow),
    agents: [...world.agents.values()].filter((e) => e.state !== 'out').map((e) => ({ id: e.id, role: e.role, kind: e.kind, place: e.place, row: e.row, station: e.station, x: Math.round(e.x), y: Math.round(e.y), walking: Boolean(e.walking) })),
    belt: sc ? sc.belt.map((e) => e.slug) : [],
    window: sc ? sc.window.map((e) => e.slug) : [],
    pods: (world.pods || []).map((p) => p.label || null),
    lock: world.lockLabel || null,
    lanes: (world.lanes || []).filter((l) => l.active || l.waiting).map((l) => l.id),
    controller: rd.readout || null,
    big: Boolean(world.layout.big),
    ts: world.layout.ts || 1,
    fit: { ...fitState, css: [window.innerWidth, window.innerHeight], safe: viewport().inset },
    sample: sc ? sc.sample : false,
    replayClock: replayClock(),
  };
}

// ---------------------------------------------------------------- loop
const perf = { frames: 0, maxGap: 0, gaps50: 0 };
const stage = { recording: false, cards: null };

function render(now, toOutput = stage.recording) {
  const clockMs = replayClock(now);
  const f = renderFrame(rd, world, {
    sample: Boolean(world.scene?.sample) || SAMPLE,
    timelapse: replay.active,
    offline: offline(),
    speed: replay.active ? replay.speed : 1,
    clock: clockMs !== null ? clockFormat.format(new Date(clockMs)) : null,
  });
  if (stage.cards) stage.cards(f, now, world.t, drawCard);
  if (small.width !== f.w || small.height !== f.h) setupCanvas();
  toRGBA(f, image.data);
  sctx.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = false;
  if (fitState.ox > 0 || fitState.oy > 0) {
    ctx.fillStyle = '#06060d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(small, fitState.ox, fitState.oy, fitState.devW || canvas.width, fitState.devH || canvas.height);
  if (toOutput) {
    octx.imageSmoothingEnabled = false;
    octx.drawImage(small, 0, 0, out.width, out.height);
  }
}

let last = performance.now();
function loop(now) {
  const gap = now - last;
  if (gap > perf.maxGap) perf.maxGap = gap;
  if (gap > 50) perf.gaps50 += 1;
  const dt = Math.min(0.1, Math.max(0, gap / 1000));
  last = now;
  tickReplay(now);
  // the stage clock always runs; ?calm=1 runs it at half speed (softer, never frozen)
  step(world, dt * (SOFT ? 0.5 : 1), replay.active ? replay.speed : 1);
  render(now);
  perf.frames += 1;
  if (PROBE && perf.frames % 30 === 0) writeProbe();
  if (stage.onFrame) stage.onFrame(now);
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- start
window.addEventListener('resize', () => {
  if (!pinnedAspect && !stage.recording) {
    const vp = viewport();
    const a = aspectForWindow(vp.w, vp.h);
    if (a !== world.aspect || wantBig() !== world.big) {
      setAspect(world, a, wantBig());
      setupCanvas();
    }
  }
  fit();
});
// phones: rotating changes the shape; some browsers report the new size only after the rotation ends
window.addEventListener('orientationchange', () => setTimeout(() => window.dispatchEvent(new Event('resize')), 250));
setupCanvas();
connect();
const windowParam = params.get('replay');
const hoursParam = params.get('timelapse');
if (windowParam || hoursParam) {
  // ?replay=<from>,<to>&duration=45 (a past window, looping) or ?timelapse=8 (the last 8 hours, once)
  const [from, to] = String(windowParam || '').split(',');
  const dur = Math.min(600, Math.max(5, Number(params.get('duration')) || 45));
  const frames = Math.min(900, Math.max(60, Math.round(dur * 14)));
  const wait = setInterval(async () => {
    if (!feed.everData && !feed.failed) return;
    clearInterval(wait);
    try {
      const data = await fetchReplay(windowParam ? { from, to } : { hours: Number(hoursParam) || 8 }, frames);
      startReplay(data, dur, 0, windowParam ? 'view' : 'once');
    } catch (err) {
      const el = $('stage-error');
      if (el) {
        el.hidden = false;
        el.textContent = `Time-lapse unavailable: ${err && err.message ? err.message : err}`;
      }
    }
  }, 250);
}
requestAnimationFrame(loop);

/**
 * QA hook: watch the stage for `seconds` and report whether it keeps moving: how many sampled frames
 * differ from the one before, the largest gap between loop frames, and the motion settings in force.
 */
function motionProbe(seconds = 10, everyMs = 250) {
  const hash = () => {
    let h = 2166136261;
    const d = image.data;
    for (let i = 0; i < d.length; i += 4 * 7) h = Math.imul(h ^ d[i] ^ (d[i + 1] << 8) ^ (d[i + 2] << 16), 16777619);
    return h >>> 0;
  };
  return new Promise((resolve) => {
    const hashes = [];
    perf.maxGap = 0;
    perf.gaps50 = 0;
    const f0 = perf.frames;
    const t0 = performance.now();
    const timer = setInterval(() => {
      hashes.push(hash());
      if (performance.now() - t0 >= seconds * 1000) {
        clearInterval(timer);
        let changed = 0;
        for (let i = 1; i < hashes.length; i += 1) if (hashes[i] !== hashes[i - 1]) changed += 1;
        resolve({
          samples: hashes.length,
          changed,
          distinct: new Set(hashes).size,
          loopFrames: perf.frames - f0,
          fps: Math.round(((perf.frames - f0) / ((performance.now() - t0) / 1000)) * 10) / 10,
          maxFrameGapMs: Math.round(perf.maxGap),
          gapsOver50ms: perf.gaps50,
          soft: SOFT,
          reducedMotion: Boolean(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches),
          agents: world.agents.size,
        });
      }
    }, everyMs);
  });
}

// The stage API used by QA and by hd-recorder.mjs (loaded only by tools/render-video.mjs).
Object.assign(stage, { out, world, replay, feed, render, fetchReplay, startReplay, stopReplay, replayClock, setAspect: (a) => {
  setAspect(world, normAspect(a));
  setupCanvas();
} });
window.__theater = { world, replay, feed, render, probe, motionProbe, stage };
