// Render an Agent Theater video from the command line. It starts the theater server in-process, opens
// the HD stage in headless Chrome through the DevTools protocol, loads the recorder module into the page
// (the page itself has no export UI) and saves an MP4 (H.264) or, if Chrome cannot encode MP4, a WebM.
// Then it plays the file back in the page, grabs evenly spaced frames and measures how crisp the pixel
// art stays. Chrome and the server are always stopped.
//
//   node tools/render-video.mjs --from 2026-11-19T10:00:00Z --to 2026-11-19T13:30:00Z --duration 45 \
//        --aspect 16:9 [--title "AGENTS AT WORK"] [--end "NOV 19 2026"] [--tz Europe/London] --out x.mp4
//   node tools/render-video.mjs --live --duration 20 --aspect 1:1 --out live.mp4
//   node tools/render-video.mjs --date 2026-11-19 --segments "10:20-10:32,12:05-12:20,12:51-13:06" \
//        --duration 56 --aspect 16:9 --title "AI agents at work" --tz Europe/London --out cut.mp4
//   extra: [--grabs <dir>] [--grab-count 6 | --grab-at 1.5,12,20.4] [--sample] [--frames 600] [--port 8796]
//          [--sub "..."] [--end "..."] [--end-sub "..."] [--clock-label LONDON]
// --segments are UTC HH:MM-HH:MM windows on --date (default today, UTC); they play one after another
// with an iris and a clock card (the next window's time in --tz) between them.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { ASPECTS, normAspect, outputSize } from '../public/hd/hd-layout.mjs';
import { startServer } from '../server.mjs';
import { launchChrome, sleep } from './cdp.mjs';
import { decodePNG } from './png.mjs';

const ROOT = resolve(import.meta.dirname, '..');

export function parseArgs(argv) {
  const o = { live: false, sample: false, duration: 45, aspect: '16:9', title: '', sub: '', end: '', endSub: '', clockLabel: '', tz: Intl.DateTimeFormat().resolvedOptions().timeZone, grabCount: 6, port: 8796, date: new Date().toISOString().slice(0, 10), segments: null };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--live') o.live = true;
    else if (k === '--sample') o.sample = true;
    else if (k === '--from') (o.from = v), (i += 1);
    else if (k === '--to') (o.to = v), (i += 1);
    else if (k === '--duration') (o.duration = Number(v)), (i += 1);
    else if (k === '--aspect') (o.aspect = v), (i += 1);
    else if (k === '--title') (o.title = v), (i += 1);
    else if (k === '--end') (o.end = v), (i += 1);
    else if (k === '--sub') (o.sub = v), (i += 1);
    else if (k === '--end-sub') (o.endSub = v), (i += 1);
    else if (k === '--clock-label') (o.clockLabel = v), (i += 1);
    else if (k === '--date') (o.date = v), (i += 1);
    else if (k === '--segments') (o.segments = v), (i += 1);
    else if (k === '--tz') (o.tz = v), (i += 1);
    else if (k === '--out') (o.out = v), (i += 1);
    else if (k === '--grabs') (o.grabs = v), (i += 1);
    else if (k === '--grab-count') (o.grabCount = Number(v)), (i += 1);
    else if (k === '--grab-at') (o.grabAt = String(v).split(',').map(Number).filter((x) => Number.isFinite(x) && x >= 0)), (i += 1);
    else if (k === '--frames') (o.frames = Number(v)), (i += 1);
    else if (k === '--port') (o.port = Number(v)), (i += 1);
    // --config <file> is read by loadConfig() itself
    else if (k === '--config') i += 1;
    else throw new Error(`unknown option ${k}`);
  }
  if (!o.out) throw new Error('--out <file> is required');
  if (o.segments !== null) o.segments = parseSegments(o.segments, o.date);
  if (!o.live && !o.segments && !(o.from && o.to)) throw new Error('give --from and --to (a past window), --segments, or --live');
  if (o.segments) {
    o.from = o.segments[0].from;
    o.to = o.segments[o.segments.length - 1].to;
  }
  if (!o.live && !(Number.isFinite(Date.parse(o.from)) && Number.isFinite(Date.parse(o.to)) && Date.parse(o.to) > Date.parse(o.from))) throw new Error('--from and --to must be ISO times, to after from');
  if (!(o.duration >= 5 && o.duration <= 600)) throw new Error('--duration must be 5-600 seconds');
  o.aspect = normAspect(o.aspect);
  if (!ASPECTS[o.aspect]) throw new Error('--aspect must be 16:9, 1:1, 4:5 or 9:16');
  return o;
}

