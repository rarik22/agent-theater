import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleFullMoment, sampleReplay, sampleState, sampleStateAt } from '../lib/sample.mjs';

const cfg = { maxEvents: 60, slotCount: 4, replay: { defaultHours: 8, maxHours: 48, defaultFrames: 240, maxFrames: 900 } };
const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const LANE_ID = /^[A-Z0-9][A-Z0-9-]{0,5}$/;
const TAG = /^[A-Z0-9][A-Z0-9.-]{0,15}$/;

/** The live schema v2, as the stage reads it. */
function assertStateShape(s) {
  assert.equal(typeof s.now, 'string');
  assert.ok(['live', 'replay'].includes(s.mode));
  for (const k of ['done', 'total']) assert.ok(s.project[k] === null || Number.isInteger(s.project[k]));
  assert.ok(Array.isArray(s.pipeline.lanes) && Array.isArray(s.pipeline.stations));
  for (const l of s.pipeline.lanes) {
    assert.match(l.id, LANE_ID);
    assert.ok(l.stations.length >= 1 && l.stations.length <= 6);
    for (const st of l.stations) assert.ok(['setup', 'coder', 'reviewer', 'fixer', 'preparer'].includes(st.kind));
    assert.ok(Number.isInteger(l.done) && l.done <= l.stations.length);
  }
  const lanes = new Map(s.pipeline.lanes.map((l) => [l.id, l]));
  for (const a of s.agents) {
    assert.equal(typeof a.id, 'string');
    assert.ok(['setup', 'coder', 'reviewer', 'fixer', 'preparer', 'merger', 'verifier', 'helper'].includes(a.role));
    assert.equal(typeof a.action.kind, 'string');
    if (a.tag !== null) assert.match(a.tag, TAG);
    if (a.lane) {
      assert.ok(lanes.has(a.lane), `agent ${a.id} in a known lane`);
      assert.ok(Number.isInteger(a.station) && a.station < lanes.get(a.lane).stations.length);
    }
  }
  assert.ok(Array.isArray(s.queue.entries));
  assert.ok(Array.isArray(s.slots) && Array.isArray(s.events));
}

test('sample state is clearly labelled and follows the schema', () => {
  const s = sampleState(cfg, { now: NOW });
  assertStateShape(s);
  assert.equal(s.sample, true);
  assert.equal(s.notice, 'sample data');
  assert.ok(Object.values(s.sources).every((v) => v === 'sample'));
  assert.deepEqual(s.project.labels, { jobs: 'RUNS', features: 'AGENTS', batch: 'LIVE' });
  assert.ok(s.agents.length >= 6);
  assert.ok(s.agents.some((a) => a.role === 'merger'));
  assert.equal(s.slots.length, 4);
  // lanes run different workflows: their stations differ
  assert.ok(new Set(s.pipeline.lanes.map((l) => l.stations.map((st) => st.tag).join('>'))).size >= 3);
});

test('sample state is deterministic and changes over time', () => {
  assert.deepEqual(sampleState(cfg, { now: NOW }), sampleState(cfg, { now: NOW }));
  const later = sampleState(cfg, { now: NOW + 60_000 });
  assert.notDeepEqual(
    sampleState(cfg, { now: NOW }).agents.map((a) => a.action.kind),
    later.agents.map((a) => a.action.kind),
  );
});

test('a sample hour shows every role, every action, runs moving station to station, and every event', () => {
  const roles = new Set();
  const kinds = new Set();
  const events = new Set();
  const stationsOfRun = new Map();
  let batches = 0;
  let pods = 0;
  for (let t = NOW; t < NOW + 3600_000; t += 10_000) {
    const s = sampleState(cfg, { now: t });
    assertStateShape(s);
    for (const a of s.agents) {
      roles.add(a.role);
      kinds.add(a.action.kind);
      if (a.lane) stationsOfRun.set(a.job, new Set([...(stationsOfRun.get(a.job) || []), a.station]));
    }
    for (const e of s.events) events.add(e.type);
    if (s.queue.batch) batches += 1;
    pods += s.slots.filter((x) => x.lane).length;
  }
  for (const role of ['setup', 'coder', 'reviewer', 'fixer', 'preparer', 'merger', 'verifier', 'helper']) assert.ok(roles.has(role), role);
  for (const kind of ['edit', 'read', 'search', 'run', 'test', 'browser', 'docker', 'think', 'wait']) assert.ok(kinds.has(kind), kind);
  for (const type of ['merged', 'bounced', 'started', 'finished', 'queued', 'done', 'stopped', 'pushed']) assert.ok(events.has(type), type);
  assert.ok(batches > 0 && pods > 0);
  assert.ok([...stationsOfRun.values()].some((st) => st.size >= 3), 'a run visits several stations');
});

test('a sample moment has every role and every console kind on stage', () => {
  const g = sampleFullMoment();
  assert.ok(Number.isInteger(g));
  const s = sampleStateAt(cfg, g);
  const roles = new Set(s.agents.map((a) => a.role));
  assert.equal(roles.size, 8);
  const kinds = new Set(s.agents.filter((a) => a.lane).map((a) => s.pipeline.lanes.find((l) => l.id === a.lane).stations[a.station].kind));
  assert.equal(kinds.size, 5);
});

test('sample runs raise the done counter', () => {
  const a = sampleState(cfg, { now: NOW + 5 * 60_000 }).project.done;
  const b = sampleState(cfg, { now: NOW + 25 * 60_000 }).project.done;
  assert.ok(b > a, `${a} -> ${b}`);
});

test('sample replay has frames spread over the requested window', () => {
  const r = sampleReplay(cfg, { now: NOW, hours: 2, frames: 30 });
  assert.equal(r.mode, 'replay');
  assert.equal(r.sample, true);
  assert.equal(r.frameCount, 30);
  assert.equal(r.frames[0].now, new Date(NOW - 2 * 3600_000).toISOString());
  assert.equal(r.frames.at(-1).now, new Date(NOW).toISOString());
  for (const f of r.frames) {
    assertStateShape(f);
    assert.equal(f.mode, 'replay');
    assert.equal(f.sample, true);
  }
  assert.ok(r.events.length > 0);
});

test('the sample time-lapse counter never goes backwards', () => {
  const r = sampleReplay(cfg, { now: NOW + 1_234_567, hours: 8, frames: 240 });
  const done = r.frames.map((f) => f.project.done);
  for (let i = 1; i < done.length; i += 1) assert.ok(done[i] >= done[i - 1], `frame ${i}: ${done[i - 1]} -> ${done[i]}`);
  assert.ok(done.at(-1) > done[0]);
});

test('the sample carries no free text in what the stage draws', () => {
  const s = sampleState(cfg, { now: NOW });
  for (const l of s.pipeline.lanes) {
    assert.match(l.tag, TAG);
    for (const st of l.stations) assert.match(st.tag, /^[A-Z0-9][A-Z0-9 .-]{0,11}$/);
  }
});
