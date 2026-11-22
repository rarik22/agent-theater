// The flow worked out from the workflows themselves (flow.mjs): which workflows build (a lane per run)
// and which merge (the merge machine), what the machine does from the merge run's phase, the release it
// names; and the adapter's conventions as rules data (history wording, lock owners, status names).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { normalizeConfig } from '../lib/config.mjs';
import { machineFlow, mergeRole, phaseActivity, versionOf, workflowKind } from '../lib/flow.mjs';
import { historyOf, releaseActivity, releasesView } from '../lib/releases.mjs';
import { buildReplay } from '../lib/replay.mjs';
import { compileRules, ownerInfo } from '../lib/rules.mjs';
import { parseQueue } from '../lib/sources/runner.mjs';
import { buildLiveState, createTheater } from '../lib/state.mjs';
import { setupClaudeHome } from './claude-home.mjs';
import { NOW, assertStateShape } from './helpers.mjs';

const JOB = ['Setup', 'Implement', 'Review', 'Queue'];
const TRAIN = ['Integrate', 'Verify', 'Fix', 'Review', 'Merge fix'];
const at = (hms) => Date.parse(`2026-11-19T${hms}.000Z`);

test('a workflow merges when its phases take work to the branch and none builds anything', () => {
  const kind = (phases, workflow = 'w', pipeline = {}) => workflowKind({ workflow, phases }, pipeline);
  assert.equal(kind(JOB), 'job');
  assert.equal(kind(TRAIN), 'merge');
  assert.equal(kind(['Setup', 'Implement', 'Review', 'Ship']), 'job');
  assert.equal(kind(['Setup', 'Build', 'Test', 'Review', 'Fix', 'Prep', 'Publish']), 'job');
  assert.equal(kind(['Plan', 'Implement', 'Test', 'Merge']), 'job');
  assert.equal(kind(['Bump version', 'Tag', 'Publish']), 'merge');
  assert.equal(kind(['Deploy']), 'merge');
  assert.equal(kind(['Reproduce', 'Fix', 'Verify']), 'job');
  // no phases known: the workflow's name decides
  assert.equal(kind([], 'release-train'), 'merge');
  assert.equal(kind([], 'bugfix'), 'job');
  // the config names them first (names or /regex/)
  assert.equal(kind(TRAIN, 'ops-train', { jobWorkflows: ['ops-train'] }), 'job');
  assert.equal(kind(JOB, 'nightly-land', { mergeWorkflows: ['/-land$/'] }), 'merge');
});

test('what the machine does in each phase, and who works it', () => {
  const act = (p) => phaseActivity(p, TRAIN);
  assert.deepEqual(TRAIN.map(act), ['integrating', 'checking', 'fixing', 'fixing', 'fixing']);
  assert.deepEqual(TRAIN.map((p) => mergeRole(p, TRAIN)), ['merger', 'merger', 'fixer', 'reviewer', 'fixer']);
  // a review with no fix before it checks
  assert.equal(phaseActivity('Review', ['Review', 'Publish']), 'checking');
  assert.deepEqual(['Publish', 'Tag', 'Deploy to prod', 'Gate', 'Prepare notes'].map((p) => phaseActivity(p)), ['merging', 'merging', 'merging', 'checking', 'working']);
  assert.equal(versionOf({ subject: 'v2.4.0' }), '2.4.0');
  assert.equal(versionOf({ subject: null }, [{ label: 'integrate', startMs: 1 }, { label: 'verify 2.4.1-rc.1', startMs: 2 }]), '2.4.1-rc.1');
  assert.equal(versionOf({ subject: 'BUG-42' }, [{ label: 'integrate', startMs: 1 }]), null);
});

test('the machine follows the most specific live merge run', () => {
  const raw = {
    runs: [
      { id: 'r1', session: 's', kind: 'merge', workflow: 'train', phases: TRAIN, startMs: at('10:00:00') },
      { id: 'r2', session: 's', kind: 'merge', workflow: 'train', phases: TRAIN, startMs: at('11:00:00') },
      { id: 'r3', session: 's', kind: 'job', workflow: 'job', phases: JOB, startMs: at('11:00:00') },
    ],
    workflows: { agents: [
      { run: 'r1', session: 's', wfPhase: 'Fix', label: 'fix 3.1.0', startMs: at('10:05:00') },
      { run: 'r2', session: 's', wfPhase: 'Integrate', label: 'integrate', startMs: at('11:00:00') },
      { run: 'r2', session: 's', wfPhase: 'Verify', label: 'verify 3.2.0', startMs: at('11:30:00') },
      { run: 'r3', session: 's', wfPhase: 'Implement', label: 'X', startMs: at('11:00:00') },
    ] },
  };
  const live = () => null;
  assert.equal(machineFlow(raw, at('09:00:00'), { runEnd: live }), null);
  assert.deepEqual(pick(machineFlow(raw, at('10:30:00'), { runEnd: live })), ['fixing', 'Fix', '3.1.0', 'r1']);
  assert.deepEqual(pick(machineFlow(raw, at('11:10:00'), { runEnd: live })), ['integrating', 'Integrate', null, 'r2']);
  assert.deepEqual(pick(machineFlow(raw, at('11:40:00'), { runEnd: live })), ['checking', 'Verify', '3.2.0', 'r2']);
  // a run that ended is no longer on the machine
  assert.deepEqual(pick(machineFlow(raw, at('11:40:00'), { runEnd: (r) => (r.id === 'r2' ? at('11:35:00') : null) })), ['fixing', 'Fix', '3.1.0', 'r1']);
  function pick(f) {
    return [f.activity, f.phase, f.version, f.run];
  }
});

