// Shared test helpers: a private copy of the synthetic fixtures with controlled file times, a fake git,
// and a schema check for the state object.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KINDS, ROLES } from '../lib/classify.mjs';
import { merge, normalizeConfig } from '../lib/config.mjs';
import { compileRules } from '../lib/rules.mjs';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
/** The neutral test preset (a runner pipeline with lanes S00..S15) and its compiled rules. */
export const PRESET = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'preset.json'), 'utf8'));
export const RULES = compileRules(PRESET.rules);

export const NOW = Date.parse('2026-11-19T12:00:00.000Z');

// Transcript modification times (UTC, 2026-11-19): what "changed in the last 20 minutes" is measured on.
const MTIMES = {
  'wf_fixture-a/agent-a01setup.jsonl': '10:05:00',
  'wf_fixture-a/agent-a02coder.jsonl': '11:59:40',
  'wf_fixture-b/agent-a03review.jsonl': '11:59:05',
  'wf_fixture-b/agent-a04fix.jsonl': '11:45:00',
  'wf_fixture-c/agent-a05merge.jsonl': '11:58:05',
  'wf_fixture-c/agent-a06lens.jsonl': '11:59:12',
  'wf_fixture-c/agent-a07prep.jsonl': '11:58:35',
  'wf_fixture-c/agent-a08stale.jsonl': '11:15:00',
  'wf_fixture-c/agent-a09integ.jsonl': '11:59:52',
  'wf_fixture-c/agent-a10probe.jsonl': '11:59:56',
  'wf_fixture-c/agent-a11gate.jsonl': '09:30:00',
  'wf_fixture-c/agent-a12waiter.jsonl': '11:59:02',
  'wf_fixture-d/agent-a13think.jsonl': '11:57:40',
  'wf_fixture-d/agent-a14ghost.jsonl': '11:58:00',
  'wf_fixture-d/agent-a15bgcheck.jsonl': '11:30:30',
  'wf_fixture-d/agent-a16bgdone.jsonl': '11:41:00',
  'wf_fixture-d/agent-a19poll.jsonl': '11:58:00',
  'wf_fixture-e/agent-a17old.jsonl': '11:49:01',
  'wf_fixture-f/agent-a18new.jsonl': '11:59:30',
};
// Standalone subagent transcripts in the session's subagents folder (the fixture root).
const ROOT_MTIMES = {
  'agent-s01runner.jsonl': '11:59:00',
  'agent-s02done.jsonl': '11:59:00',
  'agent-s03quiet.jsonl': '11:20:00',
};

