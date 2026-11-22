// Optional runner files: lanes, a merge queue, lock and test-booth owners, a progress file, and git
// merges into a branch. Each reader returns { ok, ... }; a missing or unreadable source gives ok: false
// and empty data, never invented values. Shapes are documented in docs/SOURCES.md. Read-only.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseOwner } from '../classify.mjs';
import { GENERIC_RULES, jobFromSlug } from '../rules.mjs';
import { readJson } from './files.mjs';

/** A release version: 0.1.2, 1.0.0-rc.1. */
export const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9.]{1,12})?$/i;

/** Order two versions (numeric parts, then a pre-release tag before the release itself). */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/);
  const pb = String(b).split(/[.-]/);
  for (let i = 0; i < 3; i += 1) {
    const d = Number(pa[i] || 0) - Number(pb[i] || 0);
    if (d) return d;
  }
  const ta = pa.slice(3).join('.');
  const tb = pb.slice(3).join('.');
  if (ta === tb) return 0;
  if (!ta) return 1;
  if (!tb) return -1;
  return ta < tb ? -1 : 1;
}

/** lanes file: { lanes: { <laneId>: { job } }, waiting: { <laneId>: ... } }. */
export function readLanes(path, rules = GENERIC_RULES) {
  const { ok, data } = readJson(path);
  if (!ok || !data || typeof data !== 'object') return { ok: false, lanes: {}, waiting: [] };
  const lanes = {};
  for (const [id, lane] of Object.entries(data.lanes || {})) {
    if (!rules.laneId.test(id)) continue;
    lanes[id] = { job: jobFromSlug(lane?.job, rules) };
  }
  const waiting = Object.keys(data.waiting || {}).filter((id) => rules.laneId.test(id));
  return { ok: true, lanes, waiting };
}

const ms = (v) => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const list = (v) => (Array.isArray(v) ? v : []);
const SLUG_RE = /^[a-z0-9][a-z0-9._/#-]{0,80}$/i;
const word = (v, fallback = null) => (typeof v === 'string' && /^[a-z][a-z-]{0,23}$/i.test(v) ? v.toLowerCase() : fallback);
const text = (v) => (typeof v === 'string' && v.trim() ? v : null);
const slugs = (v) => list(v).map((s) => (typeof s === 'string' ? s : s?.slug)).filter((s) => typeof s === 'string' && SLUG_RE.test(s)).map((s) => s.toLowerCase());

const RUN_RESULTS = ['running', 'passed', 'failed', 'flake', 'interrupted'];

function failureOf(f) {
  if (!f || typeof f !== 'object') return null;
  return { stage: word(f.stage, 'check'), at: ms(f.at), entries: slugs(f.entries), reason: text(f.reason) };
}

/**
 * One release of a release-train queue, checked and trimmed to what the stage needs. Its
 * entries are the integrations in order: `entry` (a queued job) or `release-fix` (a merge of the
 * fixer's branch, never counted). Null for something that is not a release.
 */
export function normalizeRelease(r) {
  if (!r || typeof r !== 'object' || !VERSION_RE.test(String(r.version ?? ''))) return null;
  const entries = list(r.entries)
    .filter((e) => e && typeof e.slug === 'string' && SLUG_RE.test(e.slug))
    .map((e) => ({ type: e.type === 'release-fix' ? 'release-fix' : 'entry', slug: e.slug.toLowerCase(), id: typeof e.id === 'string' ? e.id : null, kind: word(e.kind), counted: e.type !== 'release-fix' && e.counted === true, at: ms(e.at) }));
  const runs = list(r.runs)
    .filter((x) => x && typeof x === 'object')
    .map((x) => ({ n: Number.isInteger(x.n) ? x.n : null, mode: word(x.mode, 'release'), result: RUN_RESULTS.includes(x.result) ? x.result : ms(x.finishedAt) ? 'failed' : 'running', startedAt: ms(x.startedAt), finishedAt: ms(x.finishedAt), seconds: Number.isFinite(Number(x.seconds)) && Number(x.seconds) > 0 ? Number(x.seconds) : null, reason: text(x.reason) }));
  const rounds = r.fixRounds && typeof r.fixRounds === 'object' && !Array.isArray(r.fixRounds) ? Object.values(r.fixRounds).map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
  const capacity = Number.isInteger(r.capacity) && r.capacity > 0 ? r.capacity : 10;
  return {
    version: String(r.version),
    status: word(r.status, 'open'),
    gate: Boolean(r.gate),
    capacity,
    reserved: Array.isArray(r.reserve) ? r.reserve.length : null,
    openedAt: ms(r.openedAt),
    closedAt: ms(r.closedAt),
    passedAt: ms(r.passedAt),
    entries,
    runs,
    failures: list(r.failures).map(failureOf).filter(Boolean),
    openFailure: failureOf(r.openFailure),
    fixRounds: rounds.reduce((a, n) => a + n, 0),
    movedOut: slugs(r.movedOut),
    tag: typeof r.tag === 'string' && /^v?\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9.]{1,12})?$/i.test(r.tag) ? r.tag : null,
  };
}

