// Agent Theater HD · hd-controller.mjs
// The CONTROLLER (top left): a layered control unit with an engraved nameplate, a main LCD (done of
// total, a progress bar and the percentage), a lane monitor, a lane matrix (one gauge per pipeline lane,
// filled by its progress), an activity ring with the number of agents working now in its centre, a
// second counter and a third readout, vents and a beacon. The LCD words come from the state (for example
// RUNS, AGENTS, LIVE). Every number comes from the state; when the state has none the LCD shows dashes. The controller bus leaves
// its bottom left for the lane chips. Next to it (under it on the phone layout) is the dock, a catwalk
// where side agents (verifiers, helpers, lane roles without a visible lane) stand. Pure.
//
// Two builds of the same unit: UNIT (236x46) for the 16:9, 1:1 and 4:5 stages, and STRIP (528x52), the
// full-width phone build for 9:16, whose numbers are drawn with the 5x7 font at twice its size so they
// stay legible on a phone.
import { textWidth } from './hd-font.mjs';
import { dot, glow, hline, rect, shadeRect, text, vline } from './hd-gfx.mjs';
import { R, laneColours } from './hd-palette.mjs';
import { createMask, mrect, mround, shadeMask } from './hd-shade.mjs';
import { MACHINE } from './hd-stations.mjs';

const memo = new Map();
const once = (k, make) => {
  if (!memo.has(k)) memo.set(k, make());
  return memo.get(k);
};

/** Local geometry of each build. LCDs: x, y, w, h of the glass; ts is the text scale of the numbers. */
export const CTRL_GEOMS = Object.freeze({
  unit: {
    w: 236,
    h: 46,
    panels: [['G', 4, 10, 60, 34], ['n', 64, 12, 36, 30], ['n', 102, 12, 52, 30], ['G', 156, 11, 60, 32]],
    screen: { x: 8, y: 14, w: 52, h: 26 },
    matrix: { x: 66, rows: [15, 29], gh: 11 },
    ring: { x: 128, y: 27, rIn: 9.6, rOut: 12.4, ts: 1 },
    jobs: { x: 70, y: 2, w: 144, h: 9, ts: 1 },
    feat: { x: 158, y: 13, w: 56, h: 18, ts: 1, stack: true },
    batch: { x: 158, y: 31, w: 56, h: 10, ts: 1 },
    divider: { x: 161, y: 31, w: 50 },
    vents: { x: 218, y: 10, w: 16, h: 32 },
    rivets: [[3, 12], [3, 40], [100, 12], [100, 40], [152, 13], [152, 40], [62, 12]],
    glands: [10, 30, 120],
  },
  strip: {
    w: 528,
    h: 52,
    lts: 2, // the phone held upright has room for the LCD captions at twice the size too
    panels: [['G', 4, 12, 60, 34], ['n', 66, 13, 36, 32], ['n', 104, 11, 46, 38], ['G', 152, 9, 358, 20], ['G', 152, 29, 224, 20], ['G', 378, 29, 132, 20]],
    screen: { x: 8, y: 16, w: 52, h: 26 },
    matrix: { x: 68, rows: [16, 31], gh: 11 },
    ring: { x: 127, y: 30, rIn: 13.6, rOut: 16.4, ts: 2 },
    jobs: { x: 154, y: 11, w: 354, h: 16, ts: 2 },
    feat: { x: 154, y: 31, w: 220, h: 16, ts: 2 },
    batch: { x: 380, y: 31, w: 128, h: 16, ts: 2 },
    divider: null,
    vents: { x: 512, y: 10, w: 14, h: 40 },
    rivets: [[3, 14], [3, 46], [64, 14], [102, 13], [102, 46], [150, 13], [150, 46]],
    glands: [10, 30, 120, 300],
  },
  stripS: {
    w: 400,
    h: 52,
    panels: [['G', 4, 12, 60, 34], ['n', 66, 13, 36, 32], ['n', 104, 11, 46, 38], ['G', 152, 9, 230, 20], ['G', 152, 29, 146, 20], ['G', 300, 29, 82, 20]],
    screen: { x: 8, y: 16, w: 52, h: 26 },
    matrix: { x: 68, rows: [16, 31], gh: 11 },
    ring: { x: 127, y: 30, rIn: 13.6, rOut: 16.4, ts: 2 },
    jobs: { x: 154, y: 11, w: 226, h: 16, ts: 2 },
    feat: { x: 154, y: 31, w: 142, h: 16, ts: 2 },
    batch: { x: 302, y: 31, w: 78, h: 16, ts: 2 },
    divider: null,
    vents: { x: 384, y: 10, w: 14, h: 40 },
    rivets: [[3, 14], [3, 46], [64, 14], [102, 13], [102, 46], [150, 13], [150, 46]],
    glands: [10, 30, 120, 300],
  },
});

