// HD stage on phones: the 9:16 layout, the sideways phone build (big labels), the device-pixel fit,
// and the controller's numbers drawn at twice the font size where the phone builds need them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleFullMoment, sampleStateAt } from '../lib/sample.mjs';
import { CTRL_GEOMS, geomFor } from '../public/hd/hd-controller.mjs';
import { FONT, textWidth } from '../public/hd/hd-font.mjs';
import { ASPECTS, aspectForWindow, computeLayout, fitScale, outputSize, overlaps } from '../public/hd/hd-layout.mjs';
import { DEFAULT_STATIONS } from '../public/hd/hd-scene.mjs';
import { R } from '../public/hd/hd-palette.mjs';
import { createRenderer, renderFrame } from '../public/hd/hd-render.mjs';
import { applyState, createWorld, setAspect } from '../public/hd/hd-world.mjs';

const cfg = { maxEvents: 60, slotCount: 4 };
const G = sampleFullMoment();
const ids = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8'];
const STATION_TAGS = DEFAULT_STATIONS.map((s) => s.tag);
const inside = (b, L) => b.x >= 0 && b.y >= 0 && b.x + b.w <= L.w && b.y + b.h <= L.h;

/** Read glyphs of the 5x7 font drawn at a whole scale in the ink colours, as words split at wide gaps. */
function ocr(f, x0, x1, y0, y1, inks, scale = 1) {
  const ink = new Set(inks);
  const on = (x, y) => ink.has(f.px[y * f.w + x]);
  const gw = 5 * scale;
  const gh = 7 * scale;
  const words = [];
  let word = '';
  let gap = 0;
  for (let x = x0; x <= x1 - gw; ) {
    let hit = null;
    for (let y = y0; y <= y1 - gh && hit === null; y += 1) {
      for (const [ch, rows] of Object.entries(FONT)) {
        if (ch === ' ') continue;
        let ok = true;
        for (let r = 0; r < gh && ok; r += 1) for (let i = 0; i < gw && ok; i += 1) if ((rows[Math.floor(r / scale)][Math.floor(i / scale)] === '1') !== on(x + i, y + r)) ok = false;
        for (let r = 0; r < gh && ok; r += 1) if (on(x - 1, y + r) || on(x + gw, y + r)) ok = false;
        if (ok) {
          hit = ch;
          break;
        }
      }
    }
    if (hit !== null) {
      if (gap > 6 * scale && word) {
        words.push(word);
        word = '';
      }
      word += hit;
      gap = 0;
      x += 6 * scale;
    } else {
      gap += 1;
      x += 1;
    }
  }
  if (word) words.push(word);
  return words;
}

test('the window shape picks the layout: phones upright get 9:16, sideways 16:9, tablets 4:5', () => {
  assert.deepEqual(outputSize('9:16'), { w: 1080, h: 1920 });
  assert.equal(aspectForWindow(390, 844), '9:16');
  assert.equal(aspectForWindow(412, 915), '9:16');
  assert.equal(aspectForWindow(844, 390), '16:9');
  assert.equal(aspectForWindow(768, 1024), '4:5');
  assert.equal(aspectForWindow(1024, 1024), '1:1');
  assert.equal(aspectForWindow(1920, 1080), '16:9');
});

test('the canvas fits in device pixels: whole scales, the phone fill, and a crisp fractional fallback', () => {
  // 390x844 at DPR 3 = 1170 device px wide: 540 logical px at x2 = 1080 device px
  const a = fitScale(390, 844, 3, 540, 960);
  assert.deepEqual([a.scale, a.exact, a.devW, a.devH], [2, true, 1080, 1920]);
  assert.equal(a.cssW, 360);
  // 412x915 at DPR 2.625
  const b = fitScale(412, 915, 2.625, 540, 960);
  assert.deepEqual([b.scale, b.devW, b.devH], [2, 1080, 1920]);
  // a small phone: 1x would leave a quarter of the width empty, so the phone fill takes the fractional fit
  const whole = fitScale(375, 647, 2, 540, 960);
  assert.equal(whole.scale, 1);
  const filled = fitScale(375, 647, 2, 540, 960, { fill: 0.8 });
  assert.ok(!filled.exact && filled.scale > 1.3 && filled.devW <= 750 && filled.devH <= 1294);
  // a desktop window keeps whole scales
  assert.equal(fitScale(1920, 1080, 1, 960, 540, { fill: 0 }).scale, 2);
  // smaller than 1x: the largest fractional scale that fits, never larger than the screen
  const tiny = fitScale(300, 200, 1, 960, 540);
  assert.ok(tiny.scale < 1 && tiny.devW <= 300 && tiny.devH <= 200);
});

