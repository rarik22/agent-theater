// The generic "runs" model on a synthetic Claude Code home: one lane per workflow run, its stations
// the workflow's own phases, agents at the station of their phase, run records ending runs (no ghosts),
// counters of runs and agents, done/stopped/pushed events, test booths from background tests, and a
// replay in which the run's agents hand over from station to station.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { normalizeConfig } from '../lib/config.mjs';
import { replayWindow, buildReplay } from '../lib/replay.mjs';
import { compileRules, stationKindOf, stationTag } from '../lib/rules.mjs';
import { LaunchIndex, discoverSessions, parseWorkflowMeta, scanRuns } from '../lib/sources/claude.mjs';
import { assignChips, buildLiveState, createTheater } from '../lib/state.mjs';
import { TranscriptCache } from '../lib/transcripts.mjs';
import { PROJECT, SESSION, setupClaudeHome } from './claude-home.mjs';
import { NOW, assertStateShape } from './helpers.mjs';

let fx;
before(() => {
  fx = setupClaudeHome();
});
after(() => fx.cleanup());

const at = (hm) => Date.parse(`2026-11-19T${hm}:00.000Z`);
const live = (opts = {}, cfg = fx.cfg) => buildLiveState(createTheater(cfg), { now: NOW, ...opts });

test('sessions are discovered under ~/.claude/projects, active ones only, filtered by project', () => {
  const sessions = discoverSessions(fx.cfg, { sinceMs: at('00:00') });
  assert.deepEqual(sessions.map((s) => s.project), [PROJECT]);
  assert.equal(discoverSessions(fx.cfg, { sinceMs: 0 }).length, 2);
  const only = { ...fx.cfg, sources: { ...fx.cfg.sources, projects: ['*idle*'] } };
  assert.deepEqual(discoverSessions(only, { sinceMs: 0 }).map((s) => s.project), ['-home-dev-idle']);
});

test('Claude Code\'s folder: sources.claude, else CLAUDE_CONFIG_DIR, else ~/.claude', () => {
  const env = { CLAUDE_CONFIG_DIR: join(tmpdir(), 'cc-home') };
  assert.equal(normalizeConfig({}, tmpdir(), env).sources.claude, env.CLAUDE_CONFIG_DIR);
  assert.equal(normalizeConfig({}, tmpdir(), {}).sources.claude, join(homedir(), '.claude'));
  assert.equal(normalizeConfig({ sources: { claude: '/srv/cc' } }, tmpdir(), env).sources.claude, resolve('/srv/cc'));
  assert.equal(normalizeConfig({ sources: { claude: false } }, tmpdir(), env).sources.claude, null);
  // one named workflows folder still means no discovery
  assert.equal(normalizeConfig({ sources: { workflows: '/srv/w/workflows' } }, tmpdir(), env).sources.claude, null);
});

test('a run\'s phases come from its record, its launch, its persisted script, or its journal', () => {
  const sessions = discoverSessions(fx.cfg, { sinceMs: at('00:00') });
  const { runs } = scanRuns(sessions, new TranscriptCache(), { launches: new LaunchIndex(), sinceMs: NOW - 24 * 3600_000 });
  const byId = Object.fromEntries(runs.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(byId).sort(), ['wf_build-a1', 'wf_docs-c3', 'wf_fix-b2', 'wf_new-d4']); // wf_old-e5 ended yesterday
  assert.deepEqual([byId['wf_build-a1'].workflow, byId['wf_build-a1'].phases, byId['wf_build-a1'].status], ['feature-build', ['Setup', 'Implement', 'Review', 'Ship'], 'completed']);
  assert.deepEqual([byId['wf_fix-b2'].workflow, byId['wf_fix-b2'].phases, byId['wf_fix-b2'].subject, byId['wf_fix-b2'].status], ['bugfix', ['Reproduce', 'Fix', 'Verify'], 'BUG-42', 'running']);
  assert.deepEqual([byId['wf_docs-c3'].status, byId['wf_docs-c3'].endMs], ['killed', at('11:59')]);
  assert.deepEqual(byId['wf_new-d4'].phases, ['Setup', 'Build', 'Test', 'Review', 'Fix', 'Prep', 'Publish']);
  // without the launch index the running run still has the phases its agents used
  const bare = scanRuns(sessions, new TranscriptCache(), { sinceMs: NOW - 24 * 3600_000 }).runs.find((r) => r.id === 'wf_fix-b2');
  assert.deepEqual([bare.workflow, bare.phases], [null, ['Reproduce', 'Fix']]);
});