/** The build for a layout's controller box (its kind, or by width for older layouts). */
export const geomFor = (ctrl) => CTRL_GEOMS[ctrl?.kind] || (ctrl && ctrl.w >= CTRL_GEOMS.strip.w ? CTRL_GEOMS.strip : CTRL_GEOMS.unit);

function ctrlMask(G) {
  const { w, h } = G;
  const k = createMask(w, h);
  mround(k, 0, 2, w, h - 2, 3, 'g'); // housing
  for (const [m, x, y, pw, ph] of G.panels) mrect(k, x, y, pw, ph, m);
  mrect(k, G.screen.x, G.screen.y, G.screen.w, G.screen.h, 'w');
  for (const b of [G.jobs, G.feat, G.batch]) mrect(k, b.x, b.y, b.w, b.h, 'w');
  mrect(k, G.vents.x, G.vents.y, G.vents.w, G.vents.h, 'G'); // vent column
  mrect(k, w - 16, 0, 12, 8, 'G'); // beacon block
  mrect(k, 2, 0, 64, 9, 'S'); // nameplate
  if (G === CTRL_GEOMS.unit) {
    mrect(k, G.jobs.x - 2, G.jobs.y - 2, G.jobs.w + 4, G.jobs.h + 4, 'G');
    mrect(k, G.jobs.x, G.jobs.y, G.jobs.w, G.jobs.h, 'w');
  }
  return k;
}

export function controllerBody(G = CTRL_GEOMS.unit) {
  return once(`ctrl:${G.w}x${G.h}`, () => {
    // (each build has its own size, so the size names the cached body)
    const { w, h } = G;
    const s = shadeMask(ctrlMask(G), { ...MACHINE, S: { ...MACHINE.S, base: 2, bevel: 2 } });
    const set = (x, y, c) => {
      if (x >= 0 && y >= 0 && x < s.w && y < s.h && s.data[y * s.w + x] >= 0) s.data[y * s.w + x] = c;
    };
    // LCD glass: a darker field than the monitor so the digits stand out
    for (const b of [G.jobs, G.feat, G.batch]) for (let y = b.y; y < b.y + b.h; y += 1) for (let x = b.x; x < b.x + b.w; x += 1) set(x, y, R.void[1]);
    // vents
    for (let y = G.vents.y + 3; y < G.vents.y + G.vents.h - 2; y += 3) for (let x = G.vents.x + 2; x < G.vents.x + G.vents.w - 2; x += 1) set(x, y, R.void[0]);
    for (const [x, y] of G.rivets) {
      set(x, y, R.steel[2]);
      set(x, y + 1, R.gun[1]);
    }
    // lane gauge tracks
    for (const ry of G.matrix.rows) for (let c = 0; c < 8; c += 1) {
      const x = G.matrix.x + c * 4;
      for (let yy = -1; yy <= G.matrix.gh; yy += 1) for (let xx = -1; xx <= 3; xx += 1) set(x + xx, ry + yy, xx < 0 || yy < 0 ? R.panel[0] : xx === 3 || yy === G.matrix.gh ? R.panel[3] : R.void[1]);
    }
    // ring gauge bezel with an anti-aliased outer edge and a dark dial for the digits
    const { x: rx, y: ry, rIn, rOut } = G.ring;
    const span = Math.ceil(rOut + 2);
    for (let dy = -span; dy <= span; dy += 1) for (let dx = -span; dx <= span; dx += 1) {
      const d = Math.hypot(dx, dy);
      if (d <= rIn) set(rx + dx, ry + dy, R.void[1]);
      else if (d <= rOut) set(rx + dx, ry + dy, R.glass[0]);
      else if (d <= rOut + 0.9) set(rx + dx, ry + dy, dx + dy < 0 ? R.steel[2] : R.gun[1]);
      else if (d <= rOut + 1.5) set(rx + dx, ry + dy, dx + dy < 0 ? R.panel[3] : R.panel[1]);
    }
    // screen scanlines baked in
    const sc = G.screen;
    for (let y = sc.y + 1; y < sc.y + sc.h; y += 2) for (let x = sc.x; x < sc.x + sc.w; x += 1) set(x, y, R.glass[0]);
    // the readout's divider between features and batch (the unit's shared glass)
    if (G.divider) for (let x = G.divider.x; x < G.divider.x + G.divider.w; x += 2) set(x, G.divider.y, R.glass[1]);
    // cable glands on the bottom
    for (const x of G.glands) {
      set(x, h - 1, R.steel[1]);
      set(x + 1, h - 1, R.steel[1]);
    }
    return s;
  });
}

