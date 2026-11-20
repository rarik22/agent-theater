// Agent Theater HD · hd-tiny.mjs
// A tiny proportional pixel font for speech bubbles: capitals and digits 5 px tall, lowercase with a
// 4 px body, ascenders and one row of descenders, in a 6-row cell; most glyphs are 3 px wide (m, w, M,
// W, N and a few signs wider, i, l and stops narrower). Text that has no glyph is shown as close as the
// font allows: accents dropped, typographic quotes and dashes made plain, anything else as "?".
// Pure; runs in the browser and in Node.
import { dot, rect } from './hd-gfx.mjs';

export const TINY_H = 6;
const GAP = 1;

// Rows top to bottom, separated by "/": "#" is ink. Every row of a glyph has the glyph's width.
const GLYPHS = {
  A: '.#./#.#/###/#.#/#.#/...',
  B: '##./#.#/##./#.#/##./...',
  C: '.##/#../#../#../.##/...',
  D: '##./#.#/#.#/#.#/##./...',
  E: '###/#../##./#../###/...',
  F: '###/#../##./#../#../...',
  G: '.##/#../#.#/#.#/.##/...',
  H: '#.#/#.#/###/#.#/#.#/...',
  I: '###/.#./.#./.#./###/...',
  J: '..#/..#/..#/#.#/.#./...',
  K: '#.#/#.#/##./#.#/#.#/...',
  L: '#../#../#../#../###/...',
  M: '#...#/##.##/#.#.#/#...#/#...#/.....',
  N: '#..#/##.#/#.##/#..#/#..#/....',
  O: '.#./#.#/#.#/#.#/.#./...',
  P: '##./#.#/##./#../#../...',
  Q: '.#./#.#/#.#/#.#/.#./..#',
  R: '##./#.#/##./#.#/#.#/...',
  S: '.##/#../.#./..#/##./...',
  T: '###/.#./.#./.#./.#./...',
  U: '#.#/#.#/#.#/#.#/###/...',
  V: '#.#/#.#/#.#/#.#/.#./...',
  W: '#...#/#...#/#.#.#/##.##/#...#/.....',
  X: '#.#/#.#/.#./#.#/#.#/...',
  Y: '#.#/#.#/.#./.#./.#./...',
  Z: '###/..#/.#./#../###/...',
  a: '.../.##/#.#/#.#/.##/...',
  b: '#../##./#.#/#.#/##./...',
  c: '.../.##/#../#../.##/...',
  d: '..#/.##/#.#/#.#/.##/...',
  e: '.../.#./###/#../.##/...',
  f: '.##/.#./###/.#./.#./...',
  g: '.../.##/#.#/.##/..#/##.',
  h: '#../##./#.#/#.#/#.#/...',
  i: '#/./#/#/#/.',
  j: '.#/../.#/.#/.#/#.',
  k: '#../#.#/##./#.#/#.#/...',
  l: '#./#./#./#./.#/..',
  m: '...../##.#./#.#.#/#.#.#/#.#.#/.....',
  n: '.../##./#.#/#.#/#.#/...',
  o: '.../.#./#.#/#.#/.#./...',
  p: '.../##./#.#/#.#/##./#..',
  q: '.../.##/#.#/#.#/.##/..#',
  r: '.../#.#/##./#../#../...',
  s: '.../.##/#../..#/##./...',
  t: '.#./###/.#./.#./..#/...',
  u: '.../#.#/#.#/#.#/.##/...',
  v: '.../#.#/#.#/#.#/.#./...',
  w: '...../#...#/#...#/#.#.#/.#.#./.....',
  x: '.../.../#.#/.#./#.#/...',
  y: '.../#.#/#.#/.##/..#/##.',
  z: '.../###/.#./#../###/...',
  0: '###/#.#/#.#/#.#/###/...',
  1: '.#./##./.#./.#./###/...',
  2: '##./..#/.#./#../###/...',
  3: '##./..#/.#./..#/##./...',
  4: '#.#/#.#/###/..#/..#/...',
  5: '###/#../##./..#/##./...',
  6: '.##/#../###/#.#/###/...',
  7: '###/..#/.#./.#./.#./...',
  8: '###/#.#/###/#.#/###/...',
  9: '###/#.#/###/..#/##./...',
  ' ': '../../../../../..',
  '.': '././././#/.',
  ',': '../../../../.#/#.',
  ':': '././#/./#/.',
  ';': '../../.#/../.#/#.',
  '!': '#/#/#/./#/.',
  '?': '##./..#/.#./.../.#./...',
  "'": '#/#/./././.',
  '"': '#.#/#.#/.../.../.../...',
  '-': '.../.../###/.../.../...',
  _: '.../.../.../.../.../###',
  '/': '..#/..#/.#./#../#../...',
  '\\': '#../#../.#./..#/..#/...',
  '(': '.#/#./#./#./.#/..',
  ')': '#./.#/.#/.#/#./..',
  '[': '##/#./#./#./##/..',
  ']': '##/.#/.#/.#/##/..',
  '<': '..#/.#./#../.#./..#/...',
  '>': '#../.#./..#/.#./#../...',
  '=': '.../###/.../###/.../...',
  '+': '.../.#./###/.#./.../...',
  '*': '.../#.#/.#./#.#/.../...',
  '%': '#.#/..#/.#./#../#.#/...',
  '#': '.#.#./#####/.#.#./#####/.#.#./.....',
  '@': '.##./#..#/#.##/#.##/#.../.###',
  '&': '.#../#.#./.#../#.##/.##./....',
  '^': '.#./#.#/.../.../.../...',
  '~': '..../.#.#/#.#./..../..../....',
  '|': '#/#/#/#/#/#',
  '…': '...../...../...../...../#.#.#/.....',
  '·': '././#/././.',
};

