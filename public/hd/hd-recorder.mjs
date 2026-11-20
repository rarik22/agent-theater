// Agent Theater HD · hd-recorder.mjs
// The video recorder. The page does not load it and has no export UI: tools/render-video.mjs drives
// the page headlessly over the DevTools protocol and imports this module into it. It records the
// stage's x2 output canvas with MediaRecorder (MP4/H.264 when the browser can, else WebM), either live
// or a past window as a time-lapse, with optional title and end cards (five words at most each), and
// resolves with the file as base64. recordSegments() stitches several past windows into one cut with
// an iris and a clock card between them. Codes only against the stage API (window.__theater.stage).
import { fontText } from './hd-font.mjs';
import { drawIris, drawSegmentCard } from './hd-render.mjs';

/** The best recording format this browser offers: MP4 (H.264) first. */
export function pickMime() {
  if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  const list = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.4D401F', 'video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const m of list) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* try the next */
    }
  }
  return '';
}

/** Card words: the pixel font's characters only, at most five words. */
export const cardWords = (s) => fontText(s).split(' ').filter(Boolean).slice(0, 5).join(' ');

/** Seconds of each part of a segment transition: the iris closes, the clock card holds, the iris opens. */
export const IRIS = { close: 0.6, hold: 0.55, open: 0.6 };
const TRANSITION_S = IRIS.close + IRIS.hold + IRIS.open;

/**
 * The timeline of a cut: a title card over the first segment's opening frame, the segments one after
 * another (their playback time shared out by window length, at least 5 s each) with an iris between
 * them, then the end card over the last frame. Times in seconds from the start of the video.
 * Returns { segments: [{ from, to, start, dur, playAt }], transitions: [{ at }], titleS, endS }.
 */
export function cutTimeline(segments, seconds, { titleS = 3, endS = 3 } = {}) {
  const n = segments.length;
  if (!n) throw new Error('no segments');
  const play = seconds - titleS - endS - (n - 1) * TRANSITION_S;
  if (play < 5 * n) throw new Error(`${seconds} s is too short for ${n} segments`);
  const spans = segments.map((s) => Date.parse(s.to) - Date.parse(s.from));
  const total = spans.reduce((a, b) => a + b, 0);
  let durs = spans.map((sp) => Math.max(5, (play * sp) / total));
  const scale = play / durs.reduce((a, b) => a + b, 0);
  durs = durs.map((d) => d * scale);
  const out = [];
  const transitions = [];
  let at = titleS;
  segments.forEach((s, i) => {
    if (i > 0) {
      transitions.push({ at });
      at += TRANSITION_S;
    }
    // the replay starts while the iris is closed, and plays from the moment it begins to open
    const start = i === 0 ? 0 : at - IRIS.open - IRIS.hold / 2;
    out.push({ from: s.from, to: s.to, start, playAt: i === 0 ? titleS : at - IRIS.open, dur: durs[i] + (i === 0 ? 0 : IRIS.open) });
    at += durs[i];
  });
  return { segments: out, transitions, titleS, endS, seconds };
}

/**
 * Record a cut of several past windows. opts: { seconds, segments: [{ from, to }] (ISO), title,
 * titleSub, end, endSub, tz (the clock card's time zone), clockLabel, fps, bitrate }.
 * Resolves { mime, size, seconds, timeline, base64 }.
 */
export async function recordSegments({ seconds = 55, segments = [], title = '', titleSub = '', end = '', endSub = '', tz = undefined, clockLabel = '', fps = 30, bitrate = 14e6 } = {}) {
  const S = window.__theater && window.__theater.stage;
  if (!S) throw new Error('the stage is not ready');
  const mime = pickMime();
  if (!mime || !S.out.captureStream) throw new Error('this browser cannot record the canvas');
  const caption = cardWords(title);
  const endCaption = cardWords(end);
  const tl = cutTimeline(segments, seconds, { titleS: caption ? 3 : 0, endS: endCaption ? 3 : 0 });
  // fetch every window first, about 14 frames per second of playback
  const datas = [];
  for (const s of tl.segments) datas.push(await S.fetchReplay({ from: s.from, to: s.to }, Math.min(900, Math.max(60, Math.round(s.dur * 14)))));
  const clockFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
  const stream = S.out.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  let t0 = performance.now();
  let next = 1;
  S.cards = (f, now, t, drawCard) => {
    const el = (now - t0) / 1000;
    if (tl.titleS && el < tl.titleS) drawCard(f, 'title', el / tl.titleS, { caption, sub: fontText(titleSub), t });
    tl.transitions.forEach((tr, i) => {
      const p = el - tr.at;
      if (p < 0 || p > TRANSITION_S) return;
      if (p < IRIS.close) drawIris(f, 1 - p / IRIS.close);
      else if (p < IRIS.close + IRIS.hold) {
        drawIris(f, 0);
        drawSegmentCard(f, clockFmt.format(new Date(tl.segments[i + 1].from)), clockLabel, t);
      } else drawIris(f, (p - IRIS.close - IRIS.hold) / IRIS.open);
    });
    if (tl.endS && el > seconds - tl.endS) drawCard(f, 'end', Math.min(1, (el - (seconds - tl.endS)) / tl.endS), { caption: endCaption, sub: fontText(endSub), t });
  };
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  const started = new Promise((resolve) => {
    recorder.onstart = () => {
      t0 = performance.now();
      S.startReplay(datas[0], tl.segments[0].dur, tl.titleS, 'record');
      resolve();
    };
  });
  S.recording = true;
  recorder.start(250);
  await started;
  S.onFrame = (now) => {
    const el = (now - t0) / 1000;
    // switch to the next window while the iris is closed (the world is rebuilt behind the black)
    if (next < tl.segments.length && el >= tl.segments[next].start) {
      const sg = tl.segments[next];
      S.startReplay(datas[next], sg.dur, Math.max(0, sg.playAt - el), 'record');
      next += 1;
    }
    if (el >= seconds && recorder.state === 'recording') recorder.stop();
  };
  await stopped;
  S.onFrame = null;
  S.cards = null;
  S.recording = false;
  stream.getTracks().forEach((tr) => tr.stop());
  S.stopReplay();
  const blob = new Blob(chunks, { type: mime.split(';')[0] });
  window.__lastClip = blob;
  const base64 = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('could not read the recording'));
    r.readAsDataURL(blob);
  });
  return { mime, size: blob.size, seconds, timeline: tl, base64 };
}