/** LCD words when the state names none. */
export const LCD_LABELS = Object.freeze({ jobs: 'JOBS', features: 'FEATURES', batch: 'BATCH' });
const GAUGES = 16;

const busyKind = (k) => k !== 'think' && k !== 'wait';
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/**
 * The numbers the controller shows, from the world's project and batch (null fields show dashes).
 *   jobs: "done/total", pct: "NN%" (floored, so 100% only when every job is done), fraction 0..1;
 *   agents: agents working now (on stage); features: "done/total" of the tracked features;
 *   batch: the running merge batch number, or with release trains the machine's release (project.release).
 */
export function controllerReadout({ project = null, agents = 0, batch = null } = {}) {
  const release = typeof project?.release === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9.]{1,12})?$/i.test(project.release) ? project.release.slice(0, 12) : null;
  const done = count(project?.done);
  const total = count(project?.total);
  const ok = done !== null && total !== null && total > 0;
  const fd = count(project?.features?.done);
  const ft = count(project?.features?.total);
  const fok = fd !== null && ft !== null && ft > 0;
  const n = count(batch);
  return {
    jobs: ok ? `${Math.min(done, total)}/${total}` : '--/--',
    pct: ok ? `${Math.floor((100 * Math.min(done, total)) / total)}%` : '--%',
    fraction: ok ? Math.min(1, done / total) : null,
    agents: Math.min(99, Math.max(0, agents | 0)),
    features: fok ? `${Math.min(fd, ft)}/${ft}` : '--/--',
    batch: release || (n !== null && n > 0 ? String(n) : '-'),
  };
}

/** A label (dim, lts x) and a value (ts x) on one LCD line; the label sits on the value's baseline. */
function lcdLine(f, x, y, h, label, value, ts, col, top, right = null, lts = 1) {
  const vy = y + Math.floor((h - 7 * ts) / 2);
  const ly = vy + 7 * ts - 7 * lts;
  const lw = label ? text(f, label, x, ly, R.steel[0], { scale: lts }) : 0;
  const vx = right !== null ? right - textWidth(value, 1, ts) : x + (label ? lw + 4 + 2 * ts : 0);
  const vw = text(f, value, vx, vy, col, { top, topRows: ts, scale: ts });
  return { lw, vx, vw, vy };
}

