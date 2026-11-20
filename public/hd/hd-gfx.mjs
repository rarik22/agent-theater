// Agent Theater HD · hd-gfx.mjs
// The indexed frame buffer and its pixel primitives. Every write is a palette index on a whole pixel:
// nothing here can draw a sub-pixel, blend or blur. Glows and shadows remap existing pixels through the
// stepped light LUTs of hd-palette. Pure; runs in the browser and in Node.
import { FONT, FONT_H, FONT_W } from './hd-font.mjs';
import { LIGHT, RGBA32, SHADE } from './hd-palette.mjs';

export function createFrame(w, h) {
  return { w, h, px: new Uint8Array(w * h) };
}

const ix = Math.round;

export function clear(f, c) {
  f.px.fill(c);
}

export function get(f, x, y) {
  x = ix(x);
  y = ix(y);
  if (x < 0 || y < 0 || x >= f.w || y >= f.h) return -1;
  return f.px[y * f.w + x];
}

export function dot(f, x, y, c) {
  x = ix(x);
  y = ix(y);
  if (c === null || c === undefined || c < 0 || x < 0 || y < 0 || x >= f.w || y >= f.h) return;
  f.px[y * f.w + x] = c;
}

export function rect(f, x, y, w, h, c) {
  if (c === null || c === undefined || c < 0) return;
  const x0 = Math.max(0, ix(x));
  const y0 = Math.max(0, ix(y));
  const x1 = Math.min(f.w, ix(x) + ix(w));
  const y1 = Math.min(f.h, ix(y) + ix(h));
  if (x1 <= x0) return;
  for (let yy = y0; yy < y1; yy += 1) f.px.fill(c, yy * f.w + x0, yy * f.w + x1);
}

export const hline = (f, x, y, w, c) => rect(f, x, y, w, 1, c);
export const vline = (f, x, y, h, c) => rect(f, x, y, 1, h, c);

/** 1 px rectangle outline. */
export function box(f, x, y, w, h, c) {
  hline(f, x, y, w, c);
  hline(f, x, y + h - 1, w, c);
  vline(f, x, y, h, c);
  vline(f, x + w - 1, y, h, c);
}

/**
 * A bevelled panel lit from the top left: fill, a light edge on top and left, a dark edge on bottom and
 * right, optional outline and corner pixels knocked out (`round`). Colours are palette indices.
 */
export function panel(f, x, y, w, h, { fill, hi, lo, outline = null, hi2 = null, round = false }) {
  x = ix(x);
  y = ix(y);
  rect(f, x, y, w, h, fill);
  hline(f, x, y, w - 1, hi);
  vline(f, x, y, h - 1, hi);
  if (hi2 !== null) {
    hline(f, x + 1, y + 1, w - 3, hi2);
  }
  hline(f, x + 1, y + h - 1, w - 1, lo);
  vline(f, x + w - 1, y + 1, h - 1, lo);
  if (outline !== null) {
    box(f, x - 1, y - 1, w + 2, h + 2, outline);
    if (round) {
      dot(f, x - 1, y - 1, -1);
    }
  }
}

/** Dashed horizontal line (`on` drawn, `off` skipped) starting at phase `shift`. */
export function hdash(f, x, y, w, c, on = 1, off = 1, shift = 0) {
  const p = on + off;
  for (let i = 0; i < w; i += 1) if ((((i + shift) % p) + p) % p < on) dot(f, x + i, y, c);
}
export function vdash(f, x, y, h, c, on = 1, off = 1, shift = 0) {
  const p = on + off;
  for (let i = 0; i < h; i += 1) if ((((i + shift) % p) + p) % p < on) dot(f, x, y + i, c);
}

