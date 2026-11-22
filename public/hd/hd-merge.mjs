// Agent Theater HD · hd-merge.mjs
// The queue column (a roller conveyor with riveted rails that bends into a chute), the data parcels it
// carries, and the MERGE machine: a riveted press housing with an inspection window holding the batch,
// twin hydraulic rams, a light tower, a progress gauge, a turning gear, heat vents, an intake funnel and
// the outlet towards develop. Static bodies are shaded once into sprites; lights, rams, gear, window
// light and gauge are drawn per frame from the machine state ('idle' | 'working' | 'pass' | 'fail').
// Pure.
import { dot, glow, hline, lightRect, rect, shadeRect, text, vline } from './hd-gfx.mjs';
import { R, laneColours } from './hd-palette.mjs';
import { MERGE_H, MERGE_W, PARCEL, mergeX, windowBox } from './hd-layout.mjs';
import { createMask, mrect, mround, shadeMask } from './hd-shade.mjs';
import { MACHINE } from './hd-stations.mjs';

const memo = new Map();
const once = (k, make) => {
  if (!memo.has(k)) memo.set(k, make());
  return memo.get(k);
};

// ---------------------------------------------------------------- parcels
/** A sealed data crate in its lane hue: lit top face, strapped front, label, metal corner caps. */
export function parcelSprite(hueName) {
  return once(`parcel:${hueName}`, () => {
    const hue = laneColours(hueName);
    const k = createMask(PARCEL.w, PARCEL.h);
    mrect(k, 0, 0, 16, 4, 't');
    mrect(k, 0, 4, 16, 8, 'f');
    const mats = {
      t: { ramp: hue.ramp, base: 3, bevel: 1, k: 1.6, steps: [1, 5] },
      f: { ramp: hue.ramp, base: 2, bevel: 2, k: 2, steps: [0, 3] },
    };
    const s = shadeMask(k, mats);
    const set = (x, y, c) => {
      s.data[y * s.w + x] = c;
    };
    // strap across top and front
    for (let y = 0; y < 12; y += 1) set(7, y, y < 4 ? R.gun[3] : R.gun[1]);
    for (let y = 0; y < 12; y += 1) set(8, y, y < 4 ? R.gun[4] : R.gun[2]);
    // label sticker on the front
    for (let y = 6; y < 9; y += 1) for (let x = 10; x < 14; x += 1) set(x, y, y === 6 ? R.steel[4] : R.steel[3]);
    set(11, 8, R.gun[3]);
    set(12, 8, R.gun[3]);
    // corner caps
    for (const [x, y] of [[0, 4], [15, 4], [0, 11], [15, 11]]) set(x, y, R.steel[0]);
    set(1, 4, R.steel[2]);
    // top edge glint
    set(2, 1, R.steel[4]);
    set(3, 1, hue.top);
    return s;
  });
}

