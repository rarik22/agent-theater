// HD slice: the mask shading pass (form light, selective outlines, seams, clean clusters, hand marks).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blit, createFrame, createSprite } from '../public/hd/hd-gfx.mjs';
import { R } from '../public/hd/hd-palette.mjs';
import { createMask, distanceField, maskFromRows, mdisc, mrect, shadeMask } from '../public/hd/hd-shade.mjs';

const at = (s, x, y) => s.data[y * s.w + x];

test('distance field counts pixels to the nearest edge of the region', () => {
  const k = maskFromRows(['.....', '.aaa.', '.aaa.', '.aaa.', '.....']);
  const D = distanceField(k, (x, y) => (k.m[y * k.w + x] === null ? null : 'a'));
  assert.equal(D[0], 0);
  assert.equal(D[1 * 5 + 1], 1, 'edge pixel');
  assert.equal(D[2 * 5 + 2], 2, 'centre pixel');
});

test('a shaded panel is lit top-left, dark bottom-right, with a selective outline', () => {
  const k = createMask(12, 10);
  mrect(k, 0, 0, 12, 10, 'g');
  const s = shadeMask(k, { g: { ramp: 'gun', base: 3, bevel: 2 } });
  const ramp = R.gun;
  for (const v of s.data) assert.ok(ramp.includes(v), 'only gunmetal ramp colours');
  // outline: lit side lighter than the shadow side, both dark steps of the ramp
  assert.equal(at(s, 5, 0), ramp[1], 'top edge outline is the lit dark step');
  assert.equal(at(s, 5, 9), ramp[0], 'bottom edge outline is the darkest step');
  assert.equal(at(s, 11, 5), ramp[0], 'right edge outline is the darkest step');
  // form light inside the outline
  const tl = ramp.indexOf(at(s, 1, 1));
  const br = ramp.indexOf(at(s, 10, 8));
  const mid = ramp.indexOf(at(s, 6, 5));
  assert.ok(tl > mid, 'top-left bevel catches the light');
  assert.ok(br < mid, 'bottom-right bevel falls into shadow');
  assert.equal(mid, 3, 'flat interior keeps the base step');
});

test('the outline can be a fixed colour, or switched off for overlay parts', () => {
  const k = createMask(6, 6);
  mrect(k, 0, 0, 6, 6, 'v');
  const fixed = shadeMask(k, { v: { ramp: 'violet', base: 3, outline: R.violet[0] } });
  assert.equal(at(fixed, 0, 3), R.violet[0]);
  assert.equal(at(fixed, 3, 0), R.violet[0]);
  const none = shadeMask(k, { v: { ramp: 'violet', base: 3, flat: true } }, { outline: false });
  assert.ok(none.data.every((c) => c === R.violet[3]), 'flat, no outline: one colour');
});

test('a seam darkens a region where it meets another region below or to the right', () => {
  const k = maskFromRows(['aaaa', 'aaaa', 'bbbb', 'bbbb']);
  const s = shadeMask(k, { a: { ramp: 'steel', base: 3, flat: true, outline: null }, b: { ramp: 'gun', base: 3, flat: true, outline: null } });
  assert.equal(at(s, 1, 1), R.steel[2], 'row above the boundary is one step darker');
  assert.equal(at(s, 1, 0), R.steel[3]);
});

test('clusters stay clean: no lone pixel of a step inside a shaded disc', () => {
  const k = createMask(21, 21);
  mdisc(k, 10, 10, 9, 'g');
  const s = shadeMask(k, { g: { ramp: 'gun', base: 3, bevel: 3, k: 2.6, outline: null } });
  let lonely = 0;
  for (let y = 1; y < 20; y += 1) for (let x = 1; x < 20; x += 1) {
    const c = at(s, x, y);
    if (c < 0) continue;
    const n = [at(s, x + 1, y), at(s, x - 1, y), at(s, x, y + 1), at(s, x, y - 1)];
    if (n.every((v) => v >= 0) && !n.includes(c)) lonely += 1;
  }
  assert.equal(lonely, 0);
});

test('hand marks lift, drop, highlight and recolour single pixels', () => {
  const k = createMask(5, 3);
  mrect(k, 0, 0, 5, 3, 'g');
  const mats = { g: { ramp: 'gun', base: 2, flat: true, outline: null, seam: false } };
  const s = shadeMask(k, mats, { marks: ['+-*_x', '.....', '.....'], legend: { x: R.cyan[4] } });
  assert.deepEqual([...s.data.slice(0, 5)], [R.gun[3], R.gun[1], R.gun[5], R.gun[0], R.cyan[4]]);
  assert.throws(() => shadeMask(k, mats, { marks: ['?'] }), /unknown mark/);
  assert.throws(() => shadeMask(maskFromRows(['q']), mats), /no material/);
});

test('a clipped blit only writes inside its box, on whole pixels', () => {
  const f = createFrame(10, 4);
  const s = createSprite(6, 2);
  s.data.fill(7);
  blit(f, s, 2.4, 1, { clip: { x: 4, y: 0, w: 3, h: 4 } });
  const lit = [];
  for (let i = 0; i < f.px.length; i += 1) if (f.px[i] === 7) lit.push([i % 10, Math.floor(i / 10)]);
  assert.equal(lit.length, 6);
  assert.ok(lit.every(([x]) => x >= 4 && x < 7));
});