/**
 * Per-frame controller:
 *   - the main LCD: its word (JOBS, RUNS...) with done/total, a progress bar and the percentage;
 *   - the lane monitor: one bar per lane row, a light at each station where an agent works;
 *   - the lane matrix: one gauge per pipeline lane (up to 16, in order), filled by its progress, in the
 *     lane hue while the lane is active (its top blinks while someone there is busy), amber while it
 *     waits, mint when it has completed;
 *   - the activity ring: the number of agents working now in its centre, one lit segment per agent
 *     (bright while it works, dim while it thinks or waits) and a sweep whose speed follows them;
 *   - the readout: FEATURES done/total and the running merge BATCH number;
 *   - the beacon: it blinks when new events arrive.
 * agents: [{ row, station, kind, lane, place }]; lanes: [{ id, active, waiting, completed, done, total }];
 * project: { done, total, features: { done, total } }; batch: running batch number or null.
 * Returns the readout it drew.
 */
export function drawController(f, L, { rows = [], hues, agents = [], lanes = [], project = null, batch = null, labels = null, t = 0, calm = false, events = 0 } = {}) {
  const words = { ...LCD_LABELS, ...(labels || {}) };
  const c = L.ctrl;
  const G = geomFor(c);
  const ox = c.x;
  const oy = c.y;
  shadeRect(f, ox + 4, oy + G.h, G.w, 3, 1);
  const body = controllerBody(G);
  for (let r = 0; r < body.h; r += 1) for (let i = 0; i < body.w; i += 1) {
    const v = body.data[r * body.w + i];
    if (v >= 0) f.px[(oy + r) * f.w + ox + i] = v;
  }
  text(f, 'CONTROLLER', ox + 4, oy + 1, R.gun[1], { top: R.gun[0] });
  const out = controllerReadout({ project, agents: agents.length, batch });
  // jobs LCD: label, fraction, progress bar, percentage
  {
    const J = G.jobs;
    const ts = J.ts;
    const x0 = ox + J.x + 2 + (ts - 1);
    const x1 = ox + J.x + J.w - 2 - (ts - 1);
    const a = lcdLine(f, x0, oy + J.y, J.h, words.jobs, out.jobs, ts, R.cyan[4], R.cyan[5], null, G.lts || 1);
    const p = lcdLine(f, x0, oy + J.y, J.h, '', out.pct, ts, R.cyan[3], R.cyan[4], x1);
    const bx = a.vx + a.vw + 3 + 2 * ts;
    const bw = p.vx - 3 - 2 * ts - bx;
    const bh = 1 + 2 * ts;
    const by = a.vy + Math.floor((7 * ts - bh) / 2);
    if (bw >= 8) {
      rect(f, bx, by, bw, bh, R.glass[1]);
      if (out.fraction !== null) {
        const fill = Math.round(bw * out.fraction);
        if (fill > 0) {
          rect(f, bx, by, fill, bh, R.cyan[2]);
          hline(f, bx, by, fill, R.cyan[4]);
        }
      }
      for (let x = bx + 4; x < bx + bw; x += 5) dot(f, x, by + bh, R.glass[2]); // scale ticks
    }
  }
  // lane monitor
  const SC = G.screen;
  const sx = ox + SC.x + 2;
  const sy = oy + SC.y + 2;
  const n = Math.max(1, rows.length);
  const pitch = Math.max(2, Math.floor((SC.h - 4) / n));
  rows.forEach((row, i) => {
    const hue = laneColours(hues.get(row.id));
    const y = sy + i * pitch;
    const ns = Math.max(1, row.n || 5);
    const sp = ns > 1 ? Math.min(10, Math.floor((SC.w - 10) / (ns - 1))) : 0;
    hline(f, sx, y, SC.w - 4, hue.dark);
    for (let s = 1; s < ns; s += 1) dot(f, sx + s * sp, y, R.glass[2]);
    for (const a of agents) if (a.row === row.id && a.station !== null && a.station !== undefined) {
      const x = sx + 2 + Math.min(a.station, ns - 1) * sp;
      const on = !busyKind(a.kind) || calm || Math.floor(t * 4 + a.station) % 3 !== 0;
      rect(f, x, y - (pitch > 2 ? 1 : 0), 4, pitch > 2 ? 2 : 1, on ? hue.top : hue.mid);
    }
  });
  if (!calm) {
    const scan = sy - 2 + (Math.floor(t * 12) % SC.h);
    hline(f, ox + SC.x, scan, SC.w, R.glass[2]);
  }
  // lane matrix: one gauge per pipeline lane, filled by its progress
  for (let i = 0; i < GAUGES; i += 1) {
    const p = lanes[i] || null;
    const id = p ? p.id : null;
    const x = ox + G.matrix.x + (i % 8) * 4;
    const y = oy + G.matrix.rows[Math.floor(i / 8)];
    const gh = G.matrix.gh;
    const frac = p && count(p.done) !== null && count(p.total) ? Math.min(1, p.done / p.total) : 0;
    const fill = frac > 0 ? Math.max(1, Math.round(gh * frac)) : 0;
    const finished = frac >= 1 || Boolean(p && p.completed);
    let col = finished ? R.mint[2] : R.panel[3];
    let hi = finished ? R.mint[3] : R.panel[4];
    let cap = null;
    if (p && p.active) {
      const h = hues.has(id) ? laneColours(hues.get(id)) : laneColours(p.hue || 'jade');
      const busy = agents.some((a) => a.lane === id && busyKind(a.kind));
      col = h.mid;
      hi = busy && (calm || Math.floor(t * 2 + i) % 4) ? h.top : h.light;
      cap = h.light;
    } else if (p && p.waiting) {
      col = R.amber[2];
      hi = R.amber[3];
      cap = R.amber[3];
    }
    if (cap !== null) hline(f, x, y - 1, 3, cap); // the lamp over a live lane's gauge
    if (fill > 0) {
      rect(f, x, y + gh - fill, 3, fill, col);
      hline(f, x, y + gh - fill, 3, hi);
    } else if (p && (p.active || p.waiting || finished)) hline(f, x, y + gh - 1, 3, hi);
  }
  // activity ring: the agents working now; one segment per agent, a sweep while anyone works
  const RG = G.ring;
  const working = agents.filter((a) => busyKind(a.kind)).length;
  const lit = Math.min(12, agents.length);
  // the sweep never stops: slow and dim when nobody works, faster with every working agent
  const sweep = calm ? -1 : ((t * (working ? 0.25 + 0.08 * Math.min(working, 8) : 0.08)) % 1) * 12;
  const order = [...agents].sort((a, b) => Number(busyKind(b.kind)) - Number(busyKind(a.kind)));
  const span = Math.ceil(RG.rOut);
  for (let dy = -span; dy <= span; dy += 1) for (let dx = -span; dx <= span; dx += 1) {
    const d = Math.hypot(dx, dy);
    if (d > RG.rOut || d <= RG.rIn) continue;
    const a12 = ((Math.atan2(dx, -dy) / (Math.PI * 2) + 1) % 1) * 12;
    const seg = Math.floor(a12);
    if (a12 - seg > 0.82) continue; // a dark gap between segments
    let col = R.glass[1];
    if (seg < lit) col = busyKind(order[seg].kind) ? (d > RG.rOut - 1.2 ? R.cyan[3] : R.cyan[2]) : R.cyan[1];
    if (sweep >= 0 && Math.abs(a12 - sweep) < 0.5) col = working ? R.cyan[5] : R.cyan[2];
    dot(f, ox + RG.x + dx, oy + RG.y + dy, col);
  }
  // the count in the dial
  {
    const s = String(out.agents);
    const w = textWidth(s, 1, RG.ts);
    const tx = ox + RG.x - Math.floor(w / 2);
    const ty = oy + RG.y - Math.floor((7 * RG.ts) / 2);
    text(f, s, tx, ty, agents.length ? R.cyan[4] : R.steel[0], { top: agents.length ? R.cyan[5] : null, topRows: RG.ts, scale: RG.ts });
  }
  // readout: FEATURES done/total, then BATCH n
  {
    const F = G.feat;
    if (F.stack) {
      const cx = ox + F.x + F.w / 2;
      text(f, words.features, Math.round(cx - textWidth(words.features) / 2), oy + F.y + 1, R.steel[0]);
      text(f, out.features, Math.round(cx - textWidth(out.features) / 2), oy + F.y + 10, R.mint[3], { top: R.mint[4], topRows: 1 });
    } else lcdLine(f, ox + F.x + 3, oy + F.y, F.h, words.features, out.features, F.ts, R.mint[3], R.mint[4], null, G.lts || 1);
    const B = G.batch;
    const idle = out.batch === '-';
    const lts = G.lts || 1;
    const label = textWidth(words.batch, 1, lts) + 4 + 2 * B.ts + textWidth(out.batch, 1, B.ts) <= B.w - 6 ? words.batch : words.batch.slice(0, 1);
    const lineW = textWidth(label, 1, lts) + 4 + 2 * B.ts + textWidth(out.batch, 1, B.ts);
    const bx = B.ts === 1 ? Math.round(ox + B.x + (B.w - lineW) / 2) : ox + B.x + 3;
    lcdLine(f, bx, oy + B.y, B.h, label, out.batch, B.ts, idle ? R.steel[0] : R.amber[4], idle ? null : R.amber[5], null, lts);
  }
  // beacon on the roof: blinks when events arrive
  const bx = ox + G.w - 15;
  const by = oy + 1;
  const ev = events > 0;
  rect(f, bx, by, 6, 5, ev ? R.cyan[4] : R.cyan[1]);
  dot(f, bx + 1, by + 1, ev ? R.cyan[5] : R.cyan[2]);
  if (ev) glow(f, bx + 3, by + 2, [4, 7], 'cyan', { levels: [1, 0] });
  return out;
}

