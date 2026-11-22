// Release trains: reading the schema-2 queue and the release locks, the release views and
// activities, entry statuses from history, release merges in git, the idle merger and its log, and the
// live state and replay built from an anonymized fixture (test/fixtures/release-trains).
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { compileRules } from '../lib/rules.mjs';
import {
  IDLE_MERGER_ID,
  entryStateAt,
  expandReleaseMerges,
  historyOf,
  idleMerger,
  releaseActivity,
  releaseAt,
  releaseLog,
  releasesView,
  releasesViewAt,
} from '../lib/releases.mjs';
import { buildReplay } from '../lib/replay.mjs';
import { compareVersions, parseQueue, readLocks, readQueue } from '../lib/sources/runner.mjs';
import { buildAgentLog, buildLiveState, createTheater } from '../lib/state.mjs';
import { FIXTURES, NOW, PRESET, PRIVATE_MARKERS, RULES, assertStateShape, setupFixtures } from './helpers.mjs';

const QUEUE = JSON.parse(readFileSync(join(FIXTURES, 'release-trains', 'merge-queue.json'), 'utf8'));
const at = (hm) => Date.parse(`2026-11-19T${hm}:00.000Z`);
const owner = (holder, hm = '11:33') => ({ holder, since: new Date(at(hm)).toISOString() });
// git shows one merge for the whole release
const RELEASE_MERGE = `shaRfixture00000000000000000000000000000r\t${at('10:29') / 1000}\tMerge branch 'release/0.3.0' into develop\n`;
const releaseExec = async (args) => {
  if (args[0] !== 'log') throw new Error(`unexpected git call ${args.join(' ')}`);
  return RELEASE_MERGE;
};

let fx;
before(() => {
  fx = setupFixtures();
  fx.cfg.sources.queue = join(fx.dir, 'release-trains', 'merge-queue.json');
  fx.cfg.sources.locks = join(fx.dir, 'release-trains', 'locks');
});
after(() => fx.cleanup());

test('the schema-2 queue: releases in version order, counted entries, fix merges, legacy batches', () => {
  const q = parseQueue(QUEUE);
  assert.equal(q.schema, 2);
  assert.deepEqual(q.releases.map((r) => r.version), ['0.3.0', '0.3.1', '0.3.2']);
  const [r0, r1, r2] = q.releases;
  assert.equal(r0.status, 'passed');
  assert.equal(r0.tag, 'v0.3.0');
  // the fixer's merge is listed but never counted
  assert.deepEqual(r0.entries.map((e) => [e.type, e.counted]), [['entry', true], ['entry', true], ['release-fix', false]]);
  assert.deepEqual(r0.runs.map((r) => r.result), ['failed', 'passed']);
  assert.equal(r1.fixRounds, 2);
  assert.deepEqual(r1.movedOut, ['s03-task-02']);
  assert.equal(r1.capacity, 3);
  assert.equal(r2.openFailure.stage, 'integrate');
  assert.deepEqual(r2.openFailure.entries, ['s12-task-03']);
  // the batch history stays playable
  assert.deepEqual(q.batches.map((b) => b.n), [1]);
  // a schema-1 file still reads as before
  const old = parseQueue({ entries: [{ slug: 'a', status: 'ready' }], batches: [{ n: 2, slugs: ['a'], status: 'running' }] });
  assert.equal(old.schema, 1);
  assert.deepEqual([old.batches.length, old.releases.length], [1, 0]);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0 && compareVersions('1.0.0-rc.1', '1.0.0') < 0);
});

test('a half-written queue file keeps the last good copy for a while; a missing one is unavailable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-theater-queue-'));
  try {
    const file = join(dir, 'merge-queue.json');
    writeFileSync(file, JSON.stringify(QUEUE));
    assert.equal(readQueue(file).releases.length, 3);
    writeFileSync(file, JSON.stringify(QUEUE).slice(0, 500));
    const kept = readQueue(file);
    assert.deepEqual([kept.ok, kept.stale, kept.releases.length], [true, true, 3]);
    rmSync(file);
    assert.equal(readQueue(file).ok, false);
    assert.equal(readQueue(join(dir, 'never.json')).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the locks folder: release locks and every owner by name', () => {
  const locks = readLocks(join(FIXTURES, 'release-trains', 'locks'), 4, RULES);
  assert.equal(locks.ok, true);
  assert.deepEqual(locks.releases.map((l) => [l.version, l.owner.holder]), [['0.3.1', 'fixer-0.3.1']]);
  assert.equal(locks.byName['release-0.3.1'].holder, 'fixer-0.3.1');
  assert.equal(locks.byName['slot-2'].holder, 's05-task-01');
  assert.equal(locks.merge, null);
  // a prefix of "" turns release locks off
  assert.deepEqual(readLocks(join(FIXTURES, 'release-trains', 'locks'), 4, compileRules({ ...PRESET.rules, locks: { ...PRESET.rules.locks, release: '' } })).releases, []);
});