test('the 9:16 phone layout keeps every piece inside, apart, and its labels inside their plates', () => {
  const L = computeLayout(ids, '9:16');
  assert.deepEqual([L.w, L.h, L.ts, L.big], [ASPECTS['9:16'].w, ASPECTS['9:16'].h, 2, true]);
  assert.equal(L.rows.length, 8);
  assert.equal(geomFor(L.ctrl), CTRL_GEOMS.strip);
  assert.ok(inside(L.ctrl, L) && L.ctrl.w === CTRL_GEOMS.strip.w && L.ctrl.h === CTRL_GEOMS.strip.h);
  // the dock is under the controller strip, above the header band
  assert.ok(L.dock.y - 47 >= L.ctrl.y + L.ctrl.h - 2 && L.dock.y + 8 <= L.headerY - 6);
  assert.ok(L.dock.x1 > L.dock.x + 300);
  for (let i = 1; i < L.rows.length; i += 1) assert.ok(L.rows[i].y >= L.rows[i - 1].y + L.rows[i - 1].h);
  assert.ok(L.rows[L.rows.length - 1].y + L.rows[L.rows.length - 1].h < L.yard.y);
  for (const b of [L.merge, L.rack, L.vault, L.cloud]) assert.ok(inside(b, L), JSON.stringify(b));
  const boxes = [L.merge, L.rack, L.vault, L.cloud];
  for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) assert.ok(!overlaps(boxes[i], boxes[j]), `yard ${i} and ${j}`);
  // the queue column ends at the intake, right of the machine; cables run from the machine up to the rack
  assert.ok(L.queue.x >= L.station.x1 && L.queue.x1 <= L.w);
  assert.equal(L.chute.y + L.chute.h, L.queue.y1);
  assert.ok(L.cables.every((c) => c[0].y > c[c.length - 1].y && c[c.length - 1].y === L.rack.y + L.rack.h));
  // big labels fit: station tags within their columns, lane names within the chip, yard names inside
  for (const tag of STATION_TAGS) assert.ok(textWidth(tag, 1, 2) <= L.station.w - 8, tag);
  assert.ok(textWidth('API', 1, 2) <= L.chip.w - 4 && 14 <= L.chip.h - 4);
  // a longer lane code falls back to the small font, which still fits the plate
  assert.ok(textWidth('W-1234', 1, 1) <= L.chip.w - 4);
  for (const [k, s] of [['test', 'TEST'], ['merge', 'MERGE'], ['develop', 'DEVELOP'], ['remote', 'REMOTE']]) {
    const lb = L.labels[k];
    const box = { x: Math.round(lb.cx - textWidth(s, 1, 2) / 2), y: lb.y, w: textWidth(s, 1, 2), h: 14 };
    assert.ok(inside(box, L), `${k} label inside`);
    for (const b of [L.merge, L.rack, L.vault, L.cloud]) assert.ok(!overlaps(box, b), `${k} label clear of the machines`);
  }
});

test('the sideways phone build: big labels, the compact strip with the dock beside it, up to 7 rows', () => {
  const L = computeLayout(ids, '16:9', { big: true });
  assert.deepEqual([L.ts, L.big, L.maxRows, L.rows.length], [2, true, 7, 7]);
  assert.equal(geomFor(L.ctrl), CTRL_GEOMS.stripS);
  assert.ok(L.dock.x > L.ctrl.x + L.ctrl.w && L.dock.x1 - L.dock.x >= 100);
  assert.ok(L.rows.at(-1).y + L.rows.at(-1).h <= L.h - 10);
  for (const tag of STATION_TAGS) assert.ok(textWidth(tag, 1, 2) <= L.station.w - 8, tag);
  // the desktop and video builds stay as they were
  const D = computeLayout(ids, '16:9');
  assert.deepEqual([D.ts, D.big, D.maxRows, D.ctrl.w], [1, false, 8, 236]);
});

test('the phone builds draw the real totals with the font at twice its size', () => {
  const state = sampleStateAt(cfg, G);
  const s = { ...state, project: { ...state.project, done: 123, total: 600, features: { done: 77, total: 400 }, batch: null }, queue: { ...state.queue, batch: { n: 7, slugs: [], startedAt: state.now, status: 'running' } } };
  for (const [aspect, big] of [['9:16', false], ['16:9', true]]) {
    const w = createWorld({ aspect, big });
    applyState(w, s, { first: true });
    const rd = createRenderer();
    const f = renderFrame(rd, w, {});
    const L = w.layout;
    const GM = geomFor(L.ctrl);
    const cx = L.ctrl.x;
    const cy = L.ctrl.y;
    const band = (b, inks) => ocr(f, cx + b.x, cx + b.x + b.w, cy + b.y, cy + b.y + b.h, inks, 2);
    assert.deepEqual(band(GM.jobs, [R.cyan[3], R.cyan[4], R.cyan[5]]), ['123/600', '20%'], `${aspect} jobs`);
    assert.deepEqual(band(GM.feat, [R.mint[3], R.mint[4]]), ['77/400'], `${aspect} features`);
    assert.deepEqual(band(GM.batch, [R.amber[4], R.amber[5]]), ['7'], `${aspect} batch`);
    const onStage = [...w.agents.values()].filter((e) => e.state !== 'out').length;
    const rg = GM.ring;
    assert.deepEqual(ocr(f, cx + rg.x - 14, cx + rg.x + 14, cy + rg.y - 10, cy + rg.y + 10, [R.cyan[4], R.cyan[5]], 2), [String(onStage)], `${aspect} agents`);
    assert.deepEqual([rd.readout.jobs, rd.readout.pct, rd.readout.features, rd.readout.batch], ['123/600', '20%', '77/400', '7']);
  }
  // switching a world to the phone build and back rebuilds its layout
  const w = createWorld({ aspect: '16:9' });
  applyState(w, s, { first: true });
  setAspect(w, '9:16', true);
  assert.equal(w.layout.ctrl.kind, 'strip');
  setAspect(w, '16:9', false);
  assert.equal(w.layout.ctrl.kind, 'unit');
});