/** Parsed glyphs: { w, rows: [[x, ...] per row] } with the ink columns of each of the 6 rows. */
export const TINY = Object.freeze(
  Object.fromEntries(
    Object.entries(GLYPHS).map(([ch, spec]) => {
      const rows = spec.split('/');
      return [ch, { w: rows[0].length, rows: rows.map((r) => [...r].flatMap((c, x) => (c === '#' ? [x] : []))) }];
    }),
  ),
);

const SUBST = { '‘': "'", '’': "'", '‚': ',', '“': '"', '”': '"', '„': '"', '–': '-', '—': '-', '−': '-', '•': '·', '{': '(', '}': ')', '$': 'S', '`': "'", ' ': ' ', '\t': ' ' };

/** Text the font can draw: accents dropped, look-alikes swapped in, everything else "?". */
export function tinyClean(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .split('')
    .map((ch) => (TINY[ch] ? ch : SUBST[ch] ?? (ch.charCodeAt(0) < 32 ? '' : '?')))
    .join('');
}

/** Width in pixels of clean text (glyphs and the 1 px gaps between them), at a whole-number scale. */
export function tinyWidth(s, scale = 1) {
  let w = 0;
  for (const ch of s) w += (TINY[ch] || TINY['?']).w + GAP;
  return (w ? w - GAP : 0) * scale;
}

/** Clean text cut to fit `maxW` pixels (at `scale`), ending in "…" when it was cut. */
export function tinyFit(s, maxW, scale = 1) {
  const text = tinyClean(s);
  maxW = Math.floor(maxW / scale);
  if (tinyWidth(text) <= maxW) return text;
  const ell = TINY['…'].w + GAP;
  let w = 0;
  let n = 0;
  for (const ch of text) {
    const cw = (TINY[ch] || TINY['?']).w + GAP;
    if (w + cw + ell - GAP > maxW) break;
    w += cw;
    n += 1;
  }
  return `${text.slice(0, n).replace(/[\s.,;:!?·-]+$/, '')}…`;
}

/** Draw clean text with its cell's top-left at (x, y), each font pixel a scale x scale block. Returns the width drawn. */
export function tinyText(f, s, x, y, c, scale = 1) {
  const k = Math.max(1, scale | 0);
  let cx = Math.round(x);
  const top = Math.round(y);
  for (const ch of s) {
    const g = TINY[ch] || TINY['?'];
    for (let r = 0; r < TINY_H; r += 1) {
      for (const gx of g.rows[r] || []) {
        if (k === 1) dot(f, cx + gx, top + r, c);
        else rect(f, cx + gx * k, top + r * k, k, k, c);
      }
    }
    cx += (g.w + GAP) * k;
  }
  return cx - Math.round(x) - (s.length ? GAP * k : 0);
}