test('workflow meta parsing survives brackets and quotes inside strings', () => {
  const m = parseWorkflowMeta("export const meta = { name: \"x\", phases: [{ title: 'A [1]', detail: \"b ] c\" }, { title: `C's` }, { title: 'D\\'s' }] }");
  assert.deepEqual(m, { name: 'x', phases: ['A [1]', "C's", "D's"] });
  assert.deepEqual(parseWorkflowMeta('no meta here'), { name: null, phases: [] });
});

test('lanes are workflow runs; stations are their phases; agents stand at their phase\'s station', async () => {
  const state = await live();
  assertStateShape(state);
  assert.equal(state.pipeline.model, 'runs');
  const lanes = state.pipeline.lanes;
  // the finished run left the stage two minutes after it ended; the stopped one lingers as stopped
  assert.deepEqual(lanes.map((l) => [l.id, l.tag, l.status]), [['BUG', 'BUG-42', 'running'], ['DOCS', 'DOCS-PASS', 'killed'], ['RELCUT', 'RELEASE-CUT', 'running']]);
  const bug = lanes[0];
  assert.deepEqual(bug.stations, [{ tag: 'REPRODUCE', kind: 'setup' }, { tag: 'FIX', kind: 'fixer' }, { tag: 'VERIFY', kind: 'reviewer' }]);
  assert.deepEqual([bug.current, bug.done, bug.active, bug.show, bug.progress], [1, 1, true, true, { done: 1, total: 3 }]);
  // seven phases: the stage shows the first six
  assert.deepEqual(lanes[2].stations.map((s) => s.tag), ['SETUP', 'BUILD', 'TEST', 'REVIEW', 'FIX', 'PREP']);
  const byId = Object.fromEntries(state.agents.map((a) => [a.id, a]));
  // the stopped run's agent has ended with its run, though its transcript is only 90 s quiet
  assert.deepEqual(Object.keys(byId).sort(), ['b2fix', 'd4build', 's1helper']);
  assert.deepEqual([byId.b2fix.lane, byId.b2fix.station, byId.b2fix.stationTag, byId.b2fix.role, byId.b2fix.job], ['BUG', 1, 'FIX', 'fixer', 'RUN-FIX-B2']);
  assert.deepEqual([byId.b2fix.action.kind, byId.b2fix.action.text], ['test', 'running tests (background)']);
  assert.deepEqual([byId.d4build.lane, byId.d4build.station, byId.d4build.role], ['RELCUT', 1, 'coder']);
  // a standalone subagent stands on the dock with a tag
  assert.deepEqual([byId.s1helper.lane, byId.s1helper.station, byId.s1helper.role, byId.s1helper.tag, byId.s1helper.standalone], [null, null, 'helper', 'DOCS', true]);
  // the test booths hold the lanes running tests in the background
  assert.deepEqual(state.slots.map((s) => s.holder), ['BUG', null, null, null]);
  assert.deepEqual(state.yard.labels, { test: 'TEST', merge: 'FINISH', develop: 'DONE', remote: 'REMOTE' });
});

test('counters: runs done of started and agents finished of started in the last 24 hours; LIVE runs', async () => {
  const state = await live();
  assert.deepEqual([state.project.done, state.project.total], [1, 4]);
  assert.deepEqual(state.project.features, { done: 5, total: 8 });
  assert.equal(state.project.batch, 2);
  assert.deepEqual(state.project.labels, { jobs: 'RUNS', features: 'AGENTS', batch: 'LIVE' });
  const custom = await live({}, { ...fx.cfg, counters: { jobs: 'TASKS', features: 'BOTS', batch: 'NOW' } });
  assert.deepEqual(custom.project.labels, { jobs: 'TASKS', features: 'BOTS', batch: 'NOW' });
});

