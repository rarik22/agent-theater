// Live accuracy: who is really working. Ghost agents (stopped, relaunched, or quiet with nothing in
// flight) leave the stage; process and runner jobs get a tag and a role; standalone subagents appear at
// the dock with a tag, never their description; an agent waiting on a background run shows what that
// run does, never "thinking". Fixture transcripts in test/fixtures have each shape (see helpers.mjs).
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { classifyLabel, classifyStandalone, classifyToolUse, publicPhrase } from '../lib/classify.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { replayAction } from '../lib/replay.mjs';
import { discoverSessions, markRelaunches, scanRuns, scanStandalone } from '../lib/sources/claude.mjs';
import { agentLiveness, buildLiveState, createTheater } from '../lib/state.mjs';
import { TranscriptCache, backgroundAt } from '../lib/transcripts.mjs';
import { NOW, RULES, fakeExec, setupFixtures } from './helpers.mjs';

let fx;
before(() => {
  fx = setupFixtures();
});
after(() => fx.cleanup());

const at = (hms) => Date.parse(`2026-11-19T${hms}.000Z`);
const live = (cfg = fx.cfg, opts = {}) => buildLiveState(createTheater(cfg, { exec: fakeExec }), { now: NOW, ...opts });
const lifeOf = (id, over = {}) => {
  const transcripts = new TranscriptCache(RULES);
  const sessions = discoverSessions(fx.cfg);
  const all = [...scanRuns(sessions, transcripts, { rules: RULES, relaunch: true }).agents, ...scanStandalone(sessions, transcripts, { rules: RULES }).agents];
  const agent = all.find((a) => a.agentId === id);
  const entry = transcripts.get(agent.transcript);
  return { agent, entry, life: agentLiveness(agent, entry, { now: NOW, quietMs: 5 * 60_000, bgMaxMs: 180 * 60_000, ...over }) };
};

test('ghosts: stopped, relaunched and quiet agents with nothing in flight have ended', async () => {
  // TaskStop: the transcript ends with "[Request interrupted by user]" two minutes ago
  assert.deepEqual([lifeOf('a14ghost').life.active, lifeOf('a14ghost').life.reason, lifeOf('a14ghost').life.endMs], [false, 'stopped', at('11:58:00')]);
  // relaunched: the same label started in a newer run at 11:50, although it wrote at 11:49 and had a
  // measurement in flight
  const old = lifeOf('a17old');
  assert.equal(old.agent.relaunchedAt, at('11:50:00'));
  assert.deepEqual([old.life.active, old.life.reason], [false, 'relaunched']);
  assert.ok(old.life.endMs <= at('11:50:00'));
  // quiet: background tests finished at 11:40, last word at 11:41, nothing since
  assert.deepEqual([lifeOf('a16bgdone').life.active, lifeOf('a16bgdone').life.reason, lifeOf('a16bgdone').life.endMs], [false, 'quiet', at('11:41:00')]);
  assert.deepEqual([lifeOf('a04fix').life.active, lifeOf('a04fix').life.reason], [false, 'quiet']);
  // the newer launch of the relaunched job works on
  assert.deepEqual([lifeOf('a18new').life.active, lifeOf('a18new').agent.relaunchedAt], [true, null]);
  // a short quiet spell (2m20s) with no tool call for 4 minutes is thinking, not a ghost ...
  assert.equal(lifeOf('a13think').life.active, true);
  // ... unless the quiet threshold is shorter than that
  assert.equal(lifeOf('a13think', { quietMs: 60_000 }).life.active, false);
  const state = await live();
  const ids = state.agents.map((a) => a.id);
  for (const ghost of ['a04fix', 'a14ghost', 'a16bgdone', 'a17old']) assert.ok(!ids.includes(ghost), `${ghost} is not on stage`);
  assert.ok(state.agents.every((a) => a.action.text !== 'thinking' || a.id === 'a13think'), 'nobody else shows as thinking');
  assert.equal(state.agents.find((a) => a.id === 'a13think').action.kind, 'think');
});

