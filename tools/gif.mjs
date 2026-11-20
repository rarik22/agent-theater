// A small animated-GIF writer for the stage's indexed frames. The stage draws every pixel as an index into
// its 95-colour palette, so a GIF of it needs no colour quantizing: the indices go straight in and every
// frame is lossless. Each frame after the first stores only the box that changed, with unchanged pixels
// transparent, and a frame equal to the one before only lengthens that one's delay.
//
//   const gif = new GifWriter(w, h, RGB);       // RGB: [[r, g, b], ...], at most 255 colours
//   gif.add(px, 5);                             // px: Uint8Array(w * h) of palette indices; delay in 1/100 s
//   writeFileSync('x.gif', gif.finish());

const MAX_CODE = 4096;

/** LZW-compress palette indices the GIF way (variable code size, clear at 4096), as data sub-blocks. */
export function lzwBlocks(indices, minCodeSize) {
  const out = [];
  let cur = 0;
  let shift = 0;
  const bytes = [];
  const emit = (code, size) => {
    cur |= code << shift;
    shift += size;
    while (shift >= 8) {
      bytes.push(cur & 0xff);
      cur >>>= 8;
      shift -= 8;
    }
  };
  const clearCode = 1 << minCodeSize;
  const eoi = clearCode + 1;
  let next = eoi + 1;
  let size = minCodeSize + 1;
  let table = new Map();
  emit(clearCode, size);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const code = table.get(key);
    if (code !== undefined) {
      prefix = code;
      continue;
    }
    emit(prefix, size);
    if (next === MAX_CODE) {
      emit(clearCode, size);
      next = eoi + 1;
      size = minCodeSize + 1;
      table = new Map();
    } else {
      if (next >= 1 << size) size += 1;
      table.set(key, next);
      next += 1;
    }
    prefix = k;
  }
  emit(prefix, size);
  emit(eoi, size);
  if (shift > 0) bytes.push(cur & 0xff);
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];

export class GifWriter {
  constructor(w, h, rgb, { loop = 0 } = {}) {
    if (rgb.length > 255) throw new Error('at most 255 colours (one index is kept for transparency)');
    this.w = w;
    this.h = h;
    let bits = 1;
    while (1 << bits < rgb.length + 1) bits += 1;
    this.bits = Math.max(2, bits);
    this.transparent = rgb.length;
    this.parts = [];
    const table = [];
    for (let i = 0; i < 1 << this.bits; i += 1) table.push(...(rgb[i] || [0, 0, 0]));
    this.parts.push(Buffer.from('GIF89a', 'ascii'));
    this.parts.push(Buffer.from([...u16(w), ...u16(h), 0x80 | 0x70 | (this.bits - 1), 0, 0, ...table]));
    this.parts.push(Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'ascii'), 0x03, 0x01, ...u16(loop), 0x00]));
    this.prev = null;
    this.pending = null;
    this.frameCount = 0;
  }

  /** Add a frame of palette indices (Uint8Array of w * h) shown for `delay` hundredths of a second. */
  add(px, delay) {
    const { w, h } = this;
    if (px.length !== w * h) throw new Error(`a frame is ${w}x${h}`);
    if (this.prev === null) {
      this.pending = { x: 0, y: 0, w, h, data: Uint8Array.from(px), delay, alpha: false };
      this.prev = Uint8Array.from(px);
      return;
    }
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < h; y += 1) {
      const row = y * w;
      for (let x = 0; x < w; x += 1) {
        if (px[row + x] === this.prev[row + x]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
    if (x1 < 0) {
      this.pending.delay += delay;
      return;
    }
    this.flush();
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const data = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y += 1) {
      for (let x = 0; x < bw; x += 1) {
        const i = (y0 + y) * w + x0 + x;
        data[y * bw + x] = px[i] === this.prev[i] ? this.transparent : px[i];
      }
    }
    this.pending = { x: x0, y: y0, w: bw, h: bh, data, delay, alpha: true };
    this.prev.set(px);
  }

  flush() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    const delay = Math.max(2, Math.round(p.delay));
    const packed = (1 << 2) | (p.alpha ? 1 : 0);
    this.parts.push(Buffer.from([0x21, 0xf9, 0x04, packed, ...u16(delay), p.alpha ? this.transparent : 0, 0x00]));
    this.parts.push(Buffer.from([0x2c, ...u16(p.x), ...u16(p.y), ...u16(p.w), ...u16(p.h), 0x00, this.bits]));
    this.parts.push(Buffer.from(lzwBlocks(p.data, this.bits)));
    this.frameCount += 1;
  }

  /** The finished file. */
  finish() {
    this.flush();
    this.parts.push(Buffer.from([0x3b]));
    return Buffer.concat(this.parts);
  }
}

/** Nearest-neighbour scale of an indexed image by a whole number. */
export function scaleIndexed(px, w, h, k) {
  if (k === 1) return px;
  const out = new Uint8Array(w * k * h * k);
  for (let y = 0; y < h * k; y += 1) {
    const src = Math.floor(y / k) * w;
    const dst = y * w * k;
    for (let x = 0; x < w * k; x += 1) out[dst + x] = px[src + Math.floor(x / k)];
  }
  return out;
}

/** Cut a box out of an indexed image. */
export function cropIndexed(px, w, box) {
  const out = new Uint8Array(box.w * box.h);
  for (let y = 0; y < box.h; y += 1) out.set(px.subarray((box.y + y) * w + box.x, (box.y + y) * w + box.x + box.w), y * box.w);
  return out;
}
