// The README's pictures, drawn in Node from the labelled sample with the same modules the page uses, and
// written as lossless GIFs (tools/gif.mjs) and PNGs. No browser needed. Every picture shows sample data.
//
//   node tools/readme-media.mjs [--out docs/images] [--only banner,stage,phone,cast,handoff,yard,timelapse,tour,bubbles]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sampleReplay, sampleStateAt } from '../lib/sample.mjs';
import { dot, hline, rect, text, toRGBA } from '../public/hd/hd-gfx.mjs';
import { R, RGB, SHADE } from '../public/hd/hd-palette.mjs';
import { createRenderer, renderFrame } from '../public/hd/hd-render.mjs';
import { applyState, createWorld, step } from '../public/hd/hd-world.mjs';
import { GifWriter, cropIndexed, scaleIndexed } from './gif.mjs';
import { encodePNG, scaleNN } from './png.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const CFG = { maxEvents: 60, slotCount: 4 };
const SIM_FPS = 60;
// a busy stretch of the sample: hand-overs in four lanes, a merge, a push and finished runs
const BUSY = 1_795_003_030;
// a moment with every role and every console kind on stage (sampleFullMoment())
const FULL = 1_795_003_560;

const args = process.argv.slice(2);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : d;
};
const OUT = resolve(ROOT, opt('out', 'docs/images'));
const ONLY = new Set(String(opt('only', 'banner,stage,phone,cast,handoff,yard,timelapse,tour,bubbles')).split(','));

/** The hundredths of a second frame k of a film at `fps` lasts, so the total stays exact. */
const delayOf = (k, fps) => Math.round(((k + 1) * 100) / fps) - Math.round((k * 100) / fps);

/**
 * Film the sample: the world is stepped at 60 fps and given the sample's state every 2 s, as the page
 * does; after `warm` seconds, every frame at `fps` is drawn, optionally painted over, cut and scaled.
 */
function film({ g0, seconds, fps = 15, warm = 4, aspect = '16:9', big = false, crop = null, scale = 1, paint = null, onWarm = null, only = null, publicMode = true, bubbles = true }) {
  const world = createWorld({ aspect, big });
  const rd = createRenderer();
  // `only` keeps the agents it accepts (a close-up of one character, with nobody beside it)
  const stateAt = (g) => {
    const s = sampleStateAt(CFG, g, { publicMode });
    return only ? { ...s, agents: s.agents.filter(only) } : s;
  };
  applyState(world, stateAt(g0), { first: true });
  let nextPoll = 2;
  const per = SIM_FPS / fps;
  if (!Number.isInteger(per)) throw new Error('fps must divide 60');
  const warmSteps = Math.round(warm * SIM_FPS);
  const total = warmSteps + Math.round(seconds * SIM_FPS);
  let gif = null;
  let box = crop;
  let k = 0;
  for (let i = 0; i < total; i += 1) {
    step(world, 1 / SIM_FPS);
    if (world.t >= nextPoll) {
      applyState(world, stateAt(g0 + nextPoll));
      nextPoll += 2;
    }
    if (i === warmSteps - 1 && onWarm) box = onWarm(world) || box;
    if (i < warmSteps || (i - warmSteps) % per !== 0) continue;
    const f = renderFrame(rd, world, { sample: true, bubbles });
    if (paint) paint(f, world);
    let px = f.px;
    let w = f.w;
    let h = f.h;
    if (box) {
      px = cropIndexed(px, w, box);
      w = box.w;
      h = box.h;
    }
    px = scaleIndexed(px, w, h, scale);
    gif ??= new GifWriter(w * scale, h * scale, RGB);
    gif.add(px, delayOf(k, fps));
    k += 1;
  }
  return gif.finish();
}

function save(name, buf) {
  writeFileSync(join(OUT, name), buf);
  console.log(`${name.padEnd(22)} ${(buf.length / 1024).toFixed(0).padStart(6)} kB`);
}

const clampBox = (b, W, H) => {
  const x = Math.max(0, Math.min(W - b.w, Math.round(b.x)));
  const y = Math.max(0, Math.min(H - b.h, Math.round(b.y)));
  return { x, y, w: b.w, h: b.h };
};