/**
 * The queue file's shape, both formats: merge batches (schema 1), or releases (schema 2) with the old
 * batches kept. A preset's rules.queue.status / releaseStatus map the runner's own status names to the
 * theater's (queued, integrated, merged, moved-out, dropped; open, verifying, fixing, passed).
 */
export function parseQueue(data, rules = GENERIC_RULES) {
  const entryStatus = rules.queue?.status || {};
  const releaseStatus = rules.queue?.releaseStatus || {};
  const entries = list(data.entries).filter((e) => e && typeof e.slug === 'string').map((e) => (typeof e.status === 'string' && entryStatus[e.status] ? { ...e, status: entryStatus[e.status] } : e));
  const releases = list(data.releases).map((r) => (r && typeof r.status === 'string' && releaseStatus[r.status] ? { ...r, status: releaseStatus[r.status] } : r)).map(normalizeRelease).filter(Boolean).sort((a, b) => compareVersions(a.version, b.version));
  // schema 2 keeps the batch history as legacyBatches; replay plays both
  const batches = list(Array.isArray(data.batches) ? data.batches : data.legacyBatches).filter((b) => b && Number.isFinite(Number(b.n)));
  const schema = Number.isInteger(data.schema) ? data.schema : Array.isArray(data.releases) ? 2 : 1;
  return { ok: true, schema, entries, batches, releases };
}

// The runner rewrites the queue file while the theater reads it; a read that catches it half-written
// keeps the last good copy for a while instead of emptying the belt.
const lastGoodQueue = new Map();
const QUEUE_KEEP_MS = 120_000;

/**
 * queue file, either format (docs/SOURCES.md):
 *   schema 1: { entries: [{ slug, id, lane|phase, status, title, kind, bounces, readyAt, mergedAt, updatedAt }], batches: [...] }
 *   schema 2: { schema: 2, entries: [{ ..., status, release, integratedAt, history }], releases: [...], legacyBatches: [...] }
 */
export function readQueue(path, rules = GENERIC_RULES) {
  const { ok, data } = readJson(path);
  if (ok && data && typeof data === 'object' && !Array.isArray(data)) {
    const queue = parseQueue(data, rules);
    if (path) lastGoodQueue.set(path, { at: Date.now(), queue });
    if (lastGoodQueue.size > 20) lastGoodQueue.delete(lastGoodQueue.keys().next().value);
    return queue;
  }
  const kept = path ? lastGoodQueue.get(path) : null;
  if (kept && Date.now() - kept.at <= QUEUE_KEEP_MS && existsSync(path)) return { ...kept.queue, stale: true };
  return { ok: false, schema: null, entries: [], batches: [], releases: [] };
}

/**
 * locks folder: <merge>/owner, <exclusive>/owner, <slotPrefix>N/owner and <release>X.Y.Z/owner (the
 * release-train locks), each "holder unixSeconds". `byName` has every owner read, by lock name.
 */
export function readLocks(dir, slotCount, rules = GENERIC_RULES) {
  if (!dir || !existsSync(dir)) return { ok: false, merge: null, exclusive: null, slots: [], releases: [], byName: {} };
  const byName = {};
  const read = (name) => {
    let owner = null;
    try {
      owner = parseOwner(readFileSync(join(dir, name, 'owner'), 'utf8'));
    } catch {
      owner = null;
    }
    if (owner) byName[name] = owner;
    return owner;
  };
  const names = rules.locks;
  const slots = [];
  for (let n = 1; n <= slotCount; n += 1) slots.push({ n, owner: read(`${names.slotPrefix}${n}`) });
  const releases = [];
  if (names.release) {
    let found = [];
    try {
      found = readdirSync(dir);
    } catch {
      found = [];
    }
    for (const name of found) {
      if (!name.startsWith(names.release)) continue;
      const version = name.slice(names.release.length);
      if (!VERSION_RE.test(version)) continue;
      const owner = read(name);
      if (owner) releases.push({ version, owner });
    }
    releases.sort((a, b) => compareVersions(a.version, b.version));
  }
  return { ok: true, merge: read(names.merge), exclusive: read(names.exclusive), slots, releases, byName };
}

/**
 * progress file: { jobs: [{ id, lane|phase, title, status, kind }], totals: { jobs, done, features },
 * lanes|phases: { <laneId>: title }, base: <commit> } (base: the commit the snapshot was taken at; jobs
 * merged after it are counted from git).
 */