/**
 * Record a clip. opts: { seconds, from, to (ISO, a past window), frames, title, end, fps, bitrate }.
 * Without from/to it records the live stage. Resolves { mime, size, seconds, base64 }.
 */
export async function record({ seconds = 45, from = null, to = null, frames = null, title = '', end = '', fps = 30, bitrate = 12e6 } = {}) {
  const S = window.__theater && window.__theater.stage;
  if (!S) throw new Error('the stage is not ready');
  const mime = pickMime();
  if (!mime || !S.out.captureStream) throw new Error('this browser cannot record the canvas');
  const caption = cardWords(title);
  const endCaption = cardWords(end);
  const titleS = caption ? 2.5 : 0;
  const endS = endCaption ? 3 : 0;
  const data = from && to ? await S.fetchReplay({ from, to }, frames || Math.min(900, Math.max(60, Math.round(seconds * 14)))) : null;
  const stream = S.out.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  let t0 = performance.now();
  S.cards = (f, now, t, drawCard) => {
    const el = (now - t0) / 1000;
    if (titleS && el < titleS) drawCard(f, 'title', el / titleS, { caption, sub: '', t });
    if (endS && el > seconds - endS) drawCard(f, 'end', Math.min(1, (el - (seconds - endS)) / endS), { caption: endCaption, sub: '', t });
  };
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  const started = new Promise((resolve) => {
    recorder.onstart = () => {
      t0 = performance.now();
      // the time-lapse plays between the cards, starting as the recorder starts
      if (data) S.startReplay(data, Math.max(4, seconds - titleS - endS), titleS, 'record');
      resolve();
    };
  });
  S.recording = true;
  recorder.start(250);
  await started;
  S.onFrame = (now) => {
    if ((now - t0) / 1000 >= seconds && recorder.state === 'recording') recorder.stop();
  };
  await stopped;
  S.onFrame = null;
  S.cards = null;
  S.recording = false;
  stream.getTracks().forEach((tr) => tr.stop());
  if (data) S.stopReplay();
  const blob = new Blob(chunks, { type: mime.split(';')[0] });
  window.__lastClip = blob;
  const base64 = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('could not read the recording'));
    r.readAsDataURL(blob);
  });
  return { mime, size: blob.size, seconds, base64 };
}

/**
 * Play the last recorded clip back in the page and grab frames at the given times (seconds), as PNG
 * data URLs, with the decoded size and duration. Used to check the file and how crisp its pixels are.
 */
export async function inspectLastClip(times) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.src = URL.createObjectURL(window.__lastClip);
  document.body.appendChild(v);
  await v.play();
  const want = [...times].sort((a, b) => a - b);
  const frames = [];
  let lastTime = 0;
  await new Promise((resolve) => {
    const cb = (now, meta) => {
      lastTime = meta.mediaTime;
      if (want.length && meta.mediaTime >= want[0]) {
        const c = document.createElement('canvas');
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0);
        frames.push({ t: meta.mediaTime, png: c.toDataURL('image/png') });
        want.shift();
      }
      if (!v.ended) v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
    v.onended = () => resolve();
    setTimeout(resolve, (Math.max(...times, 1) + 20) * 1000);
  });
  const out = { width: v.videoWidth, height: v.videoHeight, played: Math.max(lastTime, v.currentTime), duration: v.duration, frames };
  v.remove();
  return out;
}
