// The stage with release trains: the merge window and belt in release order, the machine's
// state and counter, the plate under it, the controller's release, and holder words on the pods.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeState } from '../public/hd/hd-anim.mjs';
import { controllerReadout } from '../public/hd/hd-controller.mjs';
import { createRenderer, releasePlate, renderFrame } from '../public/hd/hd-render.mjs';
import { holderOf, queueScene, releaseScene } from '../public/hd/hd-scene.mjs';
import { applyState, createWorld, holderLabel, step } from '../public/hd/hd-world.mjs';
import { NEUTRAL, lane, stateWith } from './client-helpers.mjs';

const T = (hm) => `2026-11-19T${hm}:00.000Z`;
const entry = (slug, lane, status, extra = {}) => ({ slug, id: slug.toUpperCase(), lane, status, readyAt: T('09:00'), ...extra });
const release = (version, extra = {}) => ({ version, status: 'open', activity: 'open', counted: 0, capacity: 10, entries: [], fixRounds: 0, openFailure: null, check: null, ...extra });

function trainState({ machine, releases = [machine], entries = [], events = [] } = {}) {
  return stateWith({
    lanes: [lane('API', NEUTRAL), lane('WEB', NEUTRAL)],
    queue: { entries, batch: null, lastBatch: null, releases, release: machine },
    project: { done: 3, total: 10, release: machine ? machine.version : undefined, labels: { jobs: 'JOBS', features: 'FEATURES', batch: 'REL' } },
    events,
  });
}

test('the window holds the machine release (the latest four), the belt follows release order', () => {
  const inMachine = ['m1', 'm2', 'm3', 'm4', 'm5'];
  const machine = release('0.3.1', { status: 'verifying', activity: 'checking', counted: 5, entries: inMachine });
  const next = release('0.3.2', { counted: 2, entries: ['n1', 'n2'] });
  const entries = [
    ...inMachine.map((s, i) => entry(s, 'API', 'integrated', { release: '0.3.1', integratedAt: T(`10:0${i}`) })),
    entry('n2', 'WEB', 'integrated', { release: '0.3.2', integratedAt: T('11:20') }),
    entry('n1', 'WEB', 'integrated', { release: '0.3.2', integratedAt: T('11:10') }),
    entry('q2', 'API', 'queued', { readyAt: T('11:50') }),
    entry('q1', 'WEB', 'queued', { readyAt: T('11:40') }),
    entry('out', 'WEB', 'moved-out'),
  ];
  const sc = queueScene(trainState({ machine, releases: [machine, next], entries }));
  assert.deepEqual(sc.window.map((e) => e.slug), ['m2', 'm3', 'm4', 'm5']);
  assert.equal(sc.inRelease, 5);
  // already in the next release first (it goes in next), then the queue in order
  assert.deepEqual(sc.belt.map((e) => [e.slug, Boolean(e.integrated)]), [['n1', true], ['n2', true], ['q1', false], ['q2', false]]);
  assert.equal(sc.batchRunning, false);
  assert.ok(sc.bounced.has('WEB'), 'a moved-out job flags its lane');
  assert.equal(sc.release.version, '0.3.1');
  assert.equal(sc.release.next.version, '0.3.2');
  // no releases: the batch scene, untouched
  assert.equal(releaseScene(stateWith({ queue: { entries: [], batch: null } })), null);
  assert.equal(queueScene(stateWith({ queue: { entries: [entry('a', 'API', 'ready')], batch: null } })).release, null);
});

test('the machine works while the runner integrates, checks or merges; fixing holds the red lamp', () => {
  const base = release('0.3.1');
  assert.equal(mergeState({ release: { ...base, activity: 'integrating' } }), 'working');
  assert.equal(mergeState({ release: { ...base, activity: 'checking' } }), 'working');
  assert.equal(mergeState({ release: { ...base, activity: 'merging' } }), 'working');
  assert.equal(mergeState({ release: { ...base, activity: 'verifying', next: { activity: 'integrating' } } }), 'working');
  assert.equal(mergeState({ release: { ...base, activity: 'fixing' } }), 'fixing');
  assert.equal(mergeState({ release: { ...base, activity: 'open', openFailure: true } }), 'fixing');
  // entries waiting in an open release do not keep it busy
  assert.equal(mergeState({ release: { ...base, activity: 'open' }, windowCount: 4 }), 'idle');
  // landing merges and bounces still flash first
  assert.equal(mergeState({ release: { ...base, activity: 'fixing' }, sinceMerged: 1 }), 'pass');
  assert.equal(mergeState({ release: { ...base, activity: 'checking' }, sinceBounced: 1 }), 'fail');
  assert.equal(mergeState({ windowCount: 2 }), 'working');
});

test('the controller shows the release; holders read REL, FIX, CTRL', () => {
  assert.equal(controllerReadout({ project: { done: 1, total: 2, release: '0.3.1' }, batch: 7 }).batch, '0.3.1');
  assert.equal(controllerReadout({ project: { done: 1, total: 2 }, batch: 7 }).batch, '7');
  assert.equal(controllerReadout({ project: { release: 'not a version' }, batch: null }).batch, '-');
  const label = (holder) => holderLabel({ holder }, holderOf({ holder }));
  assert.deepEqual(['release 0.3.1', 'fixer 0.3.1', 'controller 0.3.1', 'merger', 'merge batch', 'agent'].map(label), ['REL', 'FIX', 'CTRL', 'MERGE', 'MERGE', 'HOLD']);
  assert.equal(holderOf({ holder: 'release 0.3.1' }).kind, 'merge');
  assert.equal(label('S05-TASK-01'), 'HOLD');
  assert.equal(holderLabel({ holder: 'S05-TASK-01', lane: 'S05' }, holderOf({ holder: 'S05-TASK-01', lane: 'S05' })), 'S05');
});

