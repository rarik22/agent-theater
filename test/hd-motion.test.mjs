// HD stage: the scene never freezes. With a state that does not change for 10 s, frames keep changing
// (ambient motion and the agents' own animation), in full motion and in the softer ?calm=1 clock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleFullMoment, sampleStateAt } from '../lib/sample.mjs';
import { createRenderer, renderFrame } from '../public/hd/hd-render.mjs';
import { applyState, createWorld, step } from '../public/hd/hd-world.mjs';
import { NEUTRAL, lane, stateWith } from './client-helpers.mjs';

const cfg = { maxEvents: 60, slotCount: 4 };
const G = sampleFullMoment();
const hash = (px) => {
  let h = 2166136261;
  for (let i = 0; i < px.length; i += 1) h = Math.imul(h ^ px[i], 16777619);
  return h >>> 0;
};

/** Frame hashes every `every` seconds over `seconds`, with the state applied once and never again. */
function watch(state, { seconds = 10, every = 0.5, rate = 1, aspect = '16:9' } = {}) {
  const w = createWorld({ aspect });
  applyState(w, state, { first: true });
  const rd = createRenderer();
  const hashes = [];
  for (let i = 0; i <= seconds / every; i += 1) {
    hashes.push(hash(renderFrame(rd, w, {}).px));
    for (let k = 0; k < Math.round(every * 60); k += 1) step(w, (1 / 60) * rate);
  }
  return hashes;
}
const changes = (h) => h.slice(1).filter((v, i) => v !== h[i]).length;

test('with a static state full of agents, every half second looks different for 10 s', () => {
  const h = watch(sampleStateAt(cfg, G));
  assert.equal(changes(h), h.length - 1);
});

test('with nobody working and nothing queued, the stage still moves (ambient only)', () => {
  const empty = stateWith({ lanes: [lane('W1', NEUTRAL, { active: false }), lane('W2', NEUTRAL, { active: false })] });
  const h = watch(empty);
  assert.ok(changes(h) >= h.length - 2, `${changes(h)} of ${h.length - 1} steps changed`);
  // and it does so in every shape
  for (const aspect of ['1:1', '4:5']) {
    const hh = watch(empty, { aspect, seconds: 4 });
    assert.ok(changes(hh) >= hh.length - 2, aspect);
  }
});

test('the calm clock (?calm=1, half speed) softens the motion but never freezes it', () => {
  const h = watch(sampleStateAt(cfg, G), { rate: 0.5 });
  assert.ok(changes(h) >= h.length - 2, `${changes(h)} of ${h.length - 1}`);
});