// ---------------------------------------------------------------- queue column
/** Static rails, bed and the bend into the chute. */
export function drawQueueStatic(f, L) {
  const q = L.queue;
  const bot = q.y1;
  // drop shadow on the wall
  shadeRect(f, q.x + 3, q.y0 + 4, q.w, bot - q.y0, 1);
  // bed: a dark navy back plate seen between the rollers
  rect(f, q.x + 4, q.y0, q.w - 8, bot - q.y0, R.panel[0]);
  for (let y = q.y0 + 3; y < bot; y += 12) hline(f, q.x + 4, y, q.w - 8, R.void[0]);
  // rails
  for (const x of [q.x, q.x + q.w - 4]) {
    rect(f, x, q.y0, 4, bot - q.y0, R.gun[2]);
    vline(f, x, q.y0, bot - q.y0, R.gun[4]);
    vline(f, x + 1, q.y0, bot - q.y0, R.gun[3]);
    vline(f, x + 3, q.y0, bot - q.y0, R.gun[1]);
    for (let y = q.y0 + 6; y < bot - 4; y += 12) {
      dot(f, x + 1, y, R.steel[2]);
      dot(f, x + 2, y, R.gun[1]);
    }
  }
  // cap at the top: a hopper lip
  rect(f, q.x - 2, q.y0 - 6, q.w + 4, 6, R.gun[3]);
  hline(f, q.x - 2, q.y0 - 6, q.w + 4, R.steel[1]);
  hline(f, q.x - 1, q.y0 - 5, q.w + 2, R.gun[4]);
  hline(f, q.x - 2, q.y0 - 1, q.w + 4, R.gun[1]);
  for (let x = q.x + 2; x < q.x + q.w; x += 6) dot(f, x, q.y0 - 3, R.gun[1]);
  // the chute: horizontal run from the column into the machine intake
  const c = L.chute;
  shadeRect(f, c.x + 2, c.y + c.h, c.w, 3, 1);
  rect(f, c.x, c.y, c.w, c.h, R.panel[0]);
  for (const y of [c.y, c.y + c.h - 4]) {
    rect(f, c.x, y, c.w, 4, R.gun[2]);
    hline(f, c.x, y, c.w, R.gun[4]);
    hline(f, c.x, y + 1, c.w, R.gun[3]);
    hline(f, c.x, y + 3, c.w, R.gun[1]);
    for (let x = c.x + 8; x < c.x + c.w - 2; x += 12) {
      dot(f, x, y + 1, R.steel[2]);
      dot(f, x, y + 2, R.gun[1]);
    }
  }
  // the bend: the outer rail closes the corner (left when the chute runs right, right when it runs left)
  const bx = c.dir > 0 ? q.x : q.x + q.w - 4;
  rect(f, bx, c.y, 4, c.h, R.gun[2]);
  vline(f, bx, c.y, c.h, R.gun[4]);
  vline(f, bx + 3, c.y, c.h, R.gun[1]);
  rect(f, c.dir > 0 ? q.x : q.x + q.w - 8, c.y + c.h - 4, 8, 4, R.gun[2]);
  hline(f, c.dir > 0 ? q.x : q.x + q.w - 8, c.y + c.h - 1, 8, R.gun[1]);
  // the intake collar where the chute meets the machine
  const ix = c.dir > 0 ? c.x + c.w - 4 : c.x;
  rect(f, ix, c.y - 2, 4, c.h + 4, R.gun[3]);
  vline(f, ix, c.y - 2, c.h + 4, R.steel[1]);
  vline(f, ix + 3, c.y - 2, c.h + 4, R.gun[1]);
}

/** Lane feeders: a hatch on the column at each row's walkway, lit in the lane hue while a parcel passes. */
export function drawFeeders(f, L, rows, hues, activeRows) {
  for (const row of rows) {
    const hue = laneColours(hues.get(row.id));
    const y = row.deck - 8;
    const x = L.queue.x - 8;
    // the track's end plate joins the column
    rect(f, L.station.x1, row.deck, x - L.station.x1 + 2, 9, R.gun[2]);
    hline(f, L.station.x1, row.deck, x - L.station.x1 + 2, R.gun[4]);
    hline(f, L.station.x1, row.deck + 8, x - L.station.x1 + 2, R.gun[1]);
    rect(f, x, y, 10, 18, R.gun[3]);
    hline(f, x, y, 10, R.steel[1]);
    vline(f, x, y, 18, R.gun[4]);
    hline(f, x + 1, y + 17, 9, R.gun[1]);
    rect(f, x + 2, y + 3, 6, 8, R.void[0]);
    hline(f, x + 2, y + 3, 6, R.gun[1]);
    const lit = activeRows.has(row.id);
    rect(f, x + 3, y + 13, 4, 2, lit ? hue.light : R.gun[1]);
    if (lit) glow(f, x + 4, y + 13, [2, 4], hue.glow, { levels: [1, 0] });
  }
}

