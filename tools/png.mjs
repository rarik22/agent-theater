// Minimal PNG encode/decode for QA images (Node built-ins only).
// encodePNG: 8-bit RGBA, no interlace. decodePNG: 8-bit RGB/RGBA/grey(+alpha)/palette, no interlace
// (what headless Chrome writes), returned as RGBA.
import { deflateSync, inflateSync, crc32 } from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

export function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export function decodePNG(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let off = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let ctype = 0;
  let plte = null;
  let trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      ctype = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8) throw new Error(`bit depth ${depth} not supported`);
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = new Uint8ClampedArray(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y += 1) {
    const ft = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 255;
    }
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const s = x * bpp;
      if (ctype === 6) {
        out[o] = line[s];
        out[o + 1] = line[s + 1];
        out[o + 2] = line[s + 2];
        out[o + 3] = line[s + 3];
      } else if (ctype === 2) {
        out[o] = line[s];
        out[o + 1] = line[s + 1];
        out[o + 2] = line[s + 2];
        out[o + 3] = 255;
      } else if (ctype === 0 || ctype === 4) {
        out[o] = out[o + 1] = out[o + 2] = line[s];
        out[o + 3] = ctype === 4 ? line[s + 1] : 255;
      } else if (ctype === 3) {
        const p = line[s];
        out[o] = plte[p * 3];
        out[o + 1] = plte[p * 3 + 1];
        out[o + 2] = plte[p * 3 + 2];
        out[o + 3] = trns && p < trns.length ? trns[p] : 255;
      }
    }
    prev = line;
  }
  return { w, h, data: out };
}

/** Crop an RGBA image. */
export function crop(img, x, y, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r += 1) for (let c = 0; c < w; c += 1) {
    const sx = x + c;
    const sy = y + r;
    const o = (r * w + c) * 4;
    if (sx < 0 || sy < 0 || sx >= img.w || sy >= img.h) {
      out[o + 3] = 255;
      continue;
    }
    const i = (sy * img.w + sx) * 4;
    out[o] = img.data[i];
    out[o + 1] = img.data[i + 1];
    out[o + 2] = img.data[i + 2];
    out[o + 3] = 255;
  }
  return { w, h, data: out };
}

/** Nearest-neighbour rescale by a rational factor (num/den), e.g. 2/1 or 1/2. */
export function scaleNN(img, num, den = 1) {
  const w = Math.round((img.w * num) / den);
  const h = Math.round((img.h * num) / den);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const sy = Math.min(img.h - 1, Math.floor((y * den) / num));
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(img.w - 1, Math.floor((x * den) / num));
      const i = (sy * img.w + sx) * 4;
      const o = (y * w + x) * 4;
      out[o] = img.data[i];
      out[o + 1] = img.data[i + 1];
      out[o + 2] = img.data[i + 2];
      out[o + 3] = 255;
    }
  }
  return { w, h, data: out };
}

/** Lay images side by side (or stacked) on a background colour with a gap. */
export function montage(images, { gap = 8, bg = [10, 11, 23], vertical = false } = {}) {
  const w = vertical ? Math.max(...images.map((i) => i.w)) : images.reduce((s, i) => s + i.w, 0) + gap * (images.length - 1);
  const h = vertical ? images.reduce((s, i) => s + i.h, 0) + gap * (images.length - 1) : Math.max(...images.map((i) => i.h));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    out[i * 4] = bg[0];
    out[i * 4 + 1] = bg[1];
    out[i * 4 + 2] = bg[2];
    out[i * 4 + 3] = 255;
  }
  let at = 0;
  for (const img of images) {
    for (let y = 0; y < img.h; y += 1) for (let x = 0; x < img.w; x += 1) {
      const dx = vertical ? x : at + x;
      const dy = vertical ? at + y : y;
      const o = (dy * w + dx) * 4;
      const i = (y * img.w + x) * 4;
      out[o] = img.data[i];
      out[o + 1] = img.data[i + 1];
      out[o + 2] = img.data[i + 2];
      out[o + 3] = 255;
    }
    at += (vertical ? img.h : img.w) + gap;
  }
  return { w, h, data: out };
}