test('lock owners read by their generic form or a preset\'s rules', () => {
  assert.deepEqual(ownerInfo('merger-20261122014912'), { word: 'merger', kind: 'merger', version: null });
  assert.deepEqual(ownerInfo('fixer-0.1.2'), { word: 'fixer 0.1.2', kind: 'fixer', version: '0.1.2' });
  assert.deepEqual(ownerInfo('release-0.1.2'), { word: 'release 0.1.2', kind: 'check', version: '0.1.2' });
  assert.deepEqual(ownerInfo('controller-0.1.2'), { word: 'controller 0.1.2', kind: 'controller', version: '0.1.2' });
  for (const h of ['s05-task-01', 'build-host-77', 'agent', '']) assert.equal(ownerInfo(h), null, h);
  const rules = compileRules({ owners: [{ match: '^bot@train-(VERSION)$', word: 'train $1 check', kind: 'check', version: '$1' }, { match: '^lander$', word: 'lander', kind: 'merger' }] });
  assert.deepEqual(ownerInfo('bot@train-3.1.0', rules), { word: 'train 3.1.0 check', kind: 'check', version: '3.1.0' });
  assert.deepEqual(ownerInfo('lander', rules), { word: 'lander', kind: 'merger', version: null });
  // the activity reads owners through the same rules
  const rel = { version: '3.1.0', status: 'verifying', runs: [] };
  assert.equal(releaseActivity(rel, { slots: [], exclusive: { holder: 'bot@train-3.1.0' } }, { rules }), 'checking');
  assert.equal(releaseActivity({ ...rel, status: 'open' }, { slots: [], releases: [{ version: '3.1.0', owner: { holder: 'lander' } }] }, { rules }), 'integrating');
});

test('a team\'s own queue wording and status names, as rules data', () => {
  const rules = compileRules({
    queue: {
      history: [{ match: '^waiting\\b', status: 'queued' }, { match: '^boarded train (VERSION)', status: 'integrated', release: '$1' }, { match: '^landed with (VERSION)', status: 'merged', release: '$1' }],
      status: { waiting: 'queued', boarded: 'integrated', landed: 'merged' },
      releaseStatus: { boarding: 'open', testing: 'verifying', shipped: 'passed' },
    },
  });
  const q = parseQueue({ schema: 2, entries: [{ slug: 'a', status: 'boarded', release: '3.1.0' }, { slug: 'b', status: 'waiting' }], releases: [{ version: '3.1.0', status: 'testing', entries: [] }, { version: '3.0.0', status: 'shipped', entries: [] }] }, rules);
  assert.deepEqual(q.entries.map((e) => e.status), ['integrated', 'queued']);
  assert.deepEqual(q.releases.map((r) => [r.version, r.status]), [['3.0.0', 'passed'], ['3.1.0', 'verifying']]);
  const hist = historyOf({ history: ['2026-11-19T10:00:00.000Z waiting since 9', '2026-11-19T10:10:00.000Z boarded train 3.1.0', '2026-11-19T11:00:00.000Z landed with 3.1.0'] }, rules.queue.history);
  assert.deepEqual(hist.map((h) => [h.status, h.release ?? null]), [['queued', null], ['integrated', '3.1.0'], ['merged', '3.1.0']]);
  // without rules the default wording is read
  assert.deepEqual(historyOf({ history: ['2026-11-19T10:00:00.000Z added at abc'] }).map((h) => h.status), ['queued']);
});

test('the workflow sharpens a release\'s activity; with no queue file it makes the release', () => {
  const q = parseQueue({ schema: 2, entries: [], releases: [{ version: '3.1.0', status: 'verifying', capacity: 4, entries: [] }, { version: '3.2.0', status: 'open', entries: [] }] });
  const flow = { activity: 'checking', phase: 'Verify', version: null, since: at('11:50:00'), workflow: 'train', run: 'r' };
  const v = releasesView(q.releases, null, NOW, { flow });
  assert.deepEqual(v.releases.map((r) => [r.version, r.activity]), [['3.1.0', 'checking'], ['3.2.0', 'open']]);
  // naming a version, the flow goes to that release
  const named = releasesView(q.releases, null, NOW, { flow: { ...flow, activity: 'integrating', version: '3.2.0' } });
  assert.deepEqual(named.releases.map((r) => [r.version, r.activity]), [['3.1.0', 'verifying'], ['3.2.0', 'integrating']]);
  // a live lock owner (merging) is more specific than the workflow's check
  const merging = releasesView(q.releases, { merge: { holder: 'merger-20261119115000' }, slots: [] }, NOW, { flow });
  assert.equal(merging.release.activity, 'merging');
  const only = releasesView([], null, NOW, { flow: { ...flow, version: '3.1.0' } });
  assert.deepEqual([only.release.version, only.release.activity, only.release.counted, only.release.capacity, only.releases.length], ['3.1.0', 'checking', null, null, 1]);
  assert.deepEqual(releasesView([], null, NOW, {}), { releases: [], release: null });
});