/** Rollers inside the column and chute (6 px pitch, lit top, shaded underside); phase scrolls them. */
export function drawRollers(f, L, phase) {
  const q = L.queue;
  const ph = ((Math.floor(phase) % 6) + 6) % 6;
  for (let y = q.y0 + ph; y < L.chute.y; y += 6) {
    hline(f, q.x + 4, y, q.w - 8, R.gun[3]);
    hline(f, q.x + 4, y + 1, q.w - 8, R.gun[2]);
    hline(f, q.x + 4, y + 2, q.w - 8, R.gun[1]);
    dot(f, q.x + 5, y, R.steel[1]);
    dot(f, q.x + q.w - 6, y + 2, R.void[0]);
  }
  const c = L.chute;
  for (let x = c.x + 4 + ph; x < c.x + c.w - 2; x += 6) {
    vline(f, x, c.y + 4, c.h - 8, R.gun[3]);
    vline(f, x + 1, c.y + 4, c.h - 8, R.gun[2]);
    vline(f, x + 2, c.y + 4, c.h - 8, R.gun[1]);
  }
}

// ---------------------------------------------------------------- the merge machine
// Local frame MW x MH at L.merge. In the stacked layouts (1:1, 4:5) the machine is mirrored: the
// mask is mirrored before shading, so its light still falls from the top left, and every detail is
// placed through a mirrored x.
const MW = MERGE_W;
const MH = MERGE_H;

function mergeMask() {
  const k = createMask(MW, MH);
  mrect(k, 4, 104, 148, 12, 'G');
  mrect(k, 8, 116, 12, 4, 'g');
  mrect(k, 136, 116, 12, 4, 'g');
  mround(k, 10, 34, 136, 72, 3, 'g');
  mround(k, 42, 16, 72, 24, 8, 'g');
  mrect(k, 50, 22, 56, 2, 'k');
  mround(k, 22, 10, 18, 26, 2, 'G');
  mround(k, 116, 10, 18, 26, 2, 'G');
  mrect(k, 24, 6, 14, 4, 'S');
  mrect(k, 118, 6, 14, 4, 'S');
  mrect(k, 16, 42, 30, 42, 'n');
  mrect(k, 110, 42, 30, 42, 'n');
  mround(k, 50, 40, 56, 44, 3, 'S');
  mrect(k, 54, 44, 48, 36, 'w');
  mrect(k, 56, 30, 44, 6, 'k');
  mrect(k, 18, 88, 36, 12, 'N');
  mrect(k, 102, 88, 36, 12, 'N');
  for (let y = 0; y < 26; y += 1) {
    const x0 = Math.max(0, 6 - Math.floor(y / 4));
    mrect(k, x0, 58 + y, 12 - x0, 1, 'G');
  }
  mrect(k, 144, 24, 12, 18, 'S');
  mrect(k, 139, 12, 3, 24, 'G');
  return k;
}

function mirrorMask(k) {
  const o = createMask(k.w, k.h);
  for (let y = 0; y < k.h; y += 1) for (let x = 0; x < k.w; x += 1) o.m[y * k.w + (k.w - 1 - x)] = k.m[y * k.w + x];
  return o;
}