test('what the runner does with a release, most specific first', () => {
  const r1 = parseQueue(QUEUE).releases[1];
  const open = { ...r1, status: 'open', runs: [] };
  const slots = (h) => [1, 2, 3, 4].map((n) => ({ n, owner: h ? owner(h) : null }));
  assert.equal(releaseActivity(open, null), 'open');
  assert.equal(releaseActivity({ ...open, status: 'verifying' }, null), 'verifying');
  assert.equal(releaseActivity(open, { slots: slots(), releases: [{ version: '0.3.1', owner: owner('merger-20261119113000') }] }), 'integrating');
  assert.equal(releaseActivity(open, { slots: slots(), releases: [{ version: '0.3.1', owner: owner('fixer-0.3.1') }] }), 'fixing');
  assert.equal(releaseActivity(open, { slots: slots(), byName: { 'slot-1': owner('fixer-0.3.1') } }), 'fixing');
  assert.equal(releaseActivity({ ...open, status: 'fixing' }, null), 'fixing');
  // a check: a running run, the exclusive hold, or every booth held by release-<v>
  assert.equal(releaseActivity({ ...open, status: 'verifying', runs: [{ result: 'running' }] }, null), 'checking');
  assert.equal(releaseActivity(open, { slots: slots(), exclusive: owner('release-0.3.1') }), 'checking');
  assert.equal(releaseActivity(open, { slots: slots('release-0.3.1') }), 'checking');
  assert.notEqual(releaseActivity(open, { slots: [{ n: 1, owner: owner('release-0.3.1') }, { n: 2, owner: null }] }), 'checking');
  // the target branch's merge lock is the oldest release's final merge, and wins over everything
  assert.equal(releaseActivity({ ...open, status: 'verifying' }, { merge: owner('merger-20261119114000'), slots: slots('release-0.3.1') }, { oldest: true }), 'merging');
  assert.equal(releaseActivity({ ...open, status: 'verifying' }, { merge: owner('merger-20261119114000') }, { oldest: false }), 'verifying');
  assert.equal(releaseActivity({ ...r1, status: 'passed' }, { merge: owner('x') }, { oldest: true }), 'passed');
});

test('the machine works on the oldest unfinished release; reasons only in the private view, redacted', () => {
  const q = parseQueue(QUEUE);
  const locks = readLocks(join(FIXTURES, 'release-trains', 'locks'), 4, RULES);
  const pub = releasesView(q.releases, locks, NOW, { publicMode: true, recentMs: 60 * 60_000 });
  assert.deepEqual(pub.releases.map((r) => [r.version, r.status, r.activity]), [['0.3.1', 'fixing', 'fixing'], ['0.3.2', 'open', 'open']]);
  assert.equal(pub.release.version, '0.3.1');
  // the moved-out entry is no longer in the release, so it holds 3 of 3
  assert.deepEqual([pub.release.counted, pub.release.capacity, pub.release.entries], [3, 3, ['s05-task-02', 's12-task-02', 's02-task-06']]);
  assert.deepEqual([pub.release.fixRounds, pub.release.failures, pub.release.check.result], [2, 1, 'failed']);
  const json = JSON.stringify(pub);
  for (const m of [...PRIVATE_MARKERS, 'merger-2026', 'timed out']) assert.ok(!json.includes(m), `public view leaks ${m}`);
  // a release that passed a moment ago is still shown, and is the machine's when nothing is unfinished
  const recent = releasesView(q.releases, locks, at('10:40'), { recentMs: 60 * 60_000 });
  assert.ok(recent.releases.some((r) => r.version === '0.3.0' && r.status === 'passed'));
  const onlyPassed = releasesView([q.releases[0]], null, at('10:40'), { recentMs: 60 * 60_000 });
  assert.equal(onlyPassed.release.version, '0.3.0');
  assert.equal(releasesView([q.releases[0]], null, at('12:00'), { recentMs: 60 * 60_000 }).release, null);
  // private: the reason, with home folders removed (0.3.0 as it stood after its first check failed)
  const priv = releasesViewAt(q.releases, at('09:45'), { publicMode: false, recentMs: 60 * 60_000 });
  const reason = priv.releases.find((r) => r.version === '0.3.0').check.reason;
  assert.match(reason, /verify:full failed/);
  assert.ok(!reason.includes('fixture-user'));
  assert.match(releasesView(q.releases, locks, NOW, { publicMode: false }).release.check.reason, /timed out/);
});