test('config: the workflow lists, job counters with a progress file, and the branch on the yard', () => {
  const runs = normalizeConfig({ pipeline: { mergeWorkflows: ['ops-train', '', 3] } });
  assert.deepEqual(runs.pipeline.mergeWorkflows, ['ops-train']);
  assert.deepEqual(runs.counters, { jobs: 'RUNS', features: 'AGENTS', batch: 'LIVE' });
  assert.deepEqual(runs.yard.labels, { test: 'TEST', merge: 'FINISH', develop: 'DONE', remote: 'REMOTE' });
  const team = normalizeConfig({ sources: { progress: '/x/progress.json', repo: '/x/repo', branch: 'develop' } });
  assert.deepEqual(team.counters, { jobs: 'JOBS', features: 'FEATURES', batch: 'LIVE' });
  assert.deepEqual(team.yard.labels, { test: 'TEST', merge: 'MERGE', develop: 'DEVELOP', remote: 'REMOTE' });
  assert.equal(normalizeConfig({ sources: { queue: '/x/q.json', branch: 'release/main' } }).yard.labels.develop, 'MAIN');
});

let home;
before(() => {
  home = setupClaudeHome({}, { mergeRuns: true });
});
after(() => home.cleanup());

test('live: merge runs take no lane; their merger works the machine, which follows the run\'s phase', async () => {
  const state = await buildLiveState(createTheater(home.cfg), { now: NOW });
  assertStateShape(state);
  const plain = setupClaudeHome();
  try {
    const without = await buildLiveState(createTheater(plain.cfg), { now: NOW });
    // the same lanes and run counters as without the merge workflow
    assert.deepEqual(state.pipeline.lanes.map((l) => l.tag), without.pipeline.lanes.map((l) => l.tag));
    assert.deepEqual([state.project.done, state.project.total], [without.project.done, without.project.total]);
  } finally {
    plain.cleanup();
  }
  const merger = state.agents.find((a) => a.id === 'g7ver');
  assert.deepEqual([merger.role, merger.place, merger.lane, merger.action.kind], ['merger', 'merge', null, 'test']);
  assert.deepEqual([state.queue.release.version, state.queue.release.activity, state.queue.release.counted], ['2.4.0', 'checking', null]);
  assert.equal(state.project.release, '2.4.0');
  assert.equal(state.project.labels.batch, 'REL');
  // a merge run that finished sends no done event (it has no lane)
  assert.ok(!state.events.some((e) => (e.type === 'done' || e.type === 'stopped') && /release/i.test(e.text)));
  // a live merger: no idle one beside it
  assert.equal(state.agents.filter((a) => a.role === 'merger').length, 1);
});

test('replay: the machine follows the merge runs frame by frame', async () => {
  const r = await buildReplay(createTheater(home.cfg), { now: NOW, fromMs: at('10:30:00'), toMs: at('11:55:00'), frames: 18 });
  const frame = (hm) => r.frames.find((f) => f.now === new Date(at(hm)).toISOString());
  assert.equal(frame('10:50:00').queue.release.activity, 'integrating');
  assert.equal(frame('10:50:00').agents.find((a) => a.id === 'f6int').place, 'merge');
  // between the two merge runs nothing works the machine
  assert.equal(frame('11:25:00').queue.release, undefined);
  assert.deepEqual([frame('11:55:00').queue.release.version, frame('11:55:00').queue.release.activity], ['2.4.0', 'checking']);
  for (const f of r.frames) {
    assertStateShape(f);
    assert.ok(!f.pipeline.lanes.some((l) => /RELEASE-TRAIN/.test(l.tag)), 'no lane for a merge run');
  }
});

test('a phase that names no release goes to the release it can act on', () => {
  const q = parseQueue({ schema: 2, entries: [], releases: [{ version: '3.1.0', status: 'fixing', entries: [] }, { version: '3.2.0', status: 'open', entries: [] }] });
  const view = (activity) => releasesView(q.releases, null, NOW, { flow: { activity, phase: 'x', version: null, since: NOW, workflow: 'w', run: 'r' } }).releases.map((r) => [r.version, r.activity]);
  // an integration goes into the open release, not the one being fixed
  assert.deepEqual(view('integrating'), [['3.1.0', 'fixing'], ['3.2.0', 'integrating']]);
  assert.deepEqual(view('checking'), [['3.1.0', 'checking'], ['3.2.0', 'open']]);
  assert.deepEqual(view('fixing'), [['3.1.0', 'fixing'], ['3.2.0', 'open']]);
});