export function mergeBody(flip = false) {
  return once(`merge:${flip}`, () => {
    const mask = flip ? mirrorMask(mergeMask()) : mergeMask();
    const s = shadeMask(mask, { ...MACHINE, g: { ...MACHINE.g, bevel: 3, base: 3, vgrad: [0.16, 0.2], brushed: true }, S: { ...MACHINE.S, bevel: 2, base: 2 }, n: { ...MACHINE.n, bevel: 3, base: 2 } });
    const fx = (x) => (flip ? MW - 1 - x : x);
    const set = (x, y, c) => {
      const xx = fx(x);
      if (xx >= 0 && y >= 0 && xx < s.w && y < s.h && s.data[y * s.w + xx] >= 0) s.data[y * s.w + xx] = c;
    };
    for (let y = 35; y < 104; y += 1) {
      set(48, y, R.gun[1]);
      set(108, y, R.gun[1]);
    }
    for (let x = 11; x < 145; x += 1) {
      set(x, 86, R.gun[1]);
      set(x, 87, R.gun[4]);
    }
    const rivet = (x, y) => {
      set(x, y, R.steel[2]);
      set(x + (flip ? -1 : 1), y, R.gun[2]);
      set(x, y + 1, R.gun[1]);
    };
    for (let x = 16; x < 142; x += 10) rivet(x, 101);
    for (let x = 14; x < 46; x += 8) rivet(x, 37);
    for (let x = 112; x < 144; x += 8) rivet(x, 37);
    for (let y = 44; y < 84; y += 10) {
      rivet(13, y);
      rivet(142, y);
    }
    for (const [x, y] of [[52, 42], [102, 42], [52, 80], [102, 80]]) rivet(x, y);
    for (let x = 50; x < 108; x += 8) rivet(x, 19);
    for (const rx of [22, 116]) {
      for (let y = 14; y < 32; y += 1) {
        set(rx + 6, y, R.void[0]);
        set(rx + 11, y, R.void[0]);
        set(rx + 7, y, R.gun[1]);
      }
      rivet(rx + 3, 30);
      rivet(rx + 14, 30);
    }
    const hose = (pts) => {
      for (let i = 0; i + 1 < pts.length; i += 1) {
        const [x0, y0] = pts[i];
        const [x1, y1] = pts[i + 1];
        const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
        for (let t = 0; t <= n; t += 1) {
          const x = Math.round(x0 + ((x1 - x0) * t) / n);
          const y = Math.round(y0 + ((y1 - y0) * t) / n);
          s.data[y * s.w + fx(x)] = R.gun[0];
          if (y + 1 < s.h) s.data[(y + 1) * s.w + fx(x)] = R.gun[2];
        }
      }
    };
    hose([[40, 15], [42, 13], [46, 13], [48, 16]]);
    hose([[108, 16], [110, 13], [114, 13], [116, 15]]);
    // window glass reflection: always from the top left of the glass
    const g0 = flip ? 101 : 54;
    const gd = flip ? -1 : 1;
    for (let i = 0; i < 10; i += 1) s.data[(45 + i) * s.w + (g0 + gd * (10 - i)) + (flip ? 0 : 0)] = R.glass[3];
    for (let i = 0; i < 6; i += 1) s.data[(45 + i) * s.w + (g0 + gd * (14 - i))] = R.glass[2];
    for (let x = 54; x < 102; x += 1) set(x, 44, R.gun[1]);
    for (let y = 44; y < 80; y += 1) s.data[y * s.w + (flip ? 101 : 54)] = R.gun[1];
    for (const vx of [18, 102]) for (let y = 90; y < 99; y += 3) for (let x = vx + 2; x < vx + 34; x += 1) set(x, y, R.void[0]);
    for (let y = 106; y < 114; y += 1) for (let x = 6; x < 150; x += 1) if (((x + y) >> 2) % 2 === 0) s.data[y * s.w + x] = y === 106 ? R.amber[4] : R.amber[3];
    for (let x = 6; x < 150; x += 1) s.data[114 * s.w + x] = R.gun[0];
    // gauge bezel with anti-aliased rim: the outermost ring blends into the panel
    for (let dy = -11; dy <= 11; dy += 1) for (let dx = -11; dx <= 11; dx += 1) {
      const d = Math.hypot(dx, dy);
      const lit = dx * (flip ? -1 : 1) + dy < -2;
      if (d <= 8.2) set(31 + dx, 58 + dy, d < 4.6 ? R.glass[2] : R.glass[1]);
      else if (d <= 9.6) set(31 + dx, 58 + dy, lit ? R.steel[3] : dx * (flip ? -1 : 1) + dy > 3 ? R.gun[1] : R.steel[1]);
      else if (d <= 10.4) set(31 + dx, 58 + dy, lit ? R.steel[1] : R.panel[1]);
    }
    for (let a = 0; a < 7; a += 1) {
      const ang = Math.PI * (0.8 + (a / 6) * 1.4);
      set(31 + Math.round(Math.cos(ang) * 7), 58 + Math.round(Math.sin(ang) * 7), a >= 5 ? R.amber[3] : R.steel[2]);
    }
    for (let i = 0; i < 3; i += 1) for (let x = 0; x < 6; x += 1) for (let y = 0; y < 4; y += 1) set(21 + i * 8 + x, 74 + y, y === 0 ? R.gun[4] : R.gun[2]);
    // gear housing: a dark cutout with a lit lower rim and an anti-aliased outer edge
    for (let dy = -15; dy <= 15; dy += 1) for (let dx = -15; dx <= 15; dx += 1) {
      const d = Math.hypot(dx, dy);
      if (d <= 13) set(125 + dx, 61 + dy, R.void[0]);
      else if (d <= 14.2) set(125 + dx, 61 + dy, dy < 0 ? R.gun[1] : R.gun[4]);
      else if (d <= 14.9) set(125 + dx, 61 + dy, dy < 0 ? R.panel[1] : R.panel[3]);
    }
    for (const [x, y] of [[146, 26], [153, 26], [146, 39], [153, 39]]) rivet(x, y);
    for (let y = 66; y < 80; y += 1) for (let x = 3; x < 12; x += 1) set(x, y, y < 68 ? R.gun[1] : R.void[0]);
    for (let i = 0; i < 4; i += 1) {
      set(74 + i, 25 + i, R.amber[3]);
      set(81 - i, 25 + i, R.amber[3]);
    }
    return s;
  });
}

