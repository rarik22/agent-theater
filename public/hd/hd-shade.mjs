// Agent Theater HD · hd-shade.mjs
// The pixel-art shading pass. Shapes are authored as masks of material regions (text maps or masks built
// with rect/disc/line), then shaded the way a pixel artist would:
//   - form light: a height field from the distance to each region's edge, its normal dotted with a light
//     from the top left, quantised to the material's ramp (no gradients, no dithering);
//   - selective outlines: the silhouette takes a dark step of the material it encloses, lighter on the lit
//     top-left side and darkest at the bottom right; edges against other regions get a 1-step seam;
//   - cluster clean-up: lone pixels of a step are folded into their neighbours so clusters stay clean;
//   - hand marks: an optional overlay map lifts (+), drops (-), highlights (*) or recolours single pixels.
// Pure; used to build sprites once, never per frame.
import { createSprite } from './hd-gfx.mjs';
import { R } from './hd-palette.mjs';

/** A mask is { w, h, m: Array<string|null> } holding one material key per pixel. */
export function createMask(w, h) {
  return { w, h, m: new Array(w * h).fill(null) };
}

export function maskFromRows(rows) {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const k = createMask(w, h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < rows[y].length; x += 1) {
    const ch = rows[y][x];
    if (ch !== '.' && ch !== ' ') k.m[y * w + x] = ch;
  }
  return k;
}

export const mget = (k, x, y) => (x < 0 || y < 0 || x >= k.w || y >= k.h ? null : k.m[y * k.w + x]);
export function mset(k, x, y, v) {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= k.w || y >= k.h) return;
  k.m[y * k.w + x] = v;
}
export function mrect(k, x, y, w, h, v) {
  for (let yy = Math.round(y); yy < Math.round(y + h); yy += 1) for (let xx = Math.round(x); xx < Math.round(x + w); xx += 1) mset(k, xx, yy, v);
}
export function mdisc(k, cx, cy, r, v) {
  const R0 = Math.ceil(r);
  for (let dy = -R0; dy <= R0; dy += 1) for (let dx = -R0; dx <= R0; dx += 1) if (dx * dx + dy * dy <= r * r + r * 0.8) mset(k, cx + dx, cy + dy, v);
}
/** Filled rounded rectangle (corner radius r, pixel-clean). */
export function mround(k, x, y, w, h, r, v) {
  for (let yy = 0; yy < h; yy += 1) for (let xx = 0; xx < w; xx += 1) {
    const cx = xx < r ? r - xx : xx > w - 1 - r ? xx - (w - 1 - r) : 0;
    const cy = yy < r ? r - yy : yy > h - 1 - r ? yy - (h - 1 - r) : 0;
    if (cx * cx + cy * cy <= r * r + 0.5) mset(k, x + xx, y + yy, v);
  }
}
export function mline(k, x0, y0, x1, y1, v, thick = 1) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= n; i += 1) {
    const x = Math.round(x0 + ((x1 - x0) * i) / n);
    const y = Math.round(y0 + ((y1 - y0) * i) / n);
    for (let a = 0; a < thick; a += 1) for (let b = 0; b < thick; b += 1) mset(k, x + a, y + b, v);
  }
}

// Light from the top left, slightly in front of the scene.
const LV = (() => {
  const v = [-0.62, -0.78, 0.95];
  const n = Math.hypot(...v);
  return v.map((c) => c / n);
})();