test('entry statuses from their history, and from the batches before it', () => {
  const byslug = Object.fromEntries(QUEUE.entries.map((e) => [e.slug, e]));
  assert.deepEqual(historyOf(byslug['s03-task-02']).map((h) => h.status), ['queued', 'integrated', 'moved-out']);
  const state = (slug, hm) => entryStateAt(byslug[slug], QUEUE.legacyBatches, at(hm));
  assert.equal(state('s03-task-01', '07:00'), null);
  assert.deepEqual(state('s03-task-01', '08:00'), { status: 'queued', release: null });
  assert.deepEqual(state('s03-task-01', '09:00'), { status: 'integrated', release: '0.3.0' });
  assert.deepEqual(state('s03-task-01', '10:30'), { status: 'merged', release: '0.3.0' });
  assert.deepEqual(state('s03-task-02', '10:00'), { status: 'integrated', release: '0.3.1' });
  assert.deepEqual(state('s03-task-02', '11:00'), { status: 'moved-out', release: null });
  // schema 1: an entry merged by a batch, without history
  assert.deepEqual(state('s01-task-01', '05:40'), { status: 'batched', release: null });
  assert.deepEqual(state('s01-task-01', '06:30'), { status: 'merged', release: null });
  // requeue, re-add, recovery and drop
  const hist = historyOf({ history: ['2026-11-19T10:00:00.000Z moved out (release 0.3.1, with s03-task-02)', '2026-11-19T10:10:00.000Z requeued by the controller', '2026-11-19T10:20:00.000Z re-added at 1234567', '2026-11-19T10:30:00.000Z recovered as integrated into release 0.3.2 at abc', '2026-11-19T10:40:00.000Z dropped: no longer needed', 'garbage line'] });
  assert.deepEqual(hist.map((h) => h.status), ['moved-out', 'queued', 'queued', 'integrated', 'dropped']);
});

test('a release as it stood: open, checking, fixing, checking again, passed', () => {
  const r0 = parseQueue(QUEUE).releases[0];
  assert.equal(releaseAt(r0, at('07:00')), null);
  const s = (hm) => {
    const r = releaseAt(r0, at(hm));
    return [r.status, releaseActivity(r, null), r.entries.length];
  };
  assert.deepEqual(s('08:15'), ['open', 'open', 1]);
  assert.deepEqual(s('09:20'), ['verifying', 'checking', 2]);
  assert.deepEqual(s('09:45'), ['fixing', 'fixing', 2]);
  assert.deepEqual(s('10:10'), ['verifying', 'checking', 3]);
  assert.deepEqual(s('10:45'), ['passed', 'passed', 3]);
  assert.equal(releaseAt(r0, at('09:55')).fixRounds, 1);
  const past = releasesViewAt(parseQueue(QUEUE).releases, at('09:20'));
  assert.equal(past.release.version, '0.3.0');
  assert.equal(past.release.activity, 'checking');
  // 0.3.1 opened at 09:00 and is taking entries while 0.3.0 is checked
  assert.deepEqual(past.releases.map((r) => [r.version, r.status]), [['0.3.0', 'verifying'], ['0.3.1', 'open']]);
});

test('a release merge in git stands for the jobs it carried', () => {
  const q = parseQueue(QUEUE);
  const merges = [
    { sha: 'x1', at: at('10:29'), slug: 'release/0.3.0', job: null },
    { sha: 'x2', at: at('06:00'), slug: 's01-task-01', job: 'S01-TASK-01' },
    { sha: 'x3', at: at('11:00'), slug: 'release/9.9.9', job: null },
  ];
  const out = expandReleaseMerges(merges, q.releases, RULES);
  assert.deepEqual(out.map((m) => [m.slug, m.job, m.release ?? null, Boolean(m.viaRelease)]), [
    ['s01-task-01', 'S01-TASK-01', null, false],
    ['release/0.3.0', null, '0.3.0', false],
    ['s03-task-01', 'S03-TASK-01', '0.3.0', true],
    ['s04-task-02', 'S04-TASK-02', '0.3.0', true],
    ['release/9.9.9', null, '9.9.9', false],
  ]);
  // a moved-out entry did not reach the branch with its release
  const r1 = { ...q.releases[1] };
  const via = expandReleaseMerges([{ sha: 'y', at: at('11:59'), slug: 'release/0.3.1', job: null }], [r1], RULES).filter((m) => m.viaRelease);
  assert.deepEqual(via.map((m) => m.slug), ['s05-task-02', 's12-task-02', 's02-task-06']);
});