/** Bresenham line between whole pixels. */
export function line(f, x0, y0, x1, y1, c) {
  x0 = ix(x0);
  y0 = ix(y0);
  x1 = ix(x1);
  y1 = ix(y1);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    dot(f, x0, y0, c);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/** Is (dx, dy) inside a pixel disc of radius r (centre on a pixel centre)? Clean, symmetric pixel circles. */
export const inDisc = (dx, dy, r) => dx * dx + dy * dy <= r * r + r * 0.8;

export function disc(f, cx, cy, r, c) {
  const R = Math.ceil(r);
  for (let dy = -R; dy <= R; dy += 1) for (let dx = -R; dx <= R; dx += 1) if (inDisc(dx, dy, r)) dot(f, cx + dx, cy + dy, c);
}

/** Remap the pixels of a rectangle through a LUT (an array: index -> index). */
export function remap(f, x, y, w, h, lut) {
  const x0 = Math.max(0, ix(x));
  const y0 = Math.max(0, ix(y));
  const x1 = Math.min(f.w, ix(x) + ix(w));
  const y1 = Math.min(f.h, ix(y) + ix(h));
  for (let yy = y0; yy < y1; yy += 1) for (let xx = x0; xx < x1; xx += 1) f.px[yy * f.w + xx] = lut[f.px[yy * f.w + xx]];
}

export function remapDot(f, x, y, lut) {
  x = ix(x);
  y = ix(y);
  if (x < 0 || y < 0 || x >= f.w || y >= f.h) return;
  f.px[y * f.w + x] = lut[f.px[y * f.w + x]];
}

/** Light a rectangle with a coloured light at level 0..2. */
export const lightRect = (f, x, y, w, h, light, level) => remap(f, x, y, w, h, LIGHT[light][Math.max(0, Math.min(2, level))]);
/** Cast shadow over a rectangle at level 0..2. */
export const shadeRect = (f, x, y, w, h, level) => remap(f, x, y, w, h, SHADE[Math.max(0, Math.min(2, level))]);

/**
 * Stepped radial glow: rings at radii[0] (strongest) ... radii[2] (faintest) around (cx, cy), each ring
 * remapping the pixels below it with one light level. `sy` squashes it vertically (ellipse). No blur.
 */
export function glow(f, cx, cy, radii, light, { sy = 1, levels = [2, 1, 0], mask = null } = {}) {
  const R = Math.ceil(Math.max(...radii));
  const L = LIGHT[light];
  for (let dy = -Math.ceil(R * sy); dy <= Math.ceil(R * sy); dy += 1) {
    for (let dx = -R; dx <= R; dx += 1) {
      const d = Math.hypot(dx, dy / sy);
      let lv = -1;
      for (let k = radii.length - 1; k >= 0; k -= 1) if (d <= radii[k] + 0.35) lv = levels[k];
      if (lv < 0) continue;
      const x = ix(cx) + dx;
      const y = ix(cy) + dy;
      if (x < 0 || y < 0 || x >= f.w || y >= f.h) continue;
      if (mask && !mask(x, y)) continue;
      f.px[y * f.w + x] = L[lv][f.px[y * f.w + x]];
    }
  }
}

/** 4x4 ordered-dither threshold (0..15). */
export const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

// ---------------------------------------------------------------- sprites
/** A sprite is { w, h, data: Int16Array } where -1 is transparent. */
export function createSprite(w, h) {
  return { w, h, data: new Int16Array(w * h).fill(-1) };
}

export function spriteGet(s, x, y) {
  if (x < 0 || y < 0 || x >= s.w || y >= s.h) return -1;
  return s.data[y * s.w + x];
}
export function spriteSet(s, x, y, c) {
  if (x < 0 || y < 0 || x >= s.w || y >= s.h) return;
  s.data[y * s.w + x] = c;
}

/** Text pixel map (array of equal-length strings) to a sprite through a legend {char: index}. */
export function mapToSprite(rows, legend) {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const s = createSprite(w, h);
  for (let y = 0; y < h; y += 1) {
    const row = rows[y];
    for (let x = 0; x < row.length; x += 1) {
      const ch = row[x];
      if (ch === '.' || ch === ' ') continue;
      if (!(ch in legend)) throw new Error(`unknown map char '${ch}' at ${x},${y}`);
      const c = legend[ch];
      if (c !== null && c !== undefined && c >= 0) s.data[y * w + x] = c;
    }
  }
  return s;
}

/**
 * Draw a sprite at whole pixel (x, y); `flip` mirrors it; `lut` remaps its colours as they are drawn;
 * `clip` ({x, y, w, h}) keeps only the pixels inside that box (a parcel seen through a window).
 */
export function blit(f, s, x, y, { flip = false, lut = null, clip = null } = {}) {
  x = ix(x);
  y = ix(y);
  for (let r = 0; r < s.h; r += 1) {
    const yy = y + r;
    if (yy < 0 || yy >= f.h) continue;
    for (let i = 0; i < s.w; i += 1) {
      const c = s.data[r * s.w + (flip ? s.w - 1 - i : i)];
      if (c < 0) continue;
      const xx = x + i;
      if (xx < 0 || xx >= f.w) continue;
      if (clip && (xx < clip.x || yy < clip.y || xx >= clip.x + clip.w || yy >= clip.y + clip.h)) continue;
      f.px[yy * f.w + xx] = lut ? lut[c] : c;
    }
  }
}

/** Copy a sprite onto another sprite (compose parts). */
export function stamp(dst, src, x, y, { flip = false } = {}) {
  for (let r = 0; r < src.h; r += 1) {
    for (let i = 0; i < src.w; i += 1) {
      const c = src.data[r * src.w + (flip ? src.w - 1 - i : i)];
      if (c < 0) continue;
      spriteSet(dst, x + i, y + r, c);
    }
  }
}

/** Snapshot a frame region into a sprite (used to cache static layers). */
export function copyFrame(dst, src) {
  dst.px.set(src.px);
}

// ---------------------------------------------------------------- text
/**
 * Draw text in the 5x7 font. `c` is the glyph colour, `top` an optional lighter colour for the upper
 * rows (an engraved, lit look), `shadow` an optional colour drawn 1 px below/right first.
 */
export function text(f, str, x, y, c, { top = null, shadow = null, spacing = 1, topRows = 3, scale = 1, shadowOffset = null } = {}) {
  const s = String(str ?? '');
  x = ix(x);
  y = ix(y);
  const k2 = Math.max(1, scale | 0); // whole-pixel scale: each font pixel becomes a k2 x k2 block
  const pass = (ox, oy, colourAt) => {
    for (let k = 0; k < s.length; k += 1) {
      const g = FONT[s[k]] || FONT[' '];
      for (let r = 0; r < FONT_H; r += 1) for (let i = 0; i < FONT_W; i += 1) if (g[r][i] === '1') {
        const px = x + ox + (k * (FONT_W + spacing) + i) * k2;
        const py = y + oy + r * k2;
        if (k2 === 1) dot(f, px, py, colourAt(r));
        else rect(f, px, py, k2, k2, colourAt(r));
      }
    }
  };
  const so = shadowOffset === null ? k2 : shadowOffset;
  if (shadow !== null) pass(so, so, () => shadow);
  pass(0, 0, (r) => (top !== null && r < topRows ? top : c));
  return s.length ? (s.length * (FONT_W + spacing) - spacing) * k2 : 0;
}

/** Convert the indexed frame to RGBA bytes (a Uint8ClampedArray or Buffer of w*h*4). */
export function toRGBA(f, out = new Uint8ClampedArray(f.w * f.h * 4)) {
  const u32 = new Uint32Array(out.buffer, out.byteOffset, f.w * f.h);
  for (let i = 0; i < f.px.length; i += 1) u32[i] = RGBA32[f.px[i]];
  return out;
}