/** Chamfer distance (1, 1.41) from each pixel to the nearest pixel outside its region. */
export function distanceField(k, regionOf) {
  const { w, h } = k;
  const D = new Float32Array(w * h);
  const G = new Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    G[i] = regionOf(i % w, Math.floor(i / w));
    D[i] = G[i] === null ? 0 : 1e6;
  }
  // A neighbour in the same region passes on its distance; anything else is the edge itself.
  const nb = (g, x, y, cost) => (x >= 0 && y >= 0 && x < w && y < h && G[y * w + x] === g ? D[y * w + x] + cost : cost);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const i = y * w + x;
    if (G[i] === null) continue;
    const g = G[i];
    D[i] = Math.min(D[i], nb(g, x - 1, y, 1), nb(g, x, y - 1, 1), nb(g, x - 1, y - 1, 1.41), nb(g, x + 1, y - 1, 1.41));
  }
  for (let y = h - 1; y >= 0; y -= 1) for (let x = w - 1; x >= 0; x -= 1) {
    const i = y * w + x;
    if (G[i] === null) continue;
    const g = G[i];
    D[i] = Math.min(D[i], nb(g, x + 1, y, 1), nb(g, x, y + 1, 1), nb(g, x + 1, y + 1, 1.41), nb(g, x - 1, y + 1, 1.41));
  }
  return D;
}

/**
 * Shade a mask into a sprite.
 *   materials: { key: { ramp, base, bevel = 2, k = 2.6, group = key, outline = 'auto' | index | null,
 *                       seam = true, flat = false, steps = null } }
 *     `steps` limits which ramp steps the form light may use (e.g. [1, 3]).
 *     `flat` skips form light (only outline/seams), for printed details and lights.
 *   opts.marks: overlay rows: '+' lighter, '-' darker, '*' top step, '_' bottom step, 'o' outline colour,
 *               other characters through opts.legend (direct palette indices).
 *   opts.outline: false disables every silhouette outline (for parts drawn over others).
 */