/** Copy the fixtures to a temp dir, set transcript mtimes, and return { dir, cfg, cleanup }. */
export function setupFixtures(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-theater-test-'));
  cpSync(FIXTURES, dir, { recursive: true });
  for (const [file, hms] of Object.entries(MTIMES)) {
    const t = new Date(`2026-11-19T${hms}.000Z`);
    utimesSync(join(dir, 'workflows', file), t, t);
  }
  for (const [file, hms] of Object.entries(ROOT_MTIMES)) {
    const t = new Date(`2026-11-19T${hms}.000Z`);
    utimesSync(join(dir, file), t, t);
  }
  const preset = JSON.parse(readFileSync(join(FIXTURES, 'preset.json'), 'utf8'));
  const cfg = normalizeConfig(
    merge(preset, {
      projectName: 'Example Project',
      sources: {
        workflows: join(dir, 'workflows'),
        repo: join(dir, 'repo-not-used'),
        branch: 'develop',
        lanes: join(dir, 'runner', 'lanes.json'),
        queue: join(dir, 'runner', 'merge-queue.json'),
        locks: join(dir, 'runner', 'locks'),
        progress: join(dir, 'progress.json'),
      },
      publicDir: join(dir, 'public'),
      ...overrides,
    }),
    dir,
  );
  return { dir, cfg, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Fake git: answers the two log queries the server makes from fixture text files. */
export async function fakeExec(args) {
  if (args[0] !== 'log') throw new Error(`unexpected git call ${args.join(' ')}`);
  if (args[1] === 'abc1234..develop') return readFileSync(join(FIXTURES, 'git-after.txt'), 'utf8');
  return readFileSync(join(FIXTURES, 'git-merges.txt'), 'utf8');
}

export async function failingExec() {
  throw new Error('git unavailable');
}

const isIsoOrNull = (v) => v === null || (typeof v === 'string' && Number.isFinite(Date.parse(v)));

/** Assert the documented state schema (live, replay frame or sample). */
export function assertStateShape(state) {
  assert.ok(isIsoOrNull(state.now) && state.now !== null, 'now');
  assert.ok(['live', 'replay'].includes(state.mode), 'mode');
  assert.ok(state.project.name === null || typeof state.project.name === 'string');
  assert.ok(state.project.done === null || Number.isInteger(state.project.done));
  assert.ok(state.project.total === null || Number.isInteger(state.project.total));
  if (state.project.features !== undefined && state.project.features !== null) {
    assert.ok(Number.isInteger(state.project.features.done) && Number.isInteger(state.project.features.total), 'features');
    assert.ok(state.project.features.done <= state.project.features.total);
  }
  for (const k of ['jobs', 'features', 'batch']) assert.match(state.project.labels[k], /^[A-Z0-9 ]{1,8}$/, `label ${k}`);
  assert.ok(Array.isArray(state.pipeline.lanes));
  const laneIds = new Set();
  for (const l of state.pipeline.lanes) {
    assert.match(l.id, /^[A-Z0-9][A-Z0-9-]{0,5}$/, `lane id ${l.id}`);
    assert.ok(!laneIds.has(l.id), `lane ids are unique (${l.id})`);
    laneIds.add(l.id);
    assert.match(l.tag, /^[A-Z0-9][A-Z0-9.-]{0,15}$/, `lane tag ${l.tag}`);
    assert.ok(l.stations.length >= 1 && l.stations.length <= 6, 'stations');
    for (const st of l.stations) {
      assert.match(st.tag, /^[A-Z0-9][A-Z0-9 .-]{0,11}$/, `station tag ${st.tag}`);
      assert.ok(['setup', 'coder', 'reviewer', 'fixer', 'preparer'].includes(st.kind), `station kind ${st.kind}`);
    }
    assert.ok(['running', 'completed', 'killed', 'waiting', 'idle'].includes(l.status), `lane status ${l.status}`);
    assert.equal(typeof l.show, 'boolean');
    assert.equal(typeof l.active, 'boolean');
  }
  assert.ok(Array.isArray(state.agents));
  for (const a of state.agents) {
    assert.equal(typeof a.id, 'string');
    assert.ok(ROLES.includes(a.role), `role ${a.role}`);
    assert.ok(KINDS.includes(a.action.kind), `kind ${a.action.kind}`);
    assert.equal(typeof a.action.text, 'string');
    assert.ok(a.job === null || typeof a.job === 'string');
    assert.ok(a.lane === null || typeof a.lane === 'string');
    assert.ok(a.station === null || Number.isInteger(a.station));
    assert.equal(typeof a.title, 'string');
    assert.ok(isIsoOrNull(a.since));
  }
  assert.ok(Array.isArray(state.queue.entries));
  for (const e of state.queue.entries) {
    assert.equal(typeof e.slug, 'string');
    assert.ok(['ready', 'batched', 'merged', 'bounced', 'held', 'dropped'].includes(e.status), `status ${e.status}`);
  }
  assert.ok(state.queue.batch === null || state.queue.batch === undefined || (Number.isInteger(state.queue.batch.n) && Array.isArray(state.queue.batch.slugs)));
  assert.ok(Array.isArray(state.slots));
  for (const s of state.slots) {
    assert.ok(Number.isInteger(s.n));
    assert.ok(s.holder === null || typeof s.holder === 'string');
    assert.ok(isIsoOrNull(s.since));
  }
  for (const key of ['exclusive', 'lock']) assert.ok(state[key] === null || typeof state[key].holder === 'string', key);
  assert.ok(Array.isArray(state.events));
  for (const e of state.events) {
    assert.ok(['merged', 'bounced', 'started', 'finished', 'queued', 'done', 'stopped', 'pushed'].includes(e.type), `event ${e.type}`);
    assert.ok(isIsoOrNull(e.at) && e.at !== null);
    assert.equal(typeof e.text, 'string');
  }
  for (const k of ['test', 'merge', 'develop', 'remote']) assert.match(state.yard.labels[k], /^[A-Z0-9 ]{1,8}$/, `yard ${k}`);
}

/** Strings from the fixtures that must never reach the public view. */
export const PRIVATE_MARKERS = ['fixture-user', 'build-host-77', 'example.com', 'vitest', 'C:/', 'secret-notes', 'compose.yaml', 'team-job.js', 'hold.sh', 'booth.sh', 'pnpm', 'docker compose', 'verify:full failed'];