/**
 * The dock: a catwalk with a railing and floor lamps along the top of the bay. Beside the controller
 * a cable runs from the unit to the catwalk; under it (the phone layout) the bus feeds it from above.
 */
export function drawDock(f, L) {
  const d = L.dock;
  const y = d.y;
  if (d.x > L.ctrl.x + L.ctrl.w) {
    // cable from the controller to the catwalk
    rect(f, L.ctrl.x + L.ctrl.w, y - 12, d.x - L.ctrl.x - L.ctrl.w + 2, 3, R.gun[1]);
    hline(f, L.ctrl.x + L.ctrl.w, y - 12, d.x - L.ctrl.x - L.ctrl.w + 2, R.gun[3]);
  }
  // railing behind the agents
  hline(f, d.x, y - 22, d.x1 - d.x, R.gun[3]);
  hline(f, d.x, y - 21, d.x1 - d.x, R.gun[1]);
  hline(f, d.x, y - 12, d.x1 - d.x, R.gun[2]);
  for (let x = d.x; x <= d.x1; x += 24) {
    vline(f, x, y - 22, 22, R.gun[2]);
    vline(f, x + 1, y - 22, 22, R.gun[0]);
  }
  // catwalk floor: grating with a lit edge
  rect(f, d.x - 4, y, d.x1 - d.x + 8, 6, R.gun[2]);
  hline(f, d.x - 4, y, d.x1 - d.x + 8, R.gun[4]);
  for (let x = d.x - 2; x < d.x1 + 4; x += 3) vline(f, x, y + 2, 3, R.gun[1]);
  hline(f, d.x - 4, y + 5, d.x1 - d.x + 8, R.gun[0]);
  shadeRect(f, d.x - 4, y + 6, d.x1 - d.x + 8, 2, 1);
  // floor lamps along the catwalk edge
  for (let x = d.x + 10; x < d.x1; x += 48) dot(f, x, y + 1, R.cyan[2]);
}