/**
 * A gear of radius r with n teeth at angle a. Tooth tips and the rim get one in-between pixel
 * (cols.aa) where the shape only half covers a pixel: hand-style anti-aliasing on the curve.
 */
export function drawGear(f, cx, cy, r, teeth, angle, cols) {
  for (let dy = -r - 2; dy <= r + 2; dy += 1) for (let dx = -r - 2; dx <= r + 2; dx += 1) {
    const d = Math.hypot(dx, dy);
    const th = Math.atan2(dy, dx) - angle;
    const tv = Math.cos(th * teeth);
    let c = -1;
    if (d <= r - 0.5) {
      if (d < 2.5) c = cols.hub;
      else if (d < 4) c = cols.dark;
      else if (d > r - 3) c = cols.rim;
      else c = Math.abs(Math.sin(th * 2)) < 0.28 ? cols.mid : cols.dark;
      if ((c === cols.rim || c === cols.mid) && dx + dy < -r * 0.6) c = cols.light;
    } else if (d <= r + 1.6 && tv > 0.35) c = dx + dy < 0 ? cols.light : cols.mid;
    else if (cols.aa !== undefined && d <= r + 1.6 && tv > 0.05) c = cols.aa;
    else if (cols.aa !== undefined && d <= r + 0.2 && d > r - 0.5) c = cols.aa;
    if (c >= 0) dot(f, cx + dx, cy + dy, c);
  }
}

/**
 * Per-frame parts of the machine: rams, light tower, progress strip, gauge needle, status keys, gear,
 * clamp jaws, chamber light, vent heat and the batch counter. ms = { state, progress, t, calm, count }.
 */