test('a stopped agent that writes again was resumed', async () => {
  const f = setupFixtures();
  try {
    const file = join(f.dir, 'workflows', 'wf_fixture-d', 'agent-a14ghost.jsonl');
    const theater = createTheater(f.cfg, { exec: fakeExec });
    assert.ok(!(await buildLiveState(theater, { now: NOW })).agents.some((a) => a.id === 'a14ghost'));
    appendFileSync(file, `${JSON.stringify({ type: 'assistant', timestamp: '2026-11-19T11:59:40.000Z', agentId: 'a14ghost', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_d14b', name: 'Read', input: { file_path: 'C:/wt/a.ts' } }] } })}\n`);
    const again = (await buildLiveState(theater, { now: NOW })).agents.find((a) => a.id === 'a14ghost');
    assert.ok(again, 'back on stage');
    assert.equal(again.action.kind, 'read');
  } finally {
    f.cleanup();
  }
});

test('relaunches are matched by label across runs, never within one run', () => {
  const a = (run, label, startMs) => ({ run, label, startMs, relaunchedAt: null });
  const list = [a('wf_1', 'OPS-RELEASE-TRAINS', 1), a('wf_2', 'OPS-RELEASE-TRAINS', 5), a('wf_3', 'ops-release-trains', 9), a('wf_3', 'S03-TASK-02 review 1', 2), a('wf_3', 'S03-TASK-02 review 1', 4)];
  markRelaunches(list);
  assert.deepEqual(list.map((x) => x.relaunchedAt), [5, 9, null, null, null]);
});

test('job tags: process, runner and release work get a job, a role and a short public tag', async () => {
  const cases = [
    ['OPS-RELEASE-TRAINS', 'coder', 'OPS-RELEASE-TRAINS', 'RELEASE-TRAINS'],
    ['OPS-RELEASE-TRAINS review 1', 'reviewer', 'OPS-RELEASE-TRAINS', 'RELEASE-TRAINS'],
    ['OPS-RELEASE-TRAINS fix 2', 'fixer', 'OPS-RELEASE-TRAINS', 'RELEASE-TRAINS'],
    ['OPS-RELEASE-TRAINS prepare', 'preparer', 'OPS-RELEASE-TRAINS', 'RELEASE-TRAINS'],
    ['OPS-IMAGE-TAG setup', 'setup', 'OPS-IMAGE-TAG', 'IMAGE-TAG'],
    ['merge batch', 'merger', null, 'MERGE'],
    ['fix:queue', 'fixer', null, 'QUEUE'],
    ['verify:all', 'verifier', null, 'VERIFY'],
    ['release 0.1.0 integrate', 'merger', 'RELEASE-0.1.0', 'REL-0.1.0'],
    ['release 0.1.0 verify', 'merger', 'RELEASE-0.1.0', 'REL-0.1.0'],
    ['release 0.1.0 fix', 'fixer', 'RELEASE-0.1.0', 'REL-0.1.0'],
    // the labels team-release.js really uses
    ['integrate', 'merger', 'RELEASE', 'RELEASE'],
    ['verify release', 'merger', 'RELEASE', 'RELEASE'],
    ['verify 0.1.0', 'merger', 'RELEASE-0.1.0', 'REL-0.1.0'],
    ['fix 0.1.2', 'fixer', 'RELEASE-0.1.2', 'REL-0.1.2'],
    ['fix 0.1.2 review 2', 'reviewer', 'RELEASE-0.1.2', 'REL-0.1.2'],
    ['fix 0.1.2 re-fix 1', 'fixer', 'RELEASE-0.1.2', 'REL-0.1.2'],
    ['fix 0.1.2 merge', 'fixer', 'RELEASE-0.1.2', 'REL-0.1.2'],
    ['S03-TASK-02 integrate', 'preparer', 'S03-TASK-02', 'S03-TASK-02'],
    ['verify:safety', 'verifier', null, 'SAFETY'],
    ['S12-TASK-02 fix 1', 'fixer', 'S12-TASK-02', 'S12-TASK-02'],
  ];
  for (const [label, role, job, tag] of cases) assert.deepEqual(classifyLabel(label, RULES), { ...classifyLabel(label, RULES), role, job, tag }, label);
  const state = await live();
  const proc = state.agents.find((a) => a.id === 'a18new');
  assert.deepEqual([proc.role, proc.job, proc.tag, proc.lane, proc.station, proc.action.kind, proc.action.text], ['coder', 'OPS-RELEASE-TRAINS', 'RELEASE-TRAINS', null, null, 'edit', 'writing code']);
  // where they stand: a process job has no lane (the dock), the merger is at the machine, a lane
  // reviewer at its lane's REVIEW station
  const merger = state.agents.find((a) => a.id === 'a05merge');
  assert.deepEqual([merger.place, merger.station], ['merge', null]);
  const reviewer = state.agents.find((a) => a.id === 'a03review');
  assert.deepEqual([reviewer.lane, reviewer.station, reviewer.stationTag], ['S05', 2, 'REVIEW']);
});