test('the idle merger says what it waits for, and is gone when there is no release work', () => {
  const view = (release, releases = [release], entries = []) => ({ release, releases, entries });
  const r = { version: '0.3.1', status: 'open', activity: 'open', counted: 2, capacity: 10, openFailure: null, check: null, openedAt: '2026-11-19T09:00:00.000Z', closedAt: null, lastIntegratedAt: '2026-11-19T10:40:00.000Z' };
  const say = (rel, releases, entries) => idleMerger(view(rel, releases, entries), { atMs: NOW })?.say ?? null;
  assert.equal(say(r), 'waiting for jobs (2/10)');
  assert.equal(say({ ...r, counted: 10 }), 'waiting to close it');
  assert.equal(say({ ...r, status: 'verifying', activity: 'verifying' }), 'waiting for the check');
  assert.equal(say({ ...r, activity: 'fixing' }), 'waiting for the fix');
  assert.equal(say({ ...r, openFailure: { stage: 'integrate', at: '2026-11-19T11:50:00.000Z', entries: [] } }), 'waiting for the fix');
  assert.equal(say({ ...r, activity: 'checking' }), 'checking the release');
  assert.equal(say({ ...r, activity: 'integrating' }), 'integrating jobs');
  assert.equal(say({ ...r, activity: 'merging' }), 'merging the release');
  // the next release taking entries while the machine's one waits
  assert.equal(say({ ...r, activity: 'verifying', status: 'verifying' }, [r, { ...r, version: '0.3.2', activity: 'integrating' }]), 'integrating jobs');
  const passed = { ...r, status: 'passed', activity: 'passed' };
  assert.equal(say(passed, [passed], [{ status: 'queued' }]), 'waiting for a release');
  assert.equal(idleMerger(view(passed, [passed], []), { atMs: NOW }), null);
  assert.equal(idleMerger(view(null, [], []), { atMs: NOW }), null);
  const idle = idleMerger(view({ ...r, openFailure: { stage: 'integrate', at: '2026-11-19T11:50:00.000Z', entries: [] } }), { atMs: NOW });
  assert.deepEqual([idle.id, idle.role, idle.place, idle.idle, idle.action.kind, idle.title], [IDLE_MERGER_ID, 'merger', 'merge', true, 'wait', 'Release 0.3.1']);
  // how long it has waited counts from the failure, not from when the release opened
  assert.equal(idle.action.since, '2026-11-19T11:50:00.000Z');
});

test('the release log: public steps without reasons, private steps with them redacted', () => {
  const q = parseQueue(QUEUE);
  const pub = releaseLog(q.releases, QUEUE.entries, { publicMode: true });
  const texts = pub.entries.map((e) => e.text);
  assert.ok(texts.includes('S03-TASK-01 integrated into release 0.3.0'));
  assert.ok(texts.includes('check 1 of release 0.3.0 failed'));
  assert.ok(texts.includes('release 0.3.0 passed and was tagged v0.3.0'));
  assert.ok(texts.includes('a fix merged into release 0.3.0'));
  // a failed check is one line (its run), an integration failure its own
  assert.ok(!texts.includes('release 0.3.0: the check step failed'));
  assert.ok(texts.includes('release 0.3.2: the integrate step failed'));
  const times = pub.entries.map((e) => Date.parse(e.t));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  for (const m of PRIVATE_MARKERS) assert.ok(!JSON.stringify(pub).includes(m), `public log leaks ${m}`);
  const priv = releaseLog(q.releases, QUEUE.entries, { publicMode: false });
  const failed = priv.entries.find((e) => e.text.startsWith('check 1 of release 0.3.0 failed'));
  assert.equal(failed.type, 'event');
  assert.match(failed.text, /verify:full failed/);
  assert.ok(!failed.text.includes('fixture-user'));
});