/** "10:20-10:32,12:05-12:20" on a UTC date -> [{ from, to }] (ISO), in order, not overlapping. */
export function parseSegments(spec, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('--date must be YYYY-MM-DD');
  const list = String(spec).split(',').map((x) => x.trim()).filter(Boolean);
  if (!list.length) throw new Error('--segments needs at least one HH:MM-HH:MM window');
  const out = list.map((x) => {
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(x);
    if (!m) throw new Error(`bad segment "${x}" (use HH:MM-HH:MM, UTC)`);
    const at = (h, mm) => {
      if (Number(h) > 23 || Number(mm) > 59) throw new Error(`bad time in "${x}"`);
      return Date.parse(`${date}T${String(h).padStart(2, '0')}:${mm}:00Z`);
    };
    const from = at(m[1], m[2]);
    const to = at(m[3], m[4]);
    if (!(to > from)) throw new Error(`segment "${x}" must end after it starts`);
    if (to - from < 60_000) throw new Error(`segment "${x}" is shorter than a minute`);
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  });
  for (let i = 1; i < out.length; i += 1) if (Date.parse(out[i].from) < Date.parse(out[i - 1].to)) throw new Error('segments must be in order and must not overlap');
  return out;
}

/** Share of aligned 2x2 blocks whose four pixels match (within tol): 1.0 = perfectly crisp x2 pixels. */
export function crispness(img, tol = 10) {
  let ok = 0;
  let n = 0;
  for (let y = 0; y + 1 < img.h; y += 2) for (let x = 0; x + 1 < img.w; x += 2) {
    const at = (xx, yy) => (yy * img.w + xx) * 4;
    const a = at(x, y);
    let same = true;
    for (const b of [at(x + 1, y), at(x, y + 1), at(x + 1, y + 1)]) for (let c = 0; c < 3; c += 1) if (Math.abs(img.data[a + c] - img.data[b + c]) > tol) same = false;
    if (same) ok += 1;
    n += 1;
  }
  return ok / n;
}

