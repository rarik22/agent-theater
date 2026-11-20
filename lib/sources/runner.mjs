// Optional runner files: lanes, a merge queue, lock and test-booth owners, a progress file, and git
// merges into a branch. Each reader returns { ok, ... }; a missing or unreadable source gives ok: false
// and empty data, never invented values. Shapes are documented in docs/SOURCES.md. Read-only.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseOwner } from '../classify.mjs';
import { GENERIC_RULES, jobFromSlug } from '../rules.mjs';
import { readJson } from './files.mjs';

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

/** queue file: { entries: [{ slug, id, lane|phase, status, title, kind, bounces, readyAt, mergedAt, updatedAt }], batches: [...] }. */
export function readQueue(path) {
  const { ok, data } = readJson(path);
  if (!ok || !data || typeof data !== 'object') return { ok: false, entries: [], batches: [] };
  const entries = (Array.isArray(data.entries) ? data.entries : []).filter((e) => e && typeof e.slug === 'string');
  const batches = (Array.isArray(data.batches) ? data.batches : []).filter((b) => b && Number.isFinite(Number(b.n)));
  return { ok: true, entries, batches };
}

/** locks folder: <merge>/owner, <exclusive>/owner and <slotPrefix>N/owner, each "holder unixSeconds". */
export function readLocks(dir, slotCount, rules = GENERIC_RULES) {
  if (!dir || !existsSync(dir)) return { ok: false, merge: null, exclusive: null, slots: [] };
  const read = (name) => {
    try {
      return parseOwner(readFileSync(join(dir, name, 'owner'), 'utf8'));
    } catch {
      return null;
    }
  };
  const names = rules.locks;
  const slots = [];
  for (let n = 1; n <= slotCount; n += 1) slots.push({ n, owner: read(`${names.slotPrefix}${n}`) });
  return { ok: true, merge: read(names.merge), exclusive: read(names.exclusive), slots };
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
