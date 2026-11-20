// The GIF writer behind the README's pictures: frames of palette indices go in, and a decoder reads the
// same indices back from every frame (changed boxes, transparency, merged repeats, LZW table resets).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GifWriter, cropIndexed, scaleIndexed } from '../tools/gif.mjs';

/** A minimal decoder for the files GifWriter makes: global table, loop block, GCE + image + LZW data. */
function decode(buf) {
  assert.equal(buf.subarray(0, 6).toString('ascii'), 'GIF89a');
  const w = buf.readUInt16LE(6);
  const h = buf.readUInt16LE(8);
  let p = 13 + 3 * (1 << ((buf[10] & 7) + 1));
  const screen = new Int16Array(w * h).fill(-1);
  const frames = [];
  let gce = null;
  while (buf[p] !== 0x3b) {
    if (buf[p] === 0x21) {
      const label = buf[p + 1];
      if (label === 0xf9) gce = { transparent: buf[p + 3] & 1 ? buf[p + 6] : -1, delay: buf.readUInt16LE(p + 4) };
      p += 2;
      while (buf[p] !== 0) p += buf[p] + 1;
      p += 1;
      continue;
    }
    assert.equal(buf[p], 0x2c);
    const [x, y, fw, fh] = [buf.readUInt16LE(p + 1), buf.readUInt16LE(p + 3), buf.readUInt16LE(p + 5), buf.readUInt16LE(p + 7)];
    const minSize = buf[p + 10];
    p += 11;
    const data = [];
    while (buf[p] !== 0) {
      data.push(...buf.subarray(p + 1, p + 1 + buf[p]));
      p += buf[p] + 1;
    }
    p += 1;
    const px = lzwDecode(data, minSize, fw * fh);
    for (let i = 0; i < px.length; i += 1) if (px[i] !== gce.transparent) screen[(y + Math.floor(i / fw)) * w + x + (i % fw)] = px[i];
    frames.push({ px: Uint8Array.from(screen), delay: gce.delay });
  }
  return { w, h, frames };
}

function lzwDecode(bytes, minSize, count) {
  const clear = 1 << minSize;
  const out = [];
  let size = minSize + 1;
  let dict = [];
  let prev = null;
  let bit = 0;
  const reset = () => {
    dict = Array.from({ length: clear + 2 }, (_, i) => [i]);
    size = minSize + 1;
    prev = null;
  };
  reset();
  while (out.length < count) {
    let code = 0;
    for (let i = 0; i < size; i += 1, bit += 1) code |= ((bytes[bit >> 3] >> (bit & 7)) & 1) << i;
    if (code === clear) {
      reset();
      continue;
    }
    if (code === clear + 1) break;
    const entry = code < dict.length ? dict[code] : [...prev, prev[0]];
    out.push(...entry);
    if (prev !== null && dict.length < 4096) dict.push([...prev, entry[0]]);
    if (dict.length === 1 << size && size < 12) size += 1;
    prev = entry;
  }
  return out;
}

const PALETTE = Array.from({ length: 95 }, (_, i) => [i * 2, 255 - i, (i * 7) % 256]);

test('frames of indices come back exactly, with only changed boxes stored', () => {
  const w = 120;
  const h = 80;
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  // noisy frames overflow the 4096-code table, so the encoder must clear and restart it
  const frames = [];
  const base = Uint8Array.from({ length: w * h }, () => Math.floor(rnd() * 95));
  frames.push(base);
  const moved = Uint8Array.from(base);
  for (let y = 30; y < 40; y += 1) for (let x = 50; x < 70; x += 1) moved[y * w + x] = (x + y) % 95;
  frames.push(moved);
  frames.push(Uint8Array.from(moved)); // a repeat: merged into the previous frame's delay
  const last = Uint8Array.from(moved);
  last[0] = 94;
  last[w * h - 1] = 0;
  frames.push(last);
  const gif = new GifWriter(w, h, PALETTE);
  for (const f of frames) gif.add(f, 7);
  const out = decode(gif.finish());
  assert.equal(out.w, w);
  assert.equal(out.h, h);
  assert.equal(out.frames.length, 3);
  assert.deepEqual(out.frames.map((f) => f.delay), [7, 14, 7]);
  assert.deepEqual(out.frames[0].px, frames[0]);
  assert.deepEqual(out.frames[1].px, frames[1]);
  assert.deepEqual(out.frames[2].px, frames[3]);
});

test('crop and whole-number scale of indexed images', () => {
  const px = Uint8Array.from([1, 2, 3, 4, 5, 6]);
  assert.deepEqual(cropIndexed(px, 3, { x: 1, y: 0, w: 2, h: 2 }), Uint8Array.from([2, 3, 5, 6]));
  assert.deepEqual(scaleIndexed(Uint8Array.from([1, 2]), 2, 1, 2), Uint8Array.from([1, 1, 2, 2, 1, 1, 2, 2]));
});

test('a palette too big for a transparent index is refused', () => {
  assert.throws(() => new GifWriter(2, 2, Array.from({ length: 256 }, () => [0, 0, 0])), /255 colours/);
});
