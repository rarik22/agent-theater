import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { buildReplay, entryStatusAt } from '../lib/replay.mjs';
import { createTheater } from '../lib/state.mjs';
import { NOW, PRIVATE_MARKERS, assertStateShape, fakeExec, setupFixtures } from './helpers.mjs';

let fx;
before(() => {
  fx = setupFixtures();
});
after(() => fx.cleanup());

const replay = (opts = {}) => buildReplay(createTheater(fx.cfg, { exec: fakeExec }), { now: NOW, hours: 6, frames: 13, ...opts });
const at = (hm) => `2026-11-19T${hm}:00.000Z`;

test('replay returns evenly spaced frames in the live schema', async () => {
  const r = await replay();
  assert.equal(r.mode, 'replay');
  assert.equal(r.sample, false);
  assert.equal(r.from, at('06:00'));
  assert.equal(r.to, at('12:00'));
  assert.equal(r.frameCount, 13);
  assert.equal(r.stepMs, 30 * 60_000);
  assert.equal(r.frames[0].now, at('06:00'));
  assert.equal(r.frames[6].now, at('09:00'));
  assert.equal(r.frames[12].now, at('12:00'));
  for (const f of r.frames) {
    assertStateShape(f);
    assert.equal(f.mode, 'replay');
  }
});

test('agents appear while they worked, with the role from their label', async () => {
  const r = await replay();
  const ids = (hm) => r.frames.find((f) => f.now === at(hm)).agents.map((a) => a.id).sort();
  assert.deepEqual(ids('09:00'), ['a11gate']); // the S01 gate ran 08:30-09:30
  assert.equal(r.frames[6].agents[0].role, 'verifier');
  assert.deepEqual(ids('10:00'), ['a01setup']);
  assert.deepEqual(ids('11:00'), ['a02coder', 'a08stale', 's03quiet']); // a08stale stopped changing at 11:15; s03quiet is a standalone agent (11:00-11:20)
  // a04fix went quiet at 11:21; a15bgcheck waits on its background drill; a16bgdone runs its tests until
  // 11:41; a17old works until the controller relaunches its job at 11:50; s01runner is standalone
  assert.deepEqual(ids('11:30'), ['a02coder', 'a03review', 'a09integ', 'a12waiter', 'a15bgcheck', 'a16bgdone', 'a17old', 's01runner']);
  // the last frame is now: the live state (no stopped, relaunched, finished or quiet agents)
  assert.deepEqual(ids('12:00'), ['a02coder', 'a03review', 'a05merge', 'a06lens', 'a07prep', 'a09integ', 'a10probe', 'a12waiter', 'a13think', 'a15bgcheck', 'a18new', 'a19poll', 's01runner']);
});

test('the done counter walks back merges that happened after each frame', async () => {
  const r = await replay();
  const done = (hm) => r.frames.find((f) => f.now === at(hm)).project.done;
  assert.equal(done('06:00'), 4); // before ITEM-STU-002 (08:00) and S05-TASK-01 (11:10)
  assert.equal(done('09:00'), 5);
  assert.equal(done('11:00'), 5);
  assert.equal(done('11:30'), 6);
  assert.equal(done('12:00'), 6);
  const s05 = (hm) => r.frames.find((f) => f.now === at(hm)).pipeline.lanes.find((l) => l.id === 'S05').progress.done;
  assert.equal(s05('11:00'), 0);
  assert.equal(s05('11:30'), 1);
});

test('queue and batches are rebuilt for each frame', async () => {
  const r = await replay();
  const frame = (hm) => r.frames.find((f) => f.now === at(hm));
  const statuses = (hm) => Object.fromEntries(frame(hm).queue.entries.map((e) => [e.slug, e.status]));
  assert.deepEqual(statuses('11:00'), { 's05-task-01': 'batched', 's05-task-02': 'batched' });
  assert.equal(frame('11:00').queue.batch.n, 2);
  assert.deepEqual(statuses('11:30'), { 's05-task-02': 'bounced', 's12-task-01': 'ready', 's03-task-01': 'ready' });
  assert.equal(frame('11:30').queue.batch, null);
  // The last frame is "now": real queue, booths and lock.
  assert.equal(frame('12:00').queue.batch.n, 3);
  assert.equal(frame('12:00').lock.holder, 'S02-TASK-06');
  assert.equal(frame('12:00').slots[0].holder, 'S04-TASK-02');
});

