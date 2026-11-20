// Speech bubbles on the stage: the tiny font, the words a bubble says, where bubbles go (never over
// each other, always inside the frame), what a click hits, and the frame they are drawn into.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleFullMoment, sampleStateAt } from '../lib/sample.mjs';
import { agentAt, bubbleH, bubbleLine, bubbleStyle, layoutBubbles, shortDuration, typedChars } from '../public/hd/hd-bubbles.mjs';
import { R } from '../public/hd/hd-palette.mjs';
import { createRenderer, renderFrame } from '../public/hd/hd-render.mjs';
import { cleanSay } from '../public/hd/hd-scene.mjs';
import { TINY, TINY_H, tinyClean, tinyFit, tinyWidth } from '../public/hd/hd-tiny.mjs';
import { applyState, createWorld, step } from '../public/hd/hd-world.mjs';

test('the tiny font: every glyph has six rows inside its width; text is cleaned and cut to fit', () => {
  for (const [ch, g] of Object.entries(TINY)) {
    assert.equal(g.rows.length, TINY_H, `glyph ${ch}`);
    for (const row of g.rows) for (const x of row) assert.ok(x >= 0 && x < g.w, `glyph ${ch} ink outside its width`);
  }
  for (const ch of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:;!?\'"-_/()[]<>=+*%#@&') assert.ok(TINY[ch], `missing ${ch}`);
  assert.equal(tinyClean('Café “ok” — tab\there\u0007'), 'Cafe "ok" - tab here');
  assert.equal(tinyClean('日本'), '??');
  assert.equal(tinyWidth('ab'), 7);
  assert.equal(tinyWidth('ab', 2), 14);
  const cut = tinyFit('Running the whole test suite for the upload client', 60);
  assert.ok(cut.endsWith('…') && tinyWidth(cut) <= 60, cut);
  assert.equal(tinyFit('short', 60), 'short');
  assert.ok(tinyWidth(tinyFit('Running the whole test suite', 60, 2), 2) <= 60);
});

test('a bubble\'s words: a capital first letter; in public mode, how long the action has run', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  assert.equal(bubbleLine({ say: 'running tests', publicMode: true, sinceMs: now - 30_000, nowMs: now }), 'Running tests');
  assert.equal(bubbleLine({ say: 'running tests', publicMode: true, sinceMs: now - 200_000, nowMs: now }), 'Running tests · 3m');
  assert.equal(bubbleLine({ say: 'Fixing the cart total.', publicMode: false, sinceMs: now - 900_000, nowMs: now }), 'Fixing the cart total.');
  assert.equal(bubbleLine({ say: 'running a live check (background)', background: true }), 'Running a live check');
  assert.equal(bubbleLine({ say: '   ' }), '');
  assert.deepEqual([shortDuration(45_000), shortDuration(200_000), shortDuration(4_800_000), shortDuration(7_200_000)], ['45s', '3m', '1h20m', '2h']);
  assert.deepEqual(['think', 'wait', 'edit'].map((k) => bubbleStyle(k)), ['think', 'wait', 'say']);
  assert.equal(bubbleStyle('test', true), 'background');
  assert.equal(cleanSay('a\u0000b\n  c'.padEnd(400, 'x')).length, 160);
  assert.equal(cleanSay(42), '');
  assert.equal(typedChars(1), 45);
});

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('bubbles sit above heads, below the dock plates, never over each other and inside the frame', () => {
  const speakers = [
    { id: 'a', x: 100, y: 132, text: 'Writing the login form change.' },
    { id: 'b', x: 150, y: 132, text: 'Reading how the upload client works.' },
    { id: 'c', x: 250, y: 132, text: 'Thinking' },
    { id: 'd', x: 276, y: 50, place: 'dock', text: 'Reading code' },
    { id: 'e', x: 324, y: 50, place: 'dock', text: 'Searching the code' },
    { id: 'f', x: 955, y: 300, text: 'At the right edge of the frame' },
    { id: 'g', x: 400, y: 40, text: 'Too near the top for above' },
    { id: 'h', x: 500, y: 132, text: '' },
  ];
  const boxes = layoutBubbles(speakers, 960, 540);
  assert.deepEqual(boxes.map((b) => b.id).sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  for (const b of boxes) {
    assert.ok(b.x >= 1 && b.x + b.w <= 959 && b.y >= 0 && b.y + b.h <= 540, `${b.id} inside`);
    assert.ok(tinyWidth(b.text) <= b.w - 6, `${b.id} text fits`);
  }
  for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) assert.ok(!overlap(boxes[i], boxes[j]), `${boxes[i].id} and ${boxes[j].id} overlap`);
  const by = Object.fromEntries(boxes.map((b) => [b.id, b]));
  assert.equal(by.a.y + by.a.h, 132 - 46 - 2, 'above the head');
  assert.equal(by.a.tail.dir, 'down');
  assert.ok(by.a.text.endsWith('…'), 'a crowded bubble is cut');
  assert.equal(by.c.text, 'Thinking');
  assert.ok(by.d.y > 50 && by.d.tail.dir === 'up', 'a dock bubble hangs below its plate');
  assert.equal(by.g.tail.dir, 'left', 'no room above: beside the head');
  // 2x lettering (the phone build) makes taller bubbles
  const big = layoutBubbles([{ id: 'a', x: 100, y: 132, text: 'Writing code' }], 540, 960, { scale: 2, maxW: 168 });
  assert.equal(big[0].h, bubbleH(2));
  assert.equal(big[0].y + big[0].h, 132 - 46);
});