export function readProgress(path, rules = GENERIC_RULES) {
  const { ok, data } = readJson(path);
  if (!ok || !data || !Array.isArray(data.jobs)) return { ok: false, totals: null, laneTitles: {}, jobs: new Map(), base: null };
  const jobs = new Map();
  for (const j of data.jobs) {
    if (!j || typeof j.id !== 'string') continue;
    const lane = typeof (j.lane ?? j.phase) === 'string' && rules.laneId.test(j.lane ?? j.phase) ? String(j.lane ?? j.phase) : null;
    jobs.set(j.id.toUpperCase(), { id: j.id.toUpperCase(), lane, title: String(j.title || ''), status: j.status || 'todo', kind: j.kind || null });
  }
  const total = Number(data.totals?.jobs);
  const done = Number(data.totals?.done);
  const featureJobs = [...jobs.values()].filter((j) => j.kind === 'feature');
  const features = Number(data.totals?.features);
  const titles = data.lanes && typeof data.lanes === 'object' && !Array.isArray(data.lanes) ? data.lanes : data.phases && typeof data.phases === 'object' ? data.phases : {};
  const base = data.base ?? data.develop;
  return {
    ok: true,
    totals: {
      total: Number.isFinite(total) ? total : jobs.size,
      done: Number.isFinite(done) ? done : [...jobs.values()].filter((j) => j.status === 'done').length,
      // tracked features: the jobs of kind "feature"
      features: Number.isFinite(features) ? features : featureJobs.length,
      featuresDone: featureJobs.filter((j) => j.status === 'done').length,
    },
    laneTitles: Object.fromEntries(Object.entries(titles).filter(([id, t]) => rules.laneId.test(id) && typeof t === 'string')),
    jobs,
    base: typeof base === 'string' && /^[0-9a-f]{7,40}$/i.test(base) ? base : null,
  };
}

// ---------------------------------------------------------------- git (merges into the branch)

/** Default git runner: `git -C <repo> ...args` with a timeout, output as text. */
export function makeGitExec(repo) {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    });
}

const MERGE_RE = /^Merge branch '([^']+)' into (\S+)/;

/** Parse `git log --format=%H%x09%ct%x09%s` output into merges of branches into `branch`. */
export function parseMerges(text, branch = 'main', rules = GENERIC_RULES) {
  const merges = [];
  for (const line of String(text).split('\n')) {
    const [sha, ct, ...rest] = line.split('\t');
    const subject = rest.join('\t');
    if (!sha || !ct) continue;
    const m = MERGE_RE.exec(subject);
    if (!m || m[2] !== branch) continue;
    const slug = (rules.slugPrefix ? m[1].replace(rules.slugPrefix, '') : m[1]).toLowerCase();
    merges.push({ sha: sha.slice(0, 12), at: Number(ct) * 1000, slug, job: jobFromSlug(slug, rules) });
  }
  return merges.sort((a, b) => a.at - b.at);
}

export class GitReader {
  constructor(cfg, exec, rules = GENERIC_RULES) {
    this.cfg = cfg;
    this.rules = rules;
    this.exec = exec || (cfg.sources.repo ? makeGitExec(cfg.sources.repo) : null);
    this.cache = new Map();
  }

  async #run(key, args, ttlMs) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.time < ttlMs) return hit.value;
    let value;
    try {
      value = { ok: true, text: await this.exec(args) };
    } catch {
      value = { ok: false, text: '' };
    }
    this.cache.set(key, { time: Date.now(), value });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
    return value;
  }

  /** Merges into the branch (first parent) since `sinceMs`. */
  async merges(sinceMs) {
    if (!this.exec) return { ok: false, merges: [] };
    const branch = this.cfg.sources.branch;
    const since = new Date(Math.floor(sinceMs / 60000) * 60000).toISOString();
    const r = await this.#run(`merges ${since}`, ['log', branch, '--first-parent', '--merges', `--since=${since}`, '--format=%H%x09%ct%x09%s', '--'], 10000);
    return { ok: r.ok, merges: r.ok ? parseMerges(r.text, branch, this.rules) : [] };
  }

  /** Merges into the branch after commit `sha` (jobs merged since the progress snapshot). */
  async mergesAfter(sha) {
    if (!this.exec || !sha || !/^[0-9a-f]{7,40}$/i.test(sha)) return { ok: false, merges: [] };
    const branch = this.cfg.sources.branch;
    const r = await this.#run(`after ${sha}`, ['log', `${sha}..${branch}`, '--first-parent', '--merges', '--format=%H%x09%ct%x09%s', '--'], 10000);
    return { ok: r.ok, merges: r.ok ? parseMerges(r.text, branch, this.rules) : [] };
  }
}