test('events: a finished run is done, a stopped one stopped, a git push pushed', async () => {
  const state = await live();
  const of = (type) => state.events.filter((e) => e.type === type);
  assert.deepEqual(of('done').map((e) => [e.text, e.at]), [['FEATURE-BUILD done', '2026-11-19T11:50:00.000Z']]);
  assert.deepEqual(of('stopped').map((e) => [e.lane, e.at]), [['DOCS', '2026-11-19T11:59:00.000Z']]);
  assert.deepEqual(of('pushed').map((e) => [e.lane, e.at]), [['RELCUT', '2026-11-19T11:59:50.000Z']]);
  assert.equal(new Set(state.events.map((e) => e.id)).size, state.events.length);
});

test('public mode keeps project folders, session ids, paths, args and descriptions out', async () => {
  const json = JSON.stringify(await live({ publicMode: true }));
  for (const marker of [PROJECT, 'home-dev', SESSION, '/home/dev', 'cart.ts', 'example.com', 'Totals are wrong', 'Research the docs', 'vitest', 'git push']) assert.ok(!json.includes(marker), `public state leaks "${marker}"`);
});

test('chips are short, unique and stay with their lane', () => {
  const map = new Map();
  const lanes = [{ key: 'a', tag: 'BUG-42' }, { key: 'b', tag: 'BUG-43' }, { key: 'c', tag: 'BACKEND-RELEASE-TRAINS' }, { key: 'd', tag: 'X' }];
  assert.deepEqual(assignChips(lanes, map).map((l) => l.id), ['BUG', 'BUG43', 'BACREL', 'X']);
  // the first lane leaves; the second keeps its chip
  assert.deepEqual(assignChips([lanes[1], lanes[2]], map).map((l) => l.id), ['BUG43', 'BACREL']);
});

test('station words: tags and console kinds from phase titles', () => {
  assert.deepEqual(['Setup', 'Implement', 'Review', 'Fix', 'Prepare', 'Verify', 'Merge fix', 'QA', 'Polish', 'Ship'].map((t) => stationKindOf(t)), ['setup', 'coder', 'reviewer', 'fixer', 'preparer', 'reviewer', 'preparer', 'reviewer', 'fixer', 'preparer']);
  assert.deepEqual([stationKindOf('Alpha', 0, 3), stationKindOf('Beta', 1, 3), stationKindOf('Gamma', 2, 3)], ['setup', 'coder', 'preparer']);
  assert.equal(stationTag('Concepts (4 directions) for the hub'), 'CONCEPTS 4');
  assert.equal(stationTag('Final check'), 'FINAL CHECK');
  assert.equal(compileRules({}).labels.length, 0);
});

test('replay: runs appear and leave, and a run\'s agents hand over from station to station', async () => {
  const theater = createTheater(fx.cfg);
  assert.throws(() => replayWindow(fx.cfg, { now: NOW, fromMs: at('12:30'), toMs: at('13:00') }), /future/);
  const r = await buildReplay(theater, { now: NOW, fromMs: at('11:00'), toMs: at('12:00'), frames: 7 });
  const frame = (hm) => r.frames.find((f) => f.now === `2026-11-19T${hm}:00.000Z`);
  for (const f of r.frames) assertStateShape(f);
  const lane = (hm, tag) => frame(hm).pipeline.lanes.find((l) => l.tag === tag);
  // 11:30: the bug run reproduces at station 0; 11:50: its fixer works at station 1, same job
  const repro = frame('11:30').agents.find((a) => a.id === 'b2repro');
  const fix = frame('11:50').agents.find((a) => a.id === 'b2fix');
  assert.deepEqual([repro.lane, repro.station, fix.lane, fix.station], ['BUG', 0, 'BUG', 1]);
  assert.equal(repro.job, fix.job);
  assert.deepEqual([lane('11:30', 'BUG-42').current, lane('11:50', 'BUG-42').current], [0, 1]);
  // the feature run is on stage until it ends at 11:50 (completed, every station done)
  assert.deepEqual([lane('11:40', 'FEATURE-BUILD').status, lane('11:50', 'FEATURE-BUILD').status, lane('11:50', 'FEATURE-BUILD').done], ['running', 'completed', 4]);
  assert.equal(lane('12:00', 'FEATURE-BUILD'), undefined);
  // its done event is in the frame of 11:50
  assert.ok(frame('11:50').events.some((e) => e.type === 'done'));
  // counters walk with the frames
  assert.deepEqual([frame('11:00').project.done, frame('12:00').project.done], [0, 1]);
});
