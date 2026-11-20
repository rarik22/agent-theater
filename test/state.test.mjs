import assert from 'node:assert/strict';
import { appendFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { normalizeConfig } from '../lib/config.mjs';
import { buildLiveState, createTheater } from '../lib/state.mjs';
import { NOW, PRIVATE_MARKERS, assertStateShape, failingExec, fakeExec, setupFixtures } from './helpers.mjs';

let fx;
before(() => {
  fx = setupFixtures();
});
after(() => fx.cleanup());

const live = (opts = {}) => buildLiveState(createTheater(fx.cfg, { exec: fakeExec }), { now: NOW, ...opts });

test('active agents, roles and actions come from journals and transcripts', async () => {
  const state = await live();
  assertStateShape(state);
  assert.equal(state.mode, 'live');
  assert.equal(state.sample, false);
  const byId = Object.fromEntries(state.agents.map((a) => [a.id, a]));
  // Not on stage: finished (a01setup, a11gate, standalone s02done), quiet with nothing in flight
  // (a04fix since 11:21, a08stale, a16bgdone after its tests finished, standalone s03quiet), stopped
  // (a14ghost) and relaunched (a17old) agents.
  assert.deepEqual(Object.keys(byId).sort(), ['a02coder', 'a03review', 'a05merge', 'a06lens', 'a07prep', 'a09integ', 'a10probe', 'a12waiter', 'a13think', 'a15bgcheck', 'a18new', 'a19poll', 's01runner']);
  const expect = {
    a02coder: ['coder', 'S03-TASK-02', 'S03', 'test', 'running tests'],
    a03review: ['reviewer', 'S05-TASK-02', 'S05', 'read', 'reviewing a change'],
    a13think: ['fixer', 'S07-TASK-02', 'S07', 'think', 'planning a fix'],
    a05merge: ['merger', null, null, 'wait', 'waiting for the merge lock'],
    a06lens: ['verifier', null, null, 'read', 'checking the work'],
    // its UI journey runs in the background inside the booth it holds (slot-1): a live check
    a07prep: ['preparer', 'S04-TASK-02', 'S04', 'test', 'running a live check (background)'],
    a09integ: ['preparer', 'S02-TASK-06', 'S02', 'docker', 'starting containers'],
    a10probe: ['helper', null, null, 'search', 'searching the code'],
    a12waiter: ['coder', 'S12-TASK-02', 'S12', 'wait', 'waiting for a test booth'],
  };
  for (const [id, [role, job, lane, kind, text]] of Object.entries(expect)) {
    assert.equal(byId[id].role, role, `${id} role`);
    assert.equal(byId[id].job, job, `${id} job`);
    assert.equal(byId[id].lane, lane, `${id} lane`);
    assert.equal(byId[id].action.kind, kind, `${id} kind`);
    assert.equal(byId[id].action.text, text, `${id} text`);
  }
  assert.equal(byId.a02coder.title, 'Filtered backlog and saved views');
  assert.equal(byId.a05merge.title, 'Merge batch 3');
  assert.equal(byId.a06lens.title, 'review:safety');
  assert.equal(byId.a02coder.since, '2026-11-19T11:00:00.000Z');
  // stations: a lane role stands at its station (SETUP CODE REVIEW FIX PREP), the merger at the merge
  // machine, a verifier or helper on the dock
  assert.deepEqual([byId.a02coder.station, byId.a02coder.stationTag], [1, 'CODE']);
  assert.deepEqual([byId.a03review.station, byId.a07prep.station, byId.a13think.station], [2, 4, 3]);
  assert.deepEqual([byId.a05merge.station, byId.a05merge.place], [null, 'merge']);
  assert.equal(byId.a06lens.station, null);
});

test('project totals add jobs merged after the progress snapshot; lanes carry their jobs done/total', async () => {
  const state = await live();
  assert.equal(state.project.name, 'Example Project');
  assert.equal(state.project.total, 12);
  assert.equal(state.project.done, 6); // 5 in the snapshot + S05-TASK-01 merged after it
  assert.deepEqual(state.project.labels, { jobs: 'JOBS', features: 'FEATURES', batch: 'BATCH' });
  assert.equal(state.project.batch, 3);
  const lanes = Object.fromEntries(state.pipeline.lanes.map((l) => [l.id, l]));
  assert.deepEqual([lanes.S05.progress, lanes.S05.active, lanes.S05.show], [{ done: 1, total: 2 }, true, true]);
  // a lane the lanes file lists as waiting, with no jobs in the progress file
  assert.deepEqual([lanes.S06.status, lanes.S06.show, lanes.S06.progress], ['waiting', false, { done: 0, total: 0 }]);
  assert.equal(lanes.S14, undefined); // nowhere in the sources
  assert.equal(lanes.S12.active, true); // an agent works there even without a lane
  assert.deepEqual([lanes.S00.active, lanes.S00.show], [false, false]);
  assert.deepEqual(lanes.S03.stations.map((x) => x.tag), ['SETUP', 'CODE', 'REVIEW', 'FIX', 'PREP']);
  assert.deepEqual(state.yard.labels, { test: 'TEST', merge: 'MERGE', develop: 'DEVELOP', remote: 'REMOTE' });
});

test('queue, batch, slots and lock reflect the runner files', async () => {
  const state = await live();
  const statuses = Object.fromEntries(state.queue.entries.map((e) => [e.slug, e.status]));
  assert.deepEqual(statuses, { 's05-task-01': 'merged', 's05-task-02': 'bounced', 's12-task-01': 'batched', 's03-task-01': 'ready', 'image-tag': 'ready' });
  assert.equal(state.queue.entries.find((e) => e.slug === 'image-tag').lane, 'controller');
  assert.equal(state.queue.entries.find((e) => e.slug === 's05-task-02').bounces, 1);
  assert.deepEqual(state.queue.batch, { n: 3, slugs: ['s12-task-01'], startedAt: '2026-11-19T11:50:00.000Z', status: 'running' });
  assert.equal(state.queue.lastBatch.n, 2);
  assert.deepEqual(
    state.slots.map((s) => s.holder),
    ['S04-TASK-02', 'agent', null, null],
  );
  assert.equal(state.slots[0].lane, 'S04');
  assert.equal(state.slots[0].since, '2026-11-19T11:58:00.000Z');
  assert.deepEqual(state.lock, { holder: 'S02-TASK-06', job: 'S02-TASK-06', lane: 'S02', since: '2026-11-19T11:24:00.000Z' });
  assert.equal(state.exclusive, null);
});

test('events merge journals, queue and git history, oldest first', async () => {
  const state = await live();
  const count = state.events.reduce((acc, e) => ((acc[e.type] = (acc[e.type] || 0) + 1), acc), {});
  assert.deepEqual(count, { started: 19, finished: 2, queued: 5, bounced: 1, merged: 3 });
  const times = state.events.map((e) => Date.parse(e.at));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  const merged = state.events.filter((e) => e.type === 'merged').map((e) => e.text);
  assert.deepEqual(merged, ['plan-14 merged', 'ITEM-STU-002 merged', 'S05-TASK-01 merged']);
  assert.equal(state.events.find((e) => e.type === 'merged' && e.job === 'S05-TASK-01').lane, 'S05');
  assert.ok(state.events.some((e) => e.type === 'bounced' && e.text === 'S05-TASK-02 bounced back to its lane'));
  assert.ok(state.events.some((e) => e.type === 'started' && e.text === 'S03-TASK-02 coding started'));
  assert.ok(state.events.some((e) => e.type === 'finished' && e.text === 'S01-GATE verification finished'));
  assert.equal(new Set(state.events.map((e) => e.id)).size, state.events.length);
  assert.equal(state.sources.git, 'ok');
});

test('public mode never exposes commands, paths, hosts, names or bounce notes', async () => {
  const json = JSON.stringify(await live({ publicMode: true }));
  for (const marker of PRIVATE_MARKERS) assert.ok(!json.includes(marker), `public state leaks "${marker}"`);
});

test('private mode shows redacted tool descriptions', async () => {
  const state = await live({ publicMode: false });
  const coder = state.agents.find((a) => a.id === 'a02coder');
  assert.match(coder.action.text, /^Run backlog tests for \*\*\*/);
  assert.equal(coder.action.tool, 'Bash');
  const json = JSON.stringify(state);
  assert.ok(!json.includes('example.com'));
  assert.ok(!json.includes('fixture-user'));
  assert.ok(state.events.some((e) => e.type === 'bounced' && e.text.includes('verify:full failed in ~/wt')));
});

test('missing sources are reported as unavailable, never invented', async () => {
  // older key names (mergeQueue, featureStatus, janitorLog) are still read
  const cfg = normalizeConfig({ pipeline: { lanes: 'jobs' }, sources: { workflows: 'nope/workflows', lanes: 'nope/lanes.json', mergeQueue: 'nope/q.json', locks: 'nope/locks', janitorLog: 'nope/j.log', featureStatus: 'nope/f.json', repo: 'nope' } }, fx.dir);
  const state = await buildLiveState(createTheater(cfg, { exec: failingExec }), { now: NOW });
  assertStateShape(state);
  assert.deepEqual(state.agents, []);
  assert.equal(state.project.done, null);
  assert.equal(state.project.total, null);
  assert.deepEqual(state.pipeline.lanes, []);
  assert.deepEqual(state.events, []);
  assert.equal(state.lock, null);
  assert.ok(state.slots.every((s) => s.unavailable === true && s.holder === null));
  assert.deepEqual(state.sources, { claude: 'unavailable', workflows: 'unavailable', subagents: 'unavailable', progress: 'unavailable', lanes: 'unavailable', queue: 'unavailable', locks: 'unavailable', git: 'unavailable', events: 'ok' });
});

test('transcripts are parsed incrementally as they grow', async () => {
  const theater = createTheater(fx.cfg, { exec: fakeExec });
  const first = await buildLiveState(theater, { now: NOW });
  assert.equal(first.agents.find((a) => a.id === 'a10probe').action.kind, 'search');
  const file = join(fx.dir, 'workflows', 'wf_fixture-c', 'agent-a10probe.jsonl');
  const row = { type: 'assistant', timestamp: '2026-11-19T12:00:30.000Z', agentId: 'a10probe', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fixture_new', name: 'Write', input: { file_path: 'notes.md', content: 'x' } }] } };
  appendFileSync(file, `${JSON.stringify(row)}\n`);
  const t = new Date(NOW + 31_000);
  utimesSync(file, t, t);
  const second = await buildLiveState(theater, { now: NOW + 32_000 });
  const probe = second.agents.find((a) => a.id === 'a10probe');
  assert.equal(probe.action.kind, 'edit');
  assert.equal(theater.transcripts.get(file).uses.length, 2);
});