test('the plate names the release and what is done with it, shortened to fit', () => {
  const rel = { ...release('0.3.1', { activity: 'integrating', counted: 3, capacity: 10 }), next: null };
  assert.equal(releasePlate(rel, 400).line, 'REL 0.3.1 INTEGRATING');
  assert.equal(releasePlate(rel, 400).word, 'INTEGRATING');
  assert.equal(releasePlate(rel, 80).line, '0.3.1 INTEG');
  assert.equal(releasePlate(rel, 20).line, '0.3.1');
  assert.equal(releasePlate({ ...rel, activity: 'verifying' }, 400).line, 'REL 0.3.1 CHECK DUE');
  assert.equal(releasePlate(rel, 400).notes, '');
  const busy = { ...rel, activity: 'fixing', openFailure: true, fixRounds: 7, next: { version: '0.3.2', status: 'open', activity: 'integrating', counted: 2, capacity: 10 } };
  assert.equal(releasePlate(busy, 400).notes, 'open failure · fix rounds 7 · next 0.3.2 integrating 2/10');
});

test('a release state renders: the window, the counter, the plate; a moved-out parcel flies home', () => {
  const machine = release('0.3.1', { status: 'open', activity: 'integrating', counted: 2, entries: ['a1', 'a2'] });
  const entries = [entry('a1', 'API', 'integrated', { release: '0.3.1' }), entry('a2', 'WEB', 'integrated', { release: '0.3.1' }), entry('q1', 'API', 'queued')];
  for (const aspect of ['16:9', '1:1', '4:5', '9:16']) {
    for (const big of [false, true]) {
      const w = createWorld({ aspect, big });
      applyState(w, trainState({ machine, entries }), { first: true });
      for (let i = 0; i < 30; i += 1) step(w, 1 / 30);
      const f = renderFrame(createRenderer(), w);
      assert.ok(f.w > 0 && f.h > 0);
      assert.equal(w.release.version, '0.3.1');
      assert.deepEqual([...w.parcels.values()].filter((p) => p.mode === 'window').map((p) => p.slug).sort(), ['a1', 'a2']);
    }
  }
  // the parcel leaves the window as its job is moved out: a plane back to its lane
  const w = createWorld({ aspect: '16:9' });
  applyState(w, trainState({ machine, entries }), { first: true });
  step(w, 0.5);
  applyState(w, trainState({ machine: { ...machine, counted: 1, entries: ['a2'] }, entries: [{ ...entries[0], status: 'moved-out', release: undefined }, entries[1], entries[2]] }));
  step(w, 0.1);
  assert.ok(w.planes.length >= 1, 'a plane flies home');
  // the release passes: its jobs merge and leave the window for the vault
  applyState(w, trainState({ machine: { ...machine, status: 'passed', activity: 'passed' }, entries: [{ ...entries[1], status: 'merged' }, entries[2]], events: [{ id: 'merged:a2:1', at: T('12:00'), type: 'merged', job: 'A2', slug: 'a2', lane: 'WEB', text: 'A2 merged with release 0.3.1' }] }));
  step(w, 0.1);
  assert.ok(![...w.parcels.values()].some((p) => p.slug === 'a2' && p.mode === 'window'));
});

test('the workflows alone: the plate says what the machine does, the counter shows no count', () => {
  const rel = { version: null, status: 'running', activity: 'checking', counted: null, capacity: null, fixRounds: 0, openFailure: false, next: null };
  assert.equal(releasePlate(rel, 400).line, 'MERGE CHECKING');
  assert.equal(releasePlate(rel, 50).line, 'CHECKING');
  assert.equal(releasePlate(rel, 40).line, 'CHECK');
  const machine = { version: null, status: 'running', activity: 'working', counted: null, capacity: null, entries: [], since: T('11:50') };
  const w = createWorld({ aspect: '16:9' });
  applyState(w, trainState({ machine, releases: [machine] }), { first: true });
  for (let i = 0; i < 20; i += 1) step(w, 1 / 30);
  assert.ok(renderFrame(createRenderer(), w).w > 0);
  assert.deepEqual([w.release.version, w.release.activity, w.release.counted], [null, 'working', null]);
  assert.equal(mergeState({ release: w.release }), 'working');
});

test('a finished run joins the queue column when the team has a queue, else flows into the vault', () => {
  const done = { id: 'done:API:1', at: T('12:00'), type: 'done', job: null, lane: 'API', text: 'API done' };
  const run = (extra) => {
    const w = createWorld({ aspect: '16:9' });
    const base = { ...stateWith({ lanes: [lane('API', NEUTRAL)] }), ...extra };
    applyState(w, base, { first: true });
    step(w, 0.2);
    applyState(w, { ...base, events: [done] });
    step(w, 0.05);
    return w;
  };
  const queued = run({ sources: { queue: 'ok' } });
  const p = [...queued.parcels.values()].find((x) => x.slug === 'run:done:API:1');
  assert.equal(p.mode, 'joining');
  assert.equal(queued.flows.length, 0);
  for (let i = 0; i < 300; i += 1) step(queued, 1 / 30);
  assert.ok(![...queued.parcels.values()].some((x) => x.slug === 'run:done:API:1'), 'it joins the column and leaves');
  const plain = run({});
  assert.equal([...plain.parcels.values()].find((x) => x.slug === 'run:done:API:1').mode, 'merging');
});