test('a click hits a bubble first, then the front-most character, else nothing', () => {
  const agents = [{ id: 'back', x: 100, y: 120 }, { id: 'front', x: 104, y: 130 }, { id: 'gone', x: 300, y: 130, state: 'out' }];
  const boxes = [{ id: 'bubbled', x: 200, y: 20, w: 40, h: 10 }];
  assert.equal(agentAt(210, 25, agents, boxes), 'bubbled');
  assert.equal(agentAt(104, 110, agents, boxes), 'front');
  assert.equal(agentAt(100, 76, agents, boxes), 'back');
  assert.equal(agentAt(300, 110, agents, boxes), null);
  assert.equal(agentAt(600, 400, agents, boxes), null);
});

test('the frame has a bubble for every agent on stage; ?bubbles=0 draws none', () => {
  const g = sampleFullMoment();
  const world = createWorld({ aspect: '16:9' });
  const rd = createRenderer();
  applyState(world, sampleStateAt({}, g), { first: true });
  step(world, 0.5);
  const f = renderFrame(rd, world, { sample: true });
  const onStage = [...world.agents.values()].filter((e) => e.state !== 'out' && !e.walking);
  assert.equal(rd.bubbles.length, onStage.length);
  const paper = rd.bubbles.filter((b) => b.style === 'say').map((b) => f.px[(b.y + 1) * f.w + b.x + 1]);
  assert.ok(paper.every((c) => c === R.steel[4]), 'speech bubbles are white paper');
  renderFrame(rd, world, { sample: true, bubbles: false });
  assert.equal(rd.bubbles.length, 0);
  // the selected agent's bubble is marked
  const id = onStage[0].id;
  renderFrame(rd, world, { sample: true, selected: id });
  assert.equal(rd.bubbles.find((b) => b.id === id).selected, true);
});

test('a new line is lettered in; the first state shows every bubble whole', () => {
  const g = sampleFullMoment();
  const world = createWorld({ aspect: '16:9' });
  applyState(world, sampleStateAt({}, g), { first: true });
  assert.ok([...world.agents.values()].every((e) => e.sayT0 === -Infinity));
  // the sample changes what agents do every few seconds: some line changes within 14 s
  for (let s = 2; s <= 14; s += 2) {
    step(world, 2);
    applyState(world, sampleStateAt({}, g + s));
  }
  assert.ok([...world.agents.values()].some((e) => Number.isFinite(e.sayT0)));
});