// ---------------------------------------------------------------- the title card banner
const TITLE = 'AGENT THEATER';
const SUB = 'A LIVE PIXEL-ART STAGE FOR YOUR AI AGENTS';
const BAND = { x: 0, y: 140, w: 960, h: 250 };

function paintTitle(f, world) {
  // the stage dims behind the card, darker towards the band's edges
  for (let y = BAND.y; y < BAND.y + BAND.h; y += 1) {
    const edge = Math.min(y - BAND.y, BAND.y + BAND.h - 1 - y);
    const lut = SHADE[edge < 18 ? 2 : 1];
    for (let x = 0; x < f.w; x += 1) f.px[y * f.w + x] = lut[f.px[y * f.w + x]];
  }
  const scale = 4;
  const tw = (TITLE.length * 6 - 1) * scale;
  const sw = SUB.length * 6 - 1;
  const w = Math.max(tw, sw) + 64;
  const h = 7 * scale + 50;
  const x = Math.round((f.w - w) / 2);
  const y = Math.round(BAND.y + (BAND.h - h) / 2);
  rect(f, x - 2, y - 2, w + 4, h + 4, R.void[0]);
  rect(f, x, y, w, h, R.panel[1]);
  hline(f, x, y, w, R.panel[4]);
  hline(f, x, y + h - 1, w, R.panel[0]);
  for (const [cx, cy] of [[x + 3, y + 3], [x + w - 4, y + 3], [x + 3, y + h - 4], [x + w - 4, y + h - 4]]) dot(f, cx, cy, R.steel[2]);
  text(f, TITLE, Math.round(x + (w - tw) / 2), y + 13, R.amber[4], { top: R.amber[5], shadow: R.void[0], scale });
  const ry = y + 13 + 7 * scale + 9;
  const sweep = Math.floor((world.t * 120) % (w - 24));
  hline(f, x + 12, ry, w - 24, R.cyan[1]);
  hline(f, x + 12 + sweep, ry, Math.min(16, w - 24 - sweep), R.cyan[4]);
  text(f, SUB, Math.round(x + (w - sw) / 2), ry + 6, R.steel[3]);
}

// ---------------------------------------------------------------- the map of the stage
const TOUR = [
  [1, 'ctrl', (L) => [L.ctrl.x + L.ctrl.w - 12, L.ctrl.y + L.ctrl.h + 8]],
  [2, 'dock', (L) => [L.dock.x + 112, L.dock.y - 30]],
  [3, 'lanes', (L) => [L.chip.x + 18, L.rows[0].chip.y - 12]],
  [4, 'stations', (L) => [L.station.x + 8, L.rows[0].y + 12]],
  [5, 'queue', (L) => [L.queue.x + 13, L.queue.y0 - 4]],
  [6, 'test', (L) => [L.rack.x - 10, L.rack.y + 4]],
  [7, 'merge', (L) => [L.merge.x - 10, L.merge.y + 4]],
  [8, 'vault', (L) => [L.vault.x - 10, L.vault.y + 4]],
  [9, 'remote', (L) => [L.cloud.x - 10, L.cloud.y + 4]],
];

function paintBadges(f, world) {
  for (const [n, , at] of TOUR) {
    const [cx, cy] = at(world.layout);
    for (let dy = -8; dy <= 8; dy += 1) for (let dx = -8; dx <= 8; dx += 1) {
      const d = dx * dx + dy * dy;
      if (d <= 64 + 6) dot(f, cx + dx, cy + dy, d <= 42 ? R.amber[4] : R.void[0]);
    }
    hline(f, cx - 4, cy - 6, 9, R.amber[5]);
    text(f, String(n), cx - 2, cy - 3, R.void[0]);
  }
}

// ---------------------------------------------------------------- run
mkdirSync(OUT, { recursive: true });

if (ONLY.has('banner')) save('banner.gif', film({ g0: BUSY, seconds: 8, fps: 15, crop: BAND, paint: paintTitle }));

if (ONLY.has('stage')) save('stage.gif', film({ g0: BUSY, seconds: 16, fps: 15 }));

if (ONLY.has('phone')) save('phone.gif', film({ g0: BUSY, seconds: 12, fps: 15, aspect: '9:16', big: true }));