test('the live state with release trains', async () => {
  const theater = createTheater(fx.cfg, { exec: releaseExec });
  const state = await buildLiveState(theater, { now: NOW });
  assertStateShape(state);
  const statuses = Object.fromEntries(state.queue.entries.map((e) => [e.slug, `${e.status}${e.release ? `@${e.release}` : ''}`]));
  // jobs merged with release 0.3.0 at 10:29 settled more than recentQueueMinutes ago
  assert.deepEqual(statuses, { 's03-task-02': 'moved-out', 's05-task-02': 'integrated@0.3.1', 's12-task-02': 'integrated@0.3.1', 's02-task-06': 'integrated@0.3.1', 's05-task-01': 'integrated@0.3.2', 's12-task-03': 'queued', 'docs-pass': 'queued' });
  assert.equal(state.queue.entries.find((e) => e.slug === 's05-task-02').integratedAt, '2026-11-19T09:30:00.000Z');
  assert.equal(state.queue.release.version, '0.3.1');
  assert.equal(state.queue.release.activity, 'fixing');
  assert.deepEqual(state.queue.releases.map((r) => r.version), ['0.3.1', '0.3.2']);
  assert.equal(state.queue.batch, null);
  // the controller shows the release; jobs merged with it count as done (5 in the snapshot + 2)
  assert.equal(state.project.release, '0.3.1');
  assert.equal(state.project.labels.batch, 'REL');
  assert.equal(state.project.done, 7);
  // a merger run is live in the fixture, so no idle merger joins it; its title names the release
  const mergers = state.agents.filter((a) => a.role === 'merger');
  assert.deepEqual(mergers.map((a) => a.id), ['a05merge']);
  assert.equal(mergers[0].title, 'Release 0.3.1');
  // booth owners in public words
  assert.deepEqual(state.slots.map((s) => s.holder), ['fixer 0.3.1', 'S05-TASK-01', null, null]);
  // events from the entries' history and the release merge
  const texts = state.events.map((e) => `${e.type}: ${e.text}`);
  for (const t of ['integrated: S05-TASK-02 integrated into release 0.3.1', 'bounced: S03-TASK-02 moved out of its release', 'merged: S03-TASK-01 merged with release 0.3.0', 'released: release 0.3.0 merged', 'queued: S12-TASK-03 queued for a release']) assert.ok(texts.includes(t), t);
  const json = JSON.stringify(state);
  for (const m of [...PRIVATE_MARKERS, 'merger-2026', 'timed out', 'five fix rounds']) assert.ok(!json.includes(m), `public state leaks ${m}`);
});

test('between merger runs the merger stays at the machine, and its log is the release timeline', async () => {
  const theater = createTheater(fx.cfg, { exec: releaseExec });
  // the fixture's merger run waits for a lock in the background; four hours on it is over
  const later = NOW + 4 * 3600_000;
  const state = await buildLiveState(theater, { now: later });
  const idle = state.agents.find((a) => a.id === IDLE_MERGER_ID);
  assert.ok(idle, 'an idle merger');
  assert.deepEqual([idle.role, idle.place, idle.say, idle.title], ['merger', 'merge', 'waiting for the fix', 'Release 0.3.1']);
  const log = await buildAgentLog(theater, IDLE_MERGER_ID, { now: later, publicMode: true });
  assert.equal(log.status, 'working');
  assert.ok(log.entries.some((e) => e.text === 'release 0.3.0 passed and was tagged v0.3.0'));
});

test('replay plays release trains: entries, the machine and the idle merger per frame', async () => {
  const theater = createTheater(fx.cfg, { exec: releaseExec });
  const r = await buildReplay(theater, { now: NOW, fromMs: at('08:00'), toMs: at('11:30'), frames: 8 });
  const frame = (hm) => r.frames.find((f) => f.now === new Date(at(hm)).toISOString());
  const st = (f) => Object.fromEntries(f.queue.entries.map((e) => [e.slug, `${e.status}${e.release ? `@${e.release}` : ''}`]));
  assert.equal(frame('08:30').queue.release.version, '0.3.0');
  assert.equal(st(frame('08:30'))['s03-task-01'], 'integrated@0.3.0');
  assert.equal(frame('09:30').queue.release.activity, 'checking');
  assert.equal(frame('10:00').queue.release.activity, 'fixing');
  assert.equal(st(frame('10:00'))['s03-task-02'], 'integrated@0.3.1');
  // 0.3.0 passed at 10:30: the machine moves on to 0.3.1, and the moved-out job is back in its lane
  assert.equal(frame('11:00').queue.release.version, '0.3.1');
  assert.equal(st(frame('11:00'))['s03-task-02'], 'moved-out');
  assert.equal(st(frame('11:00'))['s03-task-01'], undefined);
  assert.equal(frame('11:00').project.release, '0.3.1');
  for (const f of r.frames) assertStateShape(f);
  // the release merge and its jobs are in the frame after 10:29
  const ev = frame('10:30').events.map((e) => e.type);
  assert.ok(ev.includes('released') && ev.filter((t) => t === 'merged').length === 2, JSON.stringify(ev));
  // frames where no merger run was live keep the merger at the machine
  assert.ok(r.frames.some((f) => f.agents.some((a) => a.id === IDLE_MERGER_ID)));
});
