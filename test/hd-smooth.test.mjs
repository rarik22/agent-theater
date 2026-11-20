// Smooth time-lapses: a replay never teleports an agent. Short sessions inside a coarse step are not
// skipped, a job's sessions hand over in one frame, and a phase change of a run always plays a walk from
// where the last agent of the run stood to the next agent's station, at walking speed, frame by frame.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { livesInStep } from '../lib/replay.mjs';
import { sampleFullMoment, sampleStateAt } from '../lib/sample.mjs';
import { SPEED, applyState, createWorld, step } from '../public/hd/hd-world.mjs';

const cfg = { maxEvents: 60, slotCount: 4 };
const G = sampleFullMoment();

test('a replay step shows short sessions and hands a job over in one frame', () => {
  const life = (id, job, startMs, end) => ({ agent: { id, job, startMs }, end, uses: [] });
  const lives = [
    life('long', 'run-a', 0, 10_000), // alive through the step
    life('brief', 'run-b', 1_200, 1_800), // started and ended inside (1000, 2000]
    life('coder', 'run-c', 0, 1_500), // ended inside the step ...
    life('reviewer', 'run-c', 1_600, 9_000), // ... and the next session of its job started
    life('gone', 'run-d', 0, 900), // ended before the step
    life('later', 'run-e', 2_500, 9_000), // starts after the frame
  ];
  const picked = livesInStep(lives, 1_000, 2_000).map((p) => p.life.agent.id);
  assert.deepEqual(picked, ['long', 'brief', 'reviewer']);
  // the brief session's action is read inside its life, not after it
  const brief = livesInStep(lives, 1_000, 2_000).find((p) => p.life.agent.id === 'brief');
  assert.ok(brief.at >= 1_200 && brief.at < 1_800);
  // two brief sessions of one job in a step: the later one stands for the job
  const two = [life('a', 'J', 1_100, 1_300), life('b', 'J', 1_400, 1_700)];
  assert.deepEqual(livesInStep(two, 1_000, 2_000).map((p) => p.life.agent.id), ['b']);
  // the live end (an agent still running when the window ends now) counts as alive
  assert.deepEqual(livesInStep([life('now', 'J', 0, 5_000)], 4_000, 5_000, { liveEnd: 5_000 }).map((p) => p.life.agent.id), ['now']);
});

/**
 * Play replay frames the way the stage does: one frame every 1/14 s of playback (a 45 s video of a
 * 630-frame window), the world stepping at 60 fps with the time-lapse speed. Returns the samples of
 * agent `id` from its first appearance: [{ x, y, walking }].
 */
function play(frames, id, { fps = 60, frameRate = 14, speed = 2.5, seconds = 8 } = {}) {
  const w = createWorld({ aspect: '16:9' });
  applyState(w, frames[0], { first: true });
  const samples = [];
  let next = 1;
  let firstAt = null;
  for (let i = 0; i < seconds * fps; i += 1) {
    step(w, 1 / fps, speed);
    while (next < frames.length && w.t >= next / frameRate) {
      applyState(w, frames[next]);
      next += 1;
    }
    const e = w.agents.get(id);
    if (e && e.state !== 'out') {
      if (firstAt === null) firstAt = i;
      samples.push({ x: e.x, y: e.y, walking: e.walking, tx: e.tx, ty: e.ty });
    }
  }
  return { w, samples };
}

for (const variant of ['handover', 'overlap', 'gap']) {
  test(`a phase change of a run in replay always produces walk frames (${variant})`, () => {
    const base = sampleStateAt(cfg, G);
    // a coder of a run whose lane has a next station; the next phase's agent takes over there
    const src = base.agents.find((a) => a.role === 'coder' && a.lane && base.pipeline.lanes.find((l) => l.id === a.lane).stations.length > a.station + 1);
    const job = src.job;
    const coder = { ...src, id: 'coder-1' };
    const reviewer = { ...coder, id: 'reviewer-1', role: 'reviewer', station: src.station + 1, label: 'review', action: { kind: 'search', text: 'reading the diff' } };
    const others = base.agents.filter((a) => a.job !== job);
    const at = (i) => new Date(Date.parse(base.now) + i * 20_000).toISOString();
    const frames = [];
    for (let i = 0; i < 40; i += 1) {
      let agents;
      if (i < 10) agents = [...others, coder];
      else if (i === 10 && variant === 'overlap') agents = [...others, coder, reviewer];
      else if (i === 10 && variant === 'gap') agents = [...others];
      else agents = [...others, reviewer];
      frames.push({ ...base, now: at(i), agents, events: [] });
    }
    // where the coder stood when the job moved on
    const before = play(frames.slice(0, 10), 'coder-1', { seconds: 1.5 });
    const coderAt = before.samples.at(-1);
    const { samples, w } = play(frames, 'reviewer-1');
    assert.ok(samples.length > 10, 'the reviewer is on stage');
    const first = samples[0];
    const target = { x: first.tx, y: first.ty };
    // it starts where the coder stood, not at its own station (no teleport, no beam-in at the console)
    assert.ok(Math.abs(first.x - coderAt.x) <= 1 && Math.abs(first.y - coderAt.y) <= 1, `starts at the coder's spot (${first.x},${first.y} vs ${coderAt.x},${coderAt.y})`);
    assert.ok(Math.hypot(first.x - target.x, first.y - target.y) > 40, 'the review station is somewhere else');
    // then walks there: several walking frames, never faster than walking speed
    const maxStep = (SPEED.walk * 2.5) / 60 + 1;
    let walkingFrames = 0;
    for (let i = 1; i < samples.length; i += 1) {
      const d = Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
      assert.ok(d <= maxStep, `frame ${i}: moved ${d.toFixed(2)} px (walking speed allows ${maxStep.toFixed(2)})`);
      if (samples[i].walking) walkingFrames += 1;
    }
    assert.ok(walkingFrames >= 20, `walks for ${walkingFrames} frames`);
    const last = samples.at(-1);
    assert.ok(Math.round(last.x) === target.x && Math.round(last.y) === target.y && !last.walking, 'arrives at the review station');
    // the coder handed over quietly: it is gone, with no second character left at the desk
    assert.ok(!w.agents.has('coder-1') || w.agents.get('coder-1').state === 'out');
  });
}

test('the merge machine eases between states instead of snapping', () => {
  const w = createWorld({ aspect: '16:9' });
  const base = sampleStateAt(cfg, G);
  applyState(w, { ...base, queue: { entries: [], batch: null }, events: [] }, { first: true });
  for (let i = 0; i < 120; i += 1) step(w, 1 / 60);
  const idleW = w.gearW;
  // a batch starts: the gear spins up over a few frames, not at once
  w.scene.batchRunning = true;
  const ws = [];
  for (let i = 0; i < 90; i += 1) {
    step(w, 1 / 60);
    ws.push(w.gearW);
  }
  assert.ok(idleW < 0.2 && ws[0] < 0.3 && ws.at(-1) > 1.4, `spins up ${idleW.toFixed(2)} -> ${ws[0].toFixed(2)} -> ${ws.at(-1).toFixed(2)}`);
  for (let i = 1; i < ws.length; i += 1) assert.ok(ws[i] - ws[i - 1] < 0.1, 'no jump in gear speed');
  // the angle itself is continuous
  let prev = w.gearAng;
  w.scene.batchRunning = false;
  for (let i = 0; i < 60; i += 1) {
    step(w, 1 / 60);
    assert.ok(Math.abs(w.gearAng - prev) < 0.05);
    prev = w.gearAng;
  }
});