if (ONLY.has('handoff')) {
  // lane API, about 10 s in: its coder hands over to a reviewer, who walks from BUILD to REVIEW
  save('handoff.gif', film({
    g0: BUSY + 6,
    seconds: 12,
    fps: 15,
    scale: 3,
    onWarm: (w) => {
      const row = w.layout.rows.find((r) => r.id === 'API');
      return { x: 176, y: row.y + 2, w: 266, h: row.h + 2 };
    },
  }));
}

if (ONLY.has('yard')) save('yard.gif', film({ g0: BUSY + 8, seconds: 14, fps: 15, crop: { x: 574, y: 20, w: 386, h: 520 } }));

if (ONLY.has('cast')) {
  // one close-up per role, at a moment with every role on stage, each filmed alone at its own spot
  for (const role of ['setup', 'coder', 'reviewer', 'fixer', 'preparer', 'verifier', 'merger', 'helper']) {
    const first = sampleStateAt(CFG, FULL).agents.find((a) => a.role === role);
    if (!first) throw new Error(`no ${role} on stage`);
    save(`cast-${role}.gif`, film({
      g0: FULL,
      seconds: 4,
      fps: 12,
      warm: 1,
      scale: 3,
      only: (a) => a.id === first.id,
      // a portrait: no bubble (it would not fit the frame); the small thinking and waiting signs instead
      bubbles: false,
      onWarm: (w) => {
        const a = w.agents.get(first.id);
        const dx = a.facing === -1 ? -16 : 10;
        return clampBox({ x: a.x + dx - 40, y: a.y - 60, w: 80, h: 78 }, w.layout.w, w.layout.h);
      },
    }));
  }
}

if (ONLY.has('bubbles')) {
  // two lanes, close up, in the private view: the agents' own words, lettered in as they change
  save('bubbles.gif', film({ g0: BUSY + 6, seconds: 14, fps: 15, scale: 2, publicMode: false, crop: { x: 44, y: 72, w: 470, h: 148 } }));
}

if (ONLY.has('timelapse')) {
  // eight sample hours in 12 seconds, as ?timelapse=8 plays them (agents walk at 2.5x)
  const fps = 12;
  const seconds = 12;
  const replay = sampleReplay(CFG, { now: (BUSY + 3600) * 1000, hours: 8, frames: 240 });
  const world = createWorld({ aspect: '16:9' });
  const rd = createRenderer();
  applyState(world, replay.frames[0], { first: true });
  const fmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  const from = Date.parse(replay.from);
  const to = Date.parse(replay.to);
  const gif = new GifWriter(world.layout.w, world.layout.h, RGB);
  let idx = 0;
  const steps = seconds * SIM_FPS;
  for (let i = 0; i < steps; i += 1) {
    const p = i / steps;
    const want = Math.floor(p * (replay.frames.length - 1));
    while (idx < want) {
      idx += 1;
      applyState(world, replay.frames[idx]);
    }
    step(world, 1 / SIM_FPS, 2.5);
    if (i % (SIM_FPS / fps) !== 0) continue;
    const clock = fmt.format(new Date(from + p * (to - from)));
    const f = renderFrame(rd, world, { sample: true, timelapse: true, speed: 2.5, clock });
    gif.add(f.px, delayOf(i / (SIM_FPS / fps), fps));
  }
  save('timelapse.gif', gif.finish());
}

if (ONLY.has('tour')) {
  const world = createWorld({ aspect: '16:9' });
  const rd = createRenderer();
  applyState(world, sampleStateAt(CFG, FULL - 6), { first: true });
  for (let i = 0; i < 6 * SIM_FPS; i += 1) {
    step(world, 1 / SIM_FPS);
    if (i % (2 * SIM_FPS) === 2 * SIM_FPS - 1) applyState(world, sampleStateAt(CFG, FULL - 6 + Math.round(world.t)));
  }
  const f = renderFrame(rd, world, { sample: true });
  paintBadges(f, world);
  const img = scaleNN({ w: f.w, h: f.h, data: toRGBA(f) }, 2);
  save('tour.png', encodePNG(img.w, img.h, img.data));
}