test('frame events partition the timeline and replay events are sorted', async () => {
  const r = await replay();
  const times = r.events.map((e) => Date.parse(e.at));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  const fromFrames = r.frames.flatMap((f) => f.events.map((e) => e.id));
  const expected = r.events.map((e) => e.id);
  assert.deepEqual(fromFrames, expected);
  for (let i = 1; i < r.frames.length; i += 1) {
    for (const e of r.frames[i].events) {
      assert.ok(Date.parse(e.at) > Date.parse(r.frames[i - 1].now) && Date.parse(e.at) <= Date.parse(r.frames[i].now));
    }
  }
  const types = new Set(r.events.map((e) => e.type));
  for (const type of ['started', 'finished', 'queued', 'bounced', 'merged']) assert.ok(types.has(type), type);
});

test('replay respects public mode and clamps its parameters', async () => {
  const json = JSON.stringify(await replay({ publicMode: true }));
  for (const marker of PRIVATE_MARKERS) assert.ok(!json.includes(marker), `public replay leaks "${marker}"`);
  const small = await replay({ hours: 999, frames: 1 });
  assert.equal(small.hours, fx.cfg.replay.maxHours);
  assert.equal(small.frameCount, 2);
});

test('entry status at a past time', () => {
  const entry = { slug: 'x', readyAt: at('10:00'), updatedAt: at('11:30'), status: 'ready', bounces: [{ batch: 1, at: at('10:40') }] };
  const batches = [{ n: 1, slugs: ['x'], startedAt: at('10:20'), finishedAt: at('10:45'), status: 'passed' }];
  assert.equal(entryStatusAt(entry, batches, Date.parse(at('09:00'))), null);
  assert.equal(entryStatusAt(entry, batches, Date.parse(at('10:10'))), 'ready');
  assert.equal(entryStatusAt(entry, batches, Date.parse(at('10:30'))), 'batched');
  assert.equal(entryStatusAt(entry, batches, Date.parse(at('11:00'))), 'bounced');
  assert.equal(entryStatusAt(entry, batches, Date.parse(at('11:40'))), 'ready');
  assert.equal(entryStatusAt({ ...entry, mergedAt: at('11:50') }, batches, Date.parse(at('11:55'))), 'merged');
});

test('a from/to window rebuilds the same past as the hours mode, without inventing lock owners', async () => {
  const hours = await replay();
  const win = await replay({ hours: undefined, frames: 6, fromMs: Date.parse(at('09:00')), toMs: Date.parse(at('11:30')) });
  assert.equal(win.from, at('09:00'));
  assert.equal(win.to, at('11:30'));
  assert.equal(win.window, true);
  assert.equal(win.frameCount, 6);
  assert.equal(win.stepMs, 30 * 60_000);
  for (const f of win.frames) {
    assertStateShape(f);
    const same = hours.frames.find((h) => h.now === f.now);
    if (!same || f.now === at('12:00')) continue;
    assert.deepEqual(f.agents.map((a) => a.id).sort(), same.agents.map((a) => a.id).sort(), `agents at ${f.now}`);
    assert.deepEqual(f.queue.entries.map((e) => [e.slug, e.status]), same.queue.entries.map((e) => [e.slug, e.status]), `queue at ${f.now}`);
  }
  const last = win.frames[win.frames.length - 1];
  assert.equal(last.now, at('11:30'));
  assert.equal(last.lock, null, 'a past window does not know the lock owner');
  assert.equal(last.exclusive, null);
  for (const e of win.events) assert.ok(Date.parse(e.at) >= Date.parse(at('09:00')) && Date.parse(e.at) <= Date.parse(at('11:30')));
  assert.ok(win.notes.some((n) => /not known/.test(n)));
});

test('a window that ends in the future stops at now; bad windows are refused', async () => {
  const { replayWindow } = await import('../lib/replay.mjs');
  const w = await replay({ hours: undefined, frames: 3, fromMs: Date.parse(at('11:00')), toMs: Date.parse(at('13:00')) });
  assert.equal(w.to, at('12:00'), 'clamped to now');
  const cfg = fx.cfg;
  const now = Date.parse(at('12:00'));
  assert.throws(() => replayWindow(cfg, { now, fromMs: Date.parse(at('11:00')), toMs: Date.parse(at('10:00')) }), /after/);
  assert.throws(() => replayWindow(cfg, { now, fromMs: Date.parse(at('12:30')), toMs: Date.parse(at('12:40')) }), /future/);
  assert.throws(() => replayWindow(cfg, { now, fromMs: now - 49 * 3600_000, toMs: now }), /longer/);
  assert.throws(() => replayWindow(cfg, { now, fromMs: now - 10_000, toMs: now }), /shorter/);
  assert.throws(() => replayWindow(cfg, { now, fromMs: NaN, toMs: now }), /ISO/);
  assert.deepEqual(replayWindow(cfg, { now, hours: 2 }), { from: now - 2 * 3600_000, to: now, hours: 2, live: true });
});
