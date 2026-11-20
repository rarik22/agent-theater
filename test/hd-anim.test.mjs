// HD slice: state-to-animation mapping (clips per action kind, frame parameters, pulses, machine state).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLIPS, KINDS, TYPE_HANDS, batchProgress, blinkAt, breatheAt, clipFor, clipName, coderPose, mergeState, pulsesAt, seedOf } from '../public/hd/hd-anim.mjs';

test('every action kind maps to a clip with a meaningful screen', () => {
  assert.equal(clipName('edit'), 'type');
  assert.equal(clipName('search'), 'search');
  assert.equal(clipName('read'), 'read');
  for (const k of ['run', 'test', 'docker', 'browser']) assert.equal(clipName(k), 'watch');
  assert.equal(clipName('think'), 'think');
  assert.equal(clipName('wait'), 'wait');
  assert.equal(clipName('anything else'), 'think', 'unknown kinds rest, they never fake typing');
  for (const k of KINDS) assert.ok(CLIPS[clipName(k)].screen);
  assert.equal(clipFor('edit').pose, 'type');
  assert.equal(clipFor('wait').screen, 'hourglass');
  assert.equal(clipFor('think').pulse, 0, 'no data leaves a thinking station');
});

test('typing hands follow the clip frame rate; resting poses keep hands down', () => {
  const seen = new Set();
  for (let i = 0; i < 12; i += 1) {
    const p = coderPose('edit', i / 10, 0);
    assert.equal(p.pose, 'type');
    seen.add(`${p.handL}${p.handR}`);
  }
  assert.ok(seen.size >= 3, 'several hand frames within a second');
  assert.ok(TYPE_HANDS.length >= 4);
  const rest = coderPose('test', 1.234, 5);
  assert.equal(rest.pose, 'rest');
  assert.equal(rest.handL, 'down');
  assert.deepEqual(coderPose('edit', 3.3, 7), coderPose('edit', 3.3, 7), 'deterministic');
});

test('calm (reduced motion) freezes hands, blinks and breathing but keeps the pose', () => {
  const p = coderPose('edit', 2.7, 3, true);
  assert.equal(p.pose, 'type');
  assert.equal(p.eyes, 'open');
  assert.equal(p.breathe, 0);
  assert.equal(p.bob, 0);
});

test('blinks are short and rare; breathing is a slow cycle', () => {
  let open = 0;
  let shut = 0;
  for (let i = 0; i < 1000; i += 1) {
    const b = blinkAt(i * 0.01, 4);
    if (b === 'open') open += 1;
    if (b === 'shut') shut += 1;
  }
  assert.ok(open > 900, `eyes open ${open / 10}% of the time`);
  assert.ok(shut > 0, 'but they do close');
  const lifted = Array.from({ length: 340 }, (_, i) => breatheAt(i * 0.01)).filter(Boolean).length;
  assert.ok(lifted > 100 && lifted < 200, 'about half of a 3.4 s cycle');
});

test('data pulses leave working stations only, as positions along the run', () => {
  assert.deepEqual(pulsesAt('think', 10), []);
  assert.deepEqual(pulsesAt('wait', 10), []);
  const p = pulsesAt('edit', 10, 3, 1.6);
  assert.ok(p.length >= 1);
  for (const v of p) assert.ok(v >= 0 && v <= 1);
  assert.ok(pulsesAt('test', 10, 3, 1.6).length >= p.length, 'tests stream faster than edits');
});

test('the merge machine state follows the batch and the last merge or bounce', () => {
  assert.equal(mergeState({}), 'idle');
  assert.equal(mergeState({ batchRunning: true }), 'working');
  assert.equal(mergeState({ windowCount: 2 }), 'working');
  assert.equal(mergeState({ batchRunning: true, sinceMerged: 1 }), 'pass');
  assert.equal(mergeState({ batchRunning: true, sinceMerged: 9 }), 'working', 'the pass light holds for a few seconds');
  assert.equal(mergeState({ sinceBounced: 0.5, sinceMerged: 2 }), 'fail');
  assert.equal(mergeState({ sinceBounced: 1, sinceMerged: 1 }), 'pass', 'merges landing with a bounce still show green');
  assert.equal(batchProgress(0, 300_000), 0.5);
  assert.equal(batchProgress(0, 9e9), 0.97, 'never shows done before the merge lands');
  assert.equal(batchProgress(NaN, 5), 0);
  assert.equal(seedOf('a'), seedOf('a'));
  assert.ok(seedOf('a') >= 0 && seedOf('a') < 997);
});

test('every role has a pose for every action kind; walking, thinking and waiting read as such', async () => {
  const { rolePose, ROLE_WORK } = await import('../public/hd/hd-anim.mjs');
  for (const role of Object.keys(ROLE_WORK)) for (const kind of KINDS) {
    const p = rolePose(role, kind, 1.7, 3);
    assert.ok(typeof p.pose === 'string' && Number.isInteger(p.k));
  }
  assert.equal(rolePose('fixer', 'edit', 1, 0).pose, 'low');
  assert.equal(rolePose('merger', 'test', 1, 0).pose, 'lever');
  assert.equal(rolePose('reviewer', 'read', 1, 0).pose, 'reach');
  assert.equal(rolePose('preparer', 'run', 1, 0).pose, 'tape');
  assert.equal(rolePose('setup', 'docker', 1, 0).pose, 'press');
  assert.equal(rolePose('verifier', 'test', 1, 0).pose, 'hold');
  const think = rolePose('reviewer', 'think', 1, 0);
  assert.equal(think.pose, 'think');
  assert.equal(think.bubble, 'think');
  assert.equal(rolePose('helper', 'wait', 1, 0).bubble, 'wait');
  assert.equal(rolePose('coder', 'edit', 1, 0, { walking: true }).pose, 'walk');
  const ks = new Set(Array.from({ length: 12 }, (_, i) => rolePose('fixer', 'edit', i / 10, 0).k));
  assert.ok(ks.size >= 3, 'work frames advance');
  assert.equal(rolePose('fixer', 'edit', 3.3, 0, { calm: true }).k, 0, 'calm freezes the frame');
});
