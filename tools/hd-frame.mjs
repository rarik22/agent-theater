// QA tool: render HD frames in Node with the same pure modules the browser uses.
//   node tools/hd-frame.mjs --sample <unixSeconds|full> --sim 12 --out x.png [--aspect 16:9|1:1|4:5|9:16] [--big] [--scale 2] [--crop x,y,w,h]
//   node tools/hd-frame.mjs --state state.json --sim 6 --out x.png
// --sample full picks a sample moment with every role and every console kind on stage.
// --sim N plays N seconds: the state is re-applied every 2 s (as the page polls) and the world steps
// at 60 fps, so parcels, pulses and the machine move exactly as on the page.
import { readFileSync, writeFileSync } from 'node:fs';
import { sampleFullMoment, sampleStateAt } from '../lib/sample.mjs';
import { toRGBA } from '../public/hd/hd-gfx.mjs';
import { createRenderer, renderFrame } from '../public/hd/hd-render.mjs';
import { applyState, createWorld, step } from '../public/hd/hd-world.mjs';
import { crop, encodePNG, scaleNN } from './png.mjs';

export function renderAt({ sample = null, state = null, sim = 0, calm = false, fps = 60, onFrame = null, aspect = "16:9", big = false } = {}) {
  const cfg = { maxEvents: 60, slotCount: 4 };
  const world = createWorld({ calm, aspect, big });
  const rd = createRenderer();
  const stateAt = (dt) => (sample !== null ? sampleStateAt(cfg, sample + dt) : state);
  applyState(world, stateAt(0), { first: true });
  let nextPoll = 2;
  const steps = Math.round(sim * fps);
  for (let i = 0; i < steps; i += 1) {
    step(world, 1 / fps);
    if (world.t >= nextPoll) {
      applyState(world, stateAt(nextPoll));
      nextPoll += 2;
    }
    if (onFrame) onFrame(world, rd, i);
  }
  const f = renderFrame(rd, world, { calm, sample: sample !== null || state?.sample === true });
  return { world, frame: f };
}

export function framePNG(f, { scale = 2, region = null } = {}) {
  let img = { w: f.w, h: f.h, data: toRGBA(f) };
  if (region) img = crop(img, region.x, region.y, region.w, region.h);
  img = scaleNN(img, scale);
  return { img, png: encodePNG(img.w, img.h, img.data) };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name, d = null) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : d;
  };
  const sample = opt('sample') === 'full' ? sampleFullMoment() : opt('sample') !== null ? Number(opt('sample')) : null;
  const state = opt('state') ? JSON.parse(readFileSync(opt('state'), 'utf8')) : null;
  const { frame } = renderAt({ sample, state, sim: Number(opt('sim', 0)), calm: args.includes('--calm'), aspect: opt('aspect', '16:9'), big: args.includes('--big') });
  const c = opt('crop');
  const region = c ? Object.fromEntries(c.split(',').map(Number).map((v, i) => [['x', 'y', 'w', 'h'][i], v])) : null;
  const { img, png } = framePNG(frame, { scale: Number(opt('scale', 2)), region });
  writeFileSync(opt('out', 'hd-frame.png'), png);
  console.log(`wrote ${opt('out', 'hd-frame.png')} ${img.w}x${img.h}`);
}
