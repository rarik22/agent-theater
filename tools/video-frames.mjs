// Grab frames from a video file at given times, decoded by headless Chrome (no ffmpeg needed), as PNGs.
// Also reports the decoded size, the duration and the crisp-pixel measure of each frame.
//   node tools/video-frames.mjs exports/x.mp4 --at 8.1 --at 20 --out-dir qa/replay
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { launchChrome } from './cdp.mjs';
import { decodePNG } from './png.mjs';
import { crispness } from './render-video.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const file = args[0];
const times = args.flatMap((a, i) => (a === '--at' ? [Number(args[i + 1])] : []));
const di = args.indexOf('--out-dir');
const outDir = di >= 0 ? args[di + 1] : join(ROOT, 'qa');
mkdirSync(outDir, { recursive: true });
const b64 = readFileSync(file).toString('base64');
const type = file.endsWith('.webm') ? 'video/webm' : 'video/mp4';
const { page, close } = await launchChrome({ root: ROOT, width: 800, height: 600 });
try {
  await page.goto('about:blank');
  await page.eval(`(() => { const b = atob(${JSON.stringify(b64)}); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i += 1) u[i] = b.charCodeAt(i); window.__blob = new Blob([u], { type: '${type}' }); return u.length; })()`, { timeout: 120_000 });
  const res = await page.eval(`(async () => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto';
    v.src = URL.createObjectURL(window.__blob);
    document.body.appendChild(v);
    await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
    const out = [];
    for (const t of ${JSON.stringify(times)}) {
      v.currentTime = t;
      await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
      await new Promise((r) => setTimeout(r, 60));
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      out.push({ t: v.currentTime, png: c.toDataURL('image/png') });
    }
    return { width: v.videoWidth, height: v.videoHeight, duration: v.duration, frames: out };
  })()`, { timeout: 120_000 });
  const summary = { file, width: res.width, height: res.height, duration: res.duration, frames: [] };
  for (const fr of res.frames) {
    const buf = Buffer.from(fr.png.split(',')[1], 'base64');
    const p = join(outDir, `${basename(file).replace(/\.\w+$/, '')}-at-${fr.t.toFixed(2)}s.png`);
    writeFileSync(p, buf);
    summary.frames.push({ t: Number(fr.t.toFixed(2)), crisp2x2: Number(crispness(decodePNG(buf)).toFixed(4)), file: p });
  }
  console.log(JSON.stringify(summary, null, 1));
} finally {
  await close();
}