export function drawMergeDynamic(f, L, ms) {
  const { state, progress = 0, t = 0, calm = false } = ms;
  const oy = L.merge.y;
  const X = (lx, w = 1) => mergeX(L, lx, w);
  const box = (lx, ly, w, h, c) => rect(f, X(lx, w), oy + ly, w, h, c);
  const pt = (lx, ly, c) => dot(f, X(lx), oy + ly, c);
  const working = state === 'working';
  for (const [rx, ph] of [[28, 0], [122, 3]]) {
    const ext = working && !calm ? Math.round((Math.sin(t * 5 + ph) + 1) * 2.5) : 0;
    box(rx, 2 - ext, 6, 4 + ext, R.steel[2]);
    box(L.merge.flip ? rx + 5 : rx, 2 - ext, 1, 4 + ext, R.steel[4]);
    box(L.merge.flip ? rx : rx + 5, 2 - ext, 1, 4 + ext, R.steel[0]);
    box(rx - 1, 1 - ext, 8, 1, R.gun[3]);
  }
  // light tower: red, amber, green lamps on the mast; round lamps with an anti-aliased cap pixel
  const lamps = [['red', 0], ['amber', 1], ['mint', 2]];
  for (const [ramp, i] of lamps) {
    const lx = 137;
    const ly = i * 4;
    let on = false;
    if (state === 'fail' && i === 0) on = calm || Math.floor(t * 6) % 2 === 0;
    // release trains: the release is being fixed (or has an open failure): the red lamp holds steady
    if (state === 'fixing' && i === 0) on = true;
    if (state === 'working' && i === 1) on = calm || Math.floor(t * 2) % 2 === 0;
    const standby = state === 'idle' && i === 1 && Math.sin(t * 1.2) > 0.4;
    if (state === 'pass' && i === 2) on = true;
    const r = R[ramp];
    box(lx, ly, 7, 4, on ? r[r.length - 2] : standby ? r[2] : r[1]);
    box(lx + 1, ly, 5, 1, on ? r[r.length - 1] : r[2]);
    pt(lx + 1, ly + 1, on ? r[r.length - 1] : r[2]);
    pt(lx, ly, on ? r[r.length - 3] : r[0]);
    pt(lx + 6, ly, on ? r[r.length - 3] : r[0]);
    box(lx, ly + 3, 7, 1, R.gun[0]);
    if (on) glow(f, X(lx + 3), oy + ly + 2, [4, 6], ramp === 'mint' ? 'mint' : ramp === 'red' ? 'red' : 'amber', { levels: [1, 0] });
  }
  box(136, -2, 9, 2, R.gun[3]);
  box(136, -2, 9, 1, R.steel[1]);
  // progress strip: never complete while working, the last segment lights when the merge lands; with
  // release trains it shows how full the release is (dim) while the machine waits
  const fill = Number.isFinite(ms.fill) ? Math.round(Math.max(0, Math.min(1, ms.fill)) * 10) : null;
  const seg = state === 'pass' || state === 'fail' ? 10 : working ? Math.min(9, Math.max(1, Math.round(progress * 10))) : fill ?? 0;
  for (let i = 0; i < 10; i += 1) {
    const lit = i < seg;
    const col = state === 'pass' ? R.mint[3] : state === 'fail' ? R.red[3] : !working && fill !== null ? (state === 'fixing' ? R.red[2] : R.cyan[2]) : R.cyan[3];
    const sx = L.merge.flip ? 58 + (9 - i) * 4 : 58 + i * 4;
    box(sx, 31, 3, 3, lit ? col : R.glass[2]);
    if (lit) pt(sx, 31, state === 'pass' ? R.mint[4] : state === 'fail' ? R.red[4] : R.cyan[4]);
  }
  if (working && !calm) pt(58 + (Math.floor(t * 8) % 10) * 4 + 1, 32, R.cyan[5]);
  else if (state === 'idle') pt(58 + (Math.floor(t * 1.5) % 10) * 4 + 1, 32, R.cyan[2]);
  // eased values from the world when it has them (gear, needle, jaw), else the state's own reading
  const needle = Number.isFinite(ms.needle) ? ms.needle : state === 'pass' ? 1 : progress;
  const ang = Math.PI * (0.8 + needle * 1.4);
  for (let d = 1; d <= 6; d += 1) pt(31 + Math.round(Math.cos(ang) * d), 58 + Math.round(Math.sin(ang) * d), d > 4 ? R.amber[4] : R.amber[3]);
  pt(31, 58, R.steel[3]);
  const keys = [working ? R.cyan[4] : R.cyan[1], state === 'pass' ? R.mint[3] : R.mint[0], state === 'fail' ? R.red[3] : R.red[0]];
  keys.forEach((c, i) => box(22 + i * 8, 75, 4, 2, c));
  const gearAng = (Number.isFinite(ms.gearAng) ? ms.gearAng : working && !calm ? t * 1.6 : 0.2 + t * 0.12) * (L.merge.flip ? -1 : 1);
  drawGear(f, X(125), oy + 61, 10, 9, gearAng, { hub: R.steel[3], dark: R.gun[1], mid: R.gun[3], rim: R.gun[3], light: R.steel[1], aa: R.gun[2] });
  drawGear(f, X(116), oy + 72, 4, 6, -gearAng * 2.2, { hub: R.steel[2], dark: R.gun[2], mid: R.gun[3], rim: R.gun[3], light: R.steel[1], aa: R.gun[1] });
  const swing = Number.isFinite(ms.ease) ? ms.ease : working && !calm ? 1 : 0;
  const jaw = calm ? 0 : Math.round((Math.sin(t * 3) + 1) * 1.5 * swing);
  for (const [jx, dir] of [[55, 1], [98, -1]]) {
    const x = jx + dir * jaw;
    box(x, 52, 3, 20, R.gun[3]);
    box(dir > 0 ? x : x + 2, 52, 1, 20, R.steel[1]);
    box(dir > 0 ? x + 3 : x - 2, 58, 2, 8, R.gun[2]);
  }
  const wl = state === 'pass' ? 'mint' : state === 'fail' || state === 'fixing' ? 'red' : working ? 'cyan' : null;
  const win = windowBox(L);
  if (wl) {
    lightRect(f, win.x, win.y, win.w, win.h, wl, 1);
    if (working && !calm) hline(f, win.x + 1, win.y + 1 + (Math.floor(t * 20) % 34), 46, R.cyan[3]);
  }
  if (working) {
    const flick = calm ? 1 : 1 + (Math.floor(t * 3) % 2);
    for (const vx of [20, 104]) for (let y = 91; y < 99; y += 3) for (let x = vx; x < vx + 32; x += 1) pt(x, y, flick > 1 && (x + y) % 5 === 0 ? R.amber[2] : R.amber[1]);
  }
  // batch counter: how many parcels the running batch holds now (release trains: counted/capacity)
  const counter = typeof ms.counter === 'string' && /^\d{1,2}\/\d{1,2}$/.test(ms.counter) ? ms.counter : null;
  const n = counter ? Number(counter.split('/')[0]) : ms.count || 0;
  const label = counter || (n > 0 ? String(Math.min(99, n)) : '--');
  const lw = 12 + label.length * 6;
  const lx = X(78 - Math.floor(lw / 2), lw);
  const ly = oy + 89;
  rect(f, lx - 1, ly - 1, lw + 2, 13, R.gun[0]);
  rect(f, lx, ly, lw, 11, R.amber[0]);
  hline(f, lx, ly, lw, R.dusk[3]);
  const on = n > 0 ? R.amber[4] : R.amber[1];
  rect(f, lx + 3, ly + 4, 5, 4, n > 0 ? R.amber[3] : R.amber[1]);
  hline(f, lx + 3, ly + 3, 5, on);
  vline(f, lx + 5, ly + 3, 5, R.amber[1]);
  text(f, label, lx + 10, ly + 2, on);
  if (state === 'pass') glow(f, X(150), oy + 32, [4, 8, 12], 'mint', { levels: [2, 1, 0] });
}