export async function renderVideo(o) {
  const { w, h } = outputSize(o.aspect);
  const server = await startServer(loadConfig(), { port: o.port });
  const base = `http://127.0.0.1:${o.port}`;
  const { page, close } = await launchChrome({ root: ROOT, width: w, height: h });
  const summary = { out: resolve(o.out), aspect: o.aspect, size: [w, h], window: o.live ? 'live' : o.segments ? o.segments.map((sg) => [sg.from, sg.to]) : [o.from, o.to], duration: o.duration };
  try {
    const q = new URLSearchParams({ aspect: o.aspect.replace(':', 'x'), feed: 'poll', tz: o.tz });
    if (o.sample) q.set('sample', '1');
    await page.goto(`${base}/?${q}`, { width: w, height: h });
    if (!(await page.waitFor('window.__theater && window.__theater.feed.everData', 30_000))) throw new Error('the stage got no data');
    await sleep(o.live ? 3000 : 1000);
    let clip;
    if (o.segments) {
      const args = JSON.stringify({ seconds: o.duration, segments: o.segments, title: o.title, titleSub: o.sub, end: o.end, endSub: o.endSub, tz: o.tz, clockLabel: o.clockLabel });
      clip = await page.eval(`import('/hd/hd-recorder.mjs').then((m) => m.recordSegments(${args}))`, { timeout: (o.duration + 120) * 1000 });
      summary.timeline = clip.timeline;
    } else {
      const args = JSON.stringify({ seconds: o.duration, from: o.live ? null : o.from, to: o.live ? null : o.to, frames: o.frames || null, title: o.title, end: o.end });
      clip = await page.eval(`import('/hd/hd-recorder.mjs').then((m) => m.record(${args}))`, { timeout: (o.duration + 60) * 1000 });
    }
    mkdirSync(dirname(resolve(o.out)), { recursive: true });
    writeFileSync(o.out, Buffer.from(clip.base64, 'base64'));
    Object.assign(summary, { mime: clip.mime, bytes: clip.size });
    // check the file: play it back, grab evenly spaced frames, measure crispness
    const n = Math.max(1, o.grabCount);
    const times = o.grabAt && o.grabAt.length ? [...o.grabAt].sort((x, y) => x - y) : Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) * o.duration * 100) / n) / 100);
    const check = await page.eval(`import('/hd/hd-recorder.mjs').then((m) => m.inspectLastClip(${JSON.stringify(times)}))`, { timeout: (o.duration + 60) * 1000 });
    Object.assign(summary, { decoded: [check.width, check.height], played: Number(check.played.toFixed(2)), fileDuration: Number.isFinite(check.duration) ? Number(check.duration.toFixed(2)) : null });
    const titleS = o.title ? 2.5 : 0;
    const endS = o.end ? 3 : 0;
    summary.grabs = check.frames.map((fr, i) => {
      const buf = Buffer.from(fr.png.split(',')[1], 'base64');
      const img = decodePNG(buf);
      const g = { t: Number(fr.t.toFixed(2)), crisp2x2: Number(crispness(img).toFixed(4)) };
      if (o.segments && clip.timeline) {
        // which window and replayed moment this frame shows (or the card / iris between them)
        const sg = [...clip.timeline.segments].reverse().find((x) => fr.t >= x.start);
        if (sg) {
          const p = Math.min(1, Math.max(0, (fr.t - sg.playAt) / sg.dur));
          g.replayed = new Date(Date.parse(sg.from) + p * (Date.parse(sg.to) - Date.parse(sg.from))).toISOString();
        }
        const tr = clip.timeline.transitions.find((x) => fr.t >= x.at && fr.t <= x.at + 1.75);
        if (tr) g.note = 'iris';
        if (fr.t < clip.timeline.titleS) g.note = 'title card';
        if (fr.t > o.duration - clip.timeline.endS) g.note = 'end card';
      } else if (!o.live) {
        // the replayed clock at this moment of the video (the time-lapse plays between the cards)
        const p = Math.min(1, Math.max(0, (fr.t - titleS) / Math.max(1, o.duration - titleS - endS)));
        g.replayed = new Date(Date.parse(o.from) + p * (Date.parse(o.to) - Date.parse(o.from))).toISOString();
      }
      if (o.grabs) {
        mkdirSync(o.grabs, { recursive: true });
        g.file = join(o.grabs, `${o.aspect.replace(':', 'x')}-grab${i + 1}-${fr.t.toFixed(1)}s.png`);
        writeFileSync(g.file, buf);
      }
      return g;
    });
    summary.minCrisp = Math.min(...summary.grabs.map((g) => g.crisp2x2));
    return summary;
  } finally {
    await close();
    await server.stop();
    try {
      rmSync(join(ROOT, '.qa-profiles'), { recursive: true, force: true });
    } catch {
      /* Chrome may hold the profile a moment longer */
    }
  }
}

if (import.meta.main) {
  try {
    const summary = await renderVideo(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(summary, null, 1));
  } catch (e) {
    console.error(e?.message || e);
    process.exitCode = 1;
  }
}