test('standalone subagents appear at the dock with a tag, never their description', async () => {
  assert.deepEqual(classifyStandalone({ description: 'Rework runner for PLAN-17 releases', agentType: 'general-purpose' }, RULES), { role: 'coder', tag: 'RUNNER' });
  assert.deepEqual(classifyStandalone({ description: 'Survey the docker janitor logs', agentType: 'Explore' }), { role: 'helper', tag: 'DOCKER' });
  assert.equal(classifyStandalone({ description: 'Review the S03-TASK-02 diff' }, RULES).tag, 'S03-TASK-02');
  assert.equal(classifyStandalone({ description: 'Plan the PLAN-17 cut' }, RULES).tag, 'PLAN-17');
  assert.equal(classifyStandalone({ description: 'something else entirely' }).tag, 'AGENT');
  // without a preset only the built-in words make tags
  assert.equal(classifyStandalone({ description: 'Rework runner for PLAN-17 releases' }).tag, 'RELEASE');
  const state = await live();
  const s = state.agents.find((a) => a.id === 's01runner');
  assert.deepEqual([s.role, s.job, s.tag, s.label, s.title, s.standalone, s.lane, s.action.kind, s.action.text], ['coder', null, 'RUNNER', 'RUNNER', 'RUNNER', true, null, 'test', 'running tests']);
  assert.ok(!JSON.stringify(state).includes('Rework runner'), 'the description stays private');
  assert.ok(!state.agents.some((a) => a.id === 's02done'), 'a finished standalone agent is gone');
  assert.ok(!state.agents.some((a) => a.id === 's03quiet'), 'a quiet standalone agent is gone');
  // the private view shows the (redacted) description
  const priv = await live(fx.cfg, { publicMode: false });
  assert.equal(priv.agents.find((a) => a.id === 's01runner').label, 'Rework runner for PLAN-17 releases');
  // "subagents": false leaves them out
  const off = normalizeConfig({ ...fx.cfg, sources: { ...fx.cfg.sources, subagents: false } }, fx.dir);
  assert.ok(!(await live(off)).agents.some((a) => a.standalone));
});

test('waiting on a background run shows what the run does, never thinking', async () => {
  const state = await live();
  const byId = Object.fromEntries(state.agents.map((a) => [a.id, a]));
  // a live check started 30 minutes ago, quiet since: on stage, running the check
  assert.deepEqual([byId.a15bgcheck.action.kind, byId.a15bgcheck.action.text, byId.a15bgcheck.action.background], ['test', 'running a live check (background)', true]);
  // waiting with a sleep loop on background tests: the tests, not the loop
  assert.deepEqual([byId.a19poll.action.kind, byId.a19poll.action.text], ['test', 'running tests (background)']);
  // a booth command queued in the background with no booth in the lock files: waiting for a booth
  assert.equal(byId.a12waiter.action.text, 'waiting for a test booth');
  // background runs in flight, by notification
  const { entry } = lifeOf('a16bgdone');
  assert.equal(backgroundAt(entry, at('11:30:00')).length, 1);
  assert.equal(backgroundAt(entry, at('11:40:00')).length, 0);
  // a run with no notice counts as in flight only up to backgroundMaxMinutes
  const short = normalizeConfig({ ...fx.cfg, backgroundMaxMinutes: 20 }, fx.dir);
  assert.ok(!(await live(short)).agents.some((a) => a.id === 'a15bgcheck'));
  // replay frames use the same rule for past moments
  const bg = lifeOf('a15bgcheck');
  const past = replayAction(bg.entry.uses, at('11:45:00'), 120_000, bg.entry);
  assert.deepEqual([past.kind, past.detail, past.background], ['test', 'check', true]);
  // "thinking" only after two minutes with no tool call and nothing in flight
  assert.equal(replayAction(bg.entry.uses, at('11:45:00'), 120_000).kind, 'think', 'without the background run it would have been thinking');
});