export function shadeMask(k, materials, opts = {}) {
  const { w, h } = k;
  const mat = (x, y) => {
    const key = mget(k, x, y);
    return key === null ? null : materials[key] || null;
  };
  for (const key of new Set(k.m)) if (key !== null && !materials[key]) throw new Error(`no material for '${key}'`);
  const groupOf = (x, y) => {
    const key = mget(k, x, y);
    if (key === null) return null;
    return materials[key].group ?? key;
  };
  const D = distanceField(k, groupOf);
  // per-group vertical extent, for light falloff down large surfaces
  const ext = new Map();
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const g = groupOf(x, y);
    if (g === null) continue;
    const e = ext.get(g) || { y0: y, y1: y };
    e.y0 = Math.min(e.y0, y);
    e.y1 = Math.max(e.y1, y);
    ext.set(g, e);
  }
  const step = new Int8Array(w * h);
  const role = new Uint8Array(w * h); // 0 fill, 1 outline, 2 seam
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const i = y * w + x;
    const m = mat(x, y);
    if (!m) continue;
    const rampLen = R[m.ramp].length;
    const base = m.base ?? Math.floor(rampLen / 2);
    let s = base;
    if (!m.flat) {
      const bevel = m.bevel ?? 2;
      const g = groupOf(x, y);
      const H = (xx, yy) => (groupOf(xx, yy) === g ? Math.min(D[yy * w + xx], bevel) / bevel : 0);
      const gx = H(x + 1, y) - H(x - 1, y);
      const gy = H(x, y + 1) - H(x, y - 1);
      const nz = m.nz ?? 0.9;
      const len = Math.hypot(gx, gy, nz);
      const dotL = (-gx * LV[0] - gy * LV[1] + nz * LV[2]) / len;
      const v = dotL - LV[2];
      // the light faces gain less from a tilt than the shadow faces lose (the light is in front), so
      // the lit side gets its own, stronger gain: a 1-step bevel on both sides of a flat panel
      const kk = v > 0 ? m.kl ?? 4.5 : m.k ?? 2.6;
      s = base + Math.round(v * kk);
      // light falloff: the top band of a tall surface catches more light, the foot sits in shadow
      if (m.vgrad) {
        const e = ext.get(g);
        const rel = e.y1 > e.y0 ? (y - e.y0) / (e.y1 - e.y0) : 0.5;
        if (rel < m.vgrad[0]) s += 1;
        else if (rel > 1 - m.vgrad[1]) s -= 1;
      }
      // brushed metal: short horizontal streaks one step up or down, away from the bevels
      if (m.brushed && D[i] > bevel) {
        const cell = x >> 2;
        const hsh = (cell * 73 + y * 151 + ((cell ^ (y * 7)) & 31) * 17) % 19;
        if (hsh === 0) s += 1;
        else if (hsh === 1) s -= 1;
      }
    }
    const lo = m.steps ? m.steps[0] : 0;
    const hi = m.steps ? m.steps[1] : rampLen - 1;
    step[i] = Math.max(lo, Math.min(hi, s));
    // Silhouette outline: a 4-neighbour outside the whole part.
    const out = (dx, dy) => mget(k, x + dx, y + dy) === null;
    if (opts.outline !== false && m.outline !== null && (out(-1, 0) || out(1, 0) || out(0, -1) || out(0, 1))) {
      role[i] = 1;
    } else if (m.seam !== false) {
      // Seam where this region meets another group below or to the right (its shadow side).
      const g = groupOf(x, y);
      const other = (dx, dy) => {
        const o = groupOf(x + dx, y + dy);
        return o !== null && o !== g;
      };
      if (other(1, 0) || other(0, 1)) role[i] = 2;
    }
  }
  // Clean clusters: a fill pixel with no 4-neighbour of the same step in the same material takes the
  // most common neighbouring step of its material.
  const clean = new Int8Array(step);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const i = y * w + x;
    const key = mget(k, x, y);
    if (key === null || role[i] !== 0 || materials[key].flat) continue;
    const counts = new Map();
    let sameStep = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (mget(k, x + dx, y + dy) !== key) continue;
      const j = (y + dy) * w + x + dx;
      if (role[j] !== 0) continue;
      if (step[j] === step[i]) sameStep += 1;
      counts.set(step[j], (counts.get(step[j]) || 0) + 1);
    }
    if (sameStep === 0 && counts.size) clean[i] = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  }
  const s = createSprite(w, h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const i = y * w + x;
    const m = mat(x, y);
    if (!m) continue;
    const r = R[m.ramp];
    let c;
    if (role[i] === 1) {
      if (typeof m.outline === 'number') c = m.outline;
      else {
        // Selective outline: lighter where the silhouette faces the light.
        const lit = mget(k, x - 1, y) === null || mget(k, x, y - 1) === null;
        const dark = mget(k, x + 1, y) === null || mget(k, x, y + 1) === null;
        c = r[lit && !dark ? Math.min(1, r.length - 1) : 0];
        if (m.outlineLit !== undefined && lit && !dark) c = m.outlineLit;
      }
    } else if (role[i] === 2) c = r[Math.max(0, clean[i] - 1)];
    else c = r[clean[i]];
    s.data[i] = c;
  }
  if (opts.marks) applyMarks(s, k, materials, opts.marks, opts.legend || {});
  return s;
}

function applyMarks(s, k, materials, marks, legend) {
  for (let y = 0; y < marks.length && y < s.h; y += 1) for (let x = 0; x < marks[y].length && x < s.w; x += 1) {
    const ch = marks[y][x];
    if (ch === '.' || ch === ' ') continue;
    const i = y * s.w + x;
    if (ch in legend) {
      s.data[i] = legend[ch];
      continue;
    }
    const key = mget(k, x, y);
    if (key === null) continue;
    const m = materials[key];
    const r = R[m.ramp];
    const cur = r.indexOf(s.data[i]);
    if (ch === '+') s.data[i] = r[Math.min(r.length - 1, (cur < 0 ? m.base : cur) + 1)];
    else if (ch === '-') s.data[i] = r[Math.max(0, (cur < 0 ? m.base : cur) - 1)];
    else if (ch === '*') s.data[i] = r[r.length - 1];
    else if (ch === '_') s.data[i] = r[0];
    else if (ch === 'o') s.data[i] = typeof m.outline === 'number' ? m.outline : r[0];
    else throw new Error(`unknown mark '${ch}'`);
  }
}