test('commands name what they really run', () => {
  const kindOf = (command, extra = {}) => {
    const u = classifyToolUse('Bash', { command, ...extra }, RULES);
    return [u.kind, publicPhrase(u.kind, 'coder', u.wait, u)];
  };
  assert.deepEqual(kindOf('pnpm exec vitest run'), ['test', 'running tests']);
  assert.deepEqual(kindOf('pnpm exec turbo run build typecheck lint test --concurrency=3'), ['test', 'running tests']);
  assert.deepEqual(kindOf('bash .runner/measure-tests.sh before'), ['test', 'measuring test times']);
  assert.deepEqual(kindOf('pnpm ui:tour'), ['test', 'running a live check']);
  // the built-in live checks (a preset's list replaces them)
  assert.equal(classifyToolUse('Bash', { command: 'npx playwright test' }).detail, 'check');
  assert.deepEqual(kindOf('pnpm backup:check'), ['test', 'running a live check']);
  assert.deepEqual(kindOf('pnpm login:e2e'), ['test', 'running a live check']);
  assert.deepEqual(kindOf('pnpm verify:full'), ['test', 'running a live check']);
  assert.deepEqual(kindOf('bash tools/booth.sh exclusive release-trains bash .runner/measure/before.sh'), ['test', 'measuring test times']);
  assert.deepEqual(kindOf('docker compose up -d'), ['docker', 'starting containers']);
  assert.deepEqual(kindOf('pnpm exec turbo run build'), ['run', 'building']);
  assert.deepEqual(kindOf('for i in $(seq 1 30); do grep -q "^exit" /c/t/tasks/b1.output && break; sleep 15; done'), ['wait', 'waiting for a long check']);
  assert.deepEqual(kindOf('git status'), ['run', 'running a command']);
  // a command that only names a script: its description says what it runs
  assert.deepEqual(kindOf('bash /c/tmp/p12c02-tests.sh', { description: 'Run the targeted test files per package in sequence' }), ['test', 'running tests']);
  // a background loop that only waits for another run is a wait, not work
  const waiter = classifyToolUse('Bash', { command: 'until grep -qE "database exit=" /c/tmp/summary.txt; do sleep 5; done', run_in_background: true, description: 'Wait until the database tests finish' }, RULES);
  assert.deepEqual([waiter.kind, waiter.poll, waiter.background], ['wait', true, true]);
  // a background run of tests reads as such
  assert.equal(publicPhrase('test', 'coder', null, { detail: 'tests', background: true }), 'running tests (background)');
  assert.equal(publicPhrase('think', 'coder', null, { detail: 'tests' }), 'thinking');
});

test('a standalone folder with other files is read safely', () => {
  const f = setupFixtures();
  try {
    writeFileSync(join(f.dir, 'notes.jsonl'), '{}\n');
    writeFileSync(join(f.dir, 'agent-bad name.jsonl'), '{}\n');
    const got = scanStandalone([{ key: 's0', subagentsDir: f.dir }], new TranscriptCache()).agents.map((a) => a.agentId).sort();
    assert.deepEqual(got, ['s01runner', 's02done', 's03quiet']);
  } finally {
    f.cleanup();
  }
});
