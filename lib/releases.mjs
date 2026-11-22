// Release trains: what the merge machine shows when a team's runner merges in releases instead of
// batches, from its queue and lock files (the adapter: their conventions are rules data, see
// rules.mjs). The workflows alone already tell what the machine does (flow.mjs); these files add the
// releases' versions, counts, failures and history. A queued job is integrated into the open release branch; a release that holds its entries is
// closed and checked once; a passing release is merged into the target branch, tagged and pushed; a
// failing one is fixed on fixes/<version>. Releases run strictly in version order, so the machine works
// on the oldest unfinished one. Pure: everything comes from the queue file (sources/runner.mjs) and the
// lock owners.
import { redact } from './classify.mjs';
import { ACTIVITY_RANK, isActive } from './flow.mjs';
import { GENERIC_RULES, fill, jobFromSlug, ownerInfo } from './rules.mjs';
import { VERSION_RE } from './sources/runner.mjs';

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// ---------------------------------------------------------------- entries

/**
 * An entry's history as status changes, oldest first: [{ at, status, release }]. `history` is the
 * compiled rules.queue.history (the wording of the team's runner; DEFAULT_HISTORY in rules.mjs).
 */
export function historyOf(entry, history = GENERIC_RULES.queue.history) {
  const out = [];
  for (const line of Array.isArray(entry?.history) ? entry.history : []) {
    const m = /^(\S+)\s+(.+)$/.exec(String(line));
    const at = m ? Date.parse(m[1]) : NaN;
    if (!Number.isFinite(at)) continue;
    for (const h of history) {
      const hit = h.re.exec(m[2]);
      if (!hit) continue;
      const change = { status: h.status };
      const release = h.release ? fill(h.release, hit) : null;
      if (release && VERSION_RE.test(release)) change.release = release;
      out.push({ at, ...change });
      break;
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * A batch-era entry's status at a past time, from readyAt, its bounces, the batches and mergedAt:
 * ready, batched, bounced, held, merged or dropped (null before it was queued).
 */
export function legacyStatusAt(entry, batches, t) {
  const readyAt = Date.parse(entry.readyAt);
  if (!Number.isFinite(readyAt) || readyAt > t) return null;
  const mergedAt = Date.parse(entry.mergedAt);
  if (Number.isFinite(mergedAt) && mergedAt <= t) return 'merged';
  const updatedAt = Date.parse(entry.updatedAt);
  if (entry.status === 'dropped' && Number.isFinite(updatedAt) && updatedAt <= t) return 'dropped';
  const bouncesOf = Array.isArray(entry.bounces) ? entry.bounces : Array.isArray(entry.legacy?.bounces) ? entry.legacy.bounces : [];
  for (const b of batches) {
    const start = Date.parse(b.startedAt);
    const end = Date.parse(b.finishedAt);
    if (!(Number.isFinite(start) && start <= t && (!Number.isFinite(end) || t < end))) continue;
    if (Array.isArray(b.slugs) && b.slugs.includes(entry.slug)) {
      const bounced = bouncesOf.some((x) => Number(x.batch) === Number(b.n) && Date.parse(x.at) <= t);
      if (!bounced && !(Number.isFinite(mergedAt) && mergedAt <= t)) return 'batched';
    }
  }
  const bounces = bouncesOf.map((x) => Date.parse(x?.at)).filter((x) => Number.isFinite(x) && x <= t);
  if (bounces.length) {
    const lastBounce = Math.max(...bounces);
    // After a bounce the entry is back in its lane until it is marked ready again (updatedAt moves on).
    if (!(Number.isFinite(updatedAt) && updatedAt > lastBounce && updatedAt <= t)) return 'bounced';
  }
  if (entry.status === 'held' && Number.isFinite(updatedAt) && updatedAt <= t) return 'held';
  return 'ready';
}

/**
 * An entry's status (and release) at a past time: from its history once it has one (schema 2: queued,
 * integrated, moved-out, merged, dropped), else by the batch rules over the batches (entries merged
 * before the switch, and the time before a migrated entry's first release-train step). Null before it was queued.
 */
export function entryStateAt(entry, batches, t, history = GENERIC_RULES.queue.history) {
  const readyAt = Date.parse(entry.readyAt);
  const steps = historyOf(entry, history).filter((h) => h.at <= t);
  if (!steps.length && !(Number.isFinite(readyAt) && readyAt <= t)) return null;
  const mergedAt = Date.parse(entry.mergedAt);
  if (steps.length) {
    const last = steps[steps.length - 1];
    if (last.status !== 'merged' && entry.status === 'merged' && Number.isFinite(mergedAt) && mergedAt <= t) return { status: 'merged', release: entry.release ?? last.release ?? null };
    return { status: last.status, release: last.release ?? null };
  }
  const status = legacyStatusAt(entry, batches, t);
  return status ? { status, release: null } : null;
}

// ---------------------------------------------------------------- releases

/**
 * What the runner does with a release now, from its record and the lock owners (most specific first).
 * Holders are read by rules.owners or their generic form (ownerInfo: merger-…, fixer-0.1.2, and a
 * release's check as release-0.1.2):
 *   merging      the target branch's merge lock is held, for the oldest unfinished release;
 *   checking     a check run is running, or the release's check holds the exclusive hold or every booth;
 *   integrating  a merger holds the release's lock;
 *   fixing       the release is fixing, or a fixer holds its lock (or any lock as that release's fixer);
 * else its status: open (taking entries), verifying (its check is due), passed.
 */
export function releaseActivity(rel, locks = null, { oldest = false, rules = GENERIC_RULES } = {}) {
  if (rel.status === 'passed') return 'passed';
  const v = rel.version.toLowerCase();
  const who = (owner) => (owner?.holder ? ownerInfo(owner.holder, rules) : null);
  const slots = Array.isArray(locks?.slots) ? locks.slots : [];
  if (oldest && locks?.merge) return 'merging';
  if (rel.runs.some((r) => r.result === 'running')) return 'checking';
  const checks = (owner) => {
    const w = who(owner);
    return w?.kind === 'check' && String(w.version || '').toLowerCase() === v;
  };
  if (checks(locks?.exclusive) || (slots.length > 0 && slots.every((x) => checks(x.owner)))) return 'checking';
  const lock = who((Array.isArray(locks?.releases) ? locks.releases : []).find((l) => l.version.toLowerCase() === v)?.owner);
  if (lock?.kind === 'merger') return 'integrating';
  if (rel.status === 'fixing' || lock?.kind === 'fixer') return 'fixing';
  if (Object.values(locks?.byName || {}).some((o) => {
    const w = who(o);
    return w?.kind === 'fixer' && String(w.version || '').toLowerCase() === v;
  })) return 'fixing';
  return rel.status === 'verifying' ? 'verifying' : rel.status === 'open' ? 'open' : rel.status;
}

/** One release in the public schema; reasons (free text) only in the private view, redacted. */
export function releaseView(rel, activity, { publicMode = true } = {}) {
  const out = new Set(rel.movedOut);
  const jobs = rel.entries.filter((e) => e.type === 'entry' && !out.has(e.slug));
  const last = rel.runs[rel.runs.length - 1] || null;
  const failure = (f) => (f ? { stage: f.stage, at: iso(f.at), entries: f.entries, ...(publicMode || !f.reason ? {} : { reason: redact(f.reason, 160) }) } : null);
  return {
    version: rel.version,
    status: rel.status,
    activity,
    gate: rel.gate,
    capacity: rel.capacity,
    counted: jobs.filter((e) => e.counted).length,
    entries: jobs.map((e) => e.slug),
    fixes: rel.entries.filter((e) => e.type === 'release-fix').length,
    fixRounds: rel.fixRounds,
    failures: rel.failures.length,
    openFailure: failure(rel.openFailure),
    checks: rel.runs.length,
    check: last ? { n: last.n, result: last.result, startedAt: iso(last.startedAt), finishedAt: iso(last.finishedAt), ...(publicMode || !last.reason ? {} : { reason: redact(last.reason, 160) }) } : null,
    openedAt: iso(rel.openedAt),
    closedAt: iso(rel.closedAt),
    passedAt: iso(rel.passedAt),
    lastIntegratedAt: iso(Math.max(...rel.entries.map((e) => e.at).filter(Number.isFinite), -Infinity)),
    tag: rel.tag,
  };
}

/**
 * The machine's release from the workflows alone (no queue file): the live merge run's version, if it
 * names one, and what its phase does. Counts are unknown (null).
 */
export function flowRelease(flow) {
  return {
    version: flow.version || null,
    status: 'running',
    activity: flow.activity,
    gate: false,
    capacity: null,
    counted: null,
    entries: [],
    fixes: 0,
    fixRounds: 0,
    failures: 0,
    openFailure: null,
    checks: 0,
    check: null,
    openedAt: null,
    closedAt: null,
    passedAt: null,
    lastIntegratedAt: null,
    since: iso(flow.since),
    phase: flow.phase || null,
    tag: null,
  };
}

/**
 * Which unfinished release a merge run's phase is about: the one it names; else the one that phase can
 * act on: an integration goes into the open release, a fix to the release that is fixing (or has an
 * open failure), a check or a merge to the oldest unfinished one.
 */
export function flowTarget(flow, unfinished) {
  if (!unfinished.length) return null;
  if (flow.version) return unfinished.find((r) => r.version.toLowerCase() === flow.version.toLowerCase()) || null;
  if (flow.activity === 'integrating') return unfinished.filter((r) => r.status === 'open').at(-1) || unfinished.at(-1);
  if (flow.activity === 'fixing') return unfinished.find((r) => r.status === 'fixing' || r.openFailure) || unfinished[0];
  return unfinished[0];
}

/** The more specific of two activities: a live one (ACTIVITY_RANK) beats a status. */
function sharper(a, b) {
  if (!isActive(b)) return a;
  if (!isActive(a)) return b;
  return ACTIVITY_RANK[b] < ACTIVITY_RANK[a] ? b : a;
}

/**
 * The releases the stage shows and the one on the merge machine: every unfinished release and those
 * that passed in the last `recentMs`, in version order. The machine works on the oldest unfinished one
 * (releases reach the target branch in order), else on the one that passed last while it is recent.
 * `flow` (flow.machineFlow: the live merge workflow's phase) sharpens the activity of the release it
 * names, or of the machine's release when it names none. Without releases (no queue file) the flow
 * alone makes the machine's release.
 */
export function releasesView(releases, locks, now, { publicMode = true, recentMs = 10 * 60_000, flow = null, rules = GENERIC_RULES } = {}) {
  const list = Array.isArray(releases) ? releases : [];
  if (!list.length) {
    if (!flow) return { releases: [], release: null };
    const only = flowRelease(flow);
    return { releases: [only], release: only };
  }
  const unfinished = list.filter((r) => r.status !== 'passed');
  const oldest = unfinished[0] || null;
  const shown = list.filter((r) => r.status !== 'passed' || (Number.isFinite(r.passedAt) && now - r.passedAt <= recentMs && r.passedAt <= now));
  const target = flow ? flowTarget(flow, unfinished) : null;
  const views = shown.map((r) => {
    let activity = releaseActivity(r, locks, { oldest: r === oldest, rules });
    if (target && r === target) activity = sharper(activity, flow.activity);
    return releaseView(r, activity, { publicMode });
  });
  const machine = oldest ? views.find((v) => v.version === oldest.version) : views.filter((v) => v.status === 'passed').at(-1) || null;
  return { releases: views, release: machine || null };
}

/**
 * A release as it stood at a past time t (null before it opened): the integrations, checks and
 * failures made by t, and its status then. A check that finished after t is still running at t; after
 * a failed check the release is fixing until the next one starts. Fix rounds count the fix merges made
 * by t (the per-entry round counts carry no times). The open failure is known for now only, so it
 * shows from the time it was recorded.
 */
export function releaseAt(rel, t) {
  const opened = Number.isFinite(rel.openedAt) ? rel.openedAt : rel.entries.find((e) => Number.isFinite(e.at))?.at;
  if (!(Number.isFinite(opened) && opened <= t)) return null;
  const entries = rel.entries.filter((e) => Number.isFinite(e.at) && e.at <= t);
  const runs = rel.runs.filter((r) => Number.isFinite(r.startedAt) && r.startedAt <= t).map((r) => (Number.isFinite(r.finishedAt) && r.finishedAt <= t ? r : { ...r, result: 'running', finishedAt: null, seconds: null }));
  let status = 'open';
  if (Number.isFinite(rel.passedAt) && rel.passedAt <= t) status = 'passed';
  else if (Number.isFinite(rel.closedAt) && rel.closedAt <= t) {
    const last = runs[runs.length - 1];
    status = last && !['running', 'passed', 'flake'].includes(last.result) ? 'fixing' : 'verifying';
  }
  return {
    ...rel,
    status,
    entries,
    runs,
    failures: rel.failures.filter((f) => Number.isFinite(f.at) && f.at <= t),
    openFailure: rel.openFailure && Number.isFinite(rel.openFailure.at) && rel.openFailure.at <= t && status !== 'passed' ? rel.openFailure : null,
    fixRounds: entries.filter((e) => e.type === 'release-fix').length,
    movedOut: rel.movedOut,
    passedAt: status === 'passed' ? rel.passedAt : null,
    closedAt: Number.isFinite(rel.closedAt) && rel.closedAt <= t ? rel.closedAt : null,
  };
}

/** The releases at a past time t, as releasesView sees them (no lock owners are known for the past). */
export function releasesViewAt(releases, t, { publicMode = true, recentMs = 10 * 60_000, flow = null, rules = GENERIC_RULES } = {}) {
  const past = (Array.isArray(releases) ? releases : []).map((r) => releaseAt(r, t)).filter(Boolean);
  return releasesView(past, null, t, { publicMode, recentMs, flow, rules });
}

// ---------------------------------------------------------------- merges into the target branch

const RELEASE_BRANCH = /^release\/(.+)$/;

/**
 * Git shows one merge per release ("Merge branch 'release/<v>' into develop"). Expand each into the
 * jobs that release carried (its integrated entries, less those moved out), each with the merge's
 * time and commit, plus the release merge itself (`release` set, no job), so job counters, merged events
 * and the parcels see every job that reached the branch. Other merges pass through unchanged.
 */
export function expandReleaseMerges(merges, releases, rules) {
  const byVersion = new Map((Array.isArray(releases) ? releases : []).map((r) => [r.version.toLowerCase(), r]));
  const out = [];
  for (const m of Array.isArray(merges) ? merges : []) {
    const hit = RELEASE_BRANCH.exec(String(m.slug || ''));
    if (!hit || !VERSION_RE.test(hit[1])) {
      out.push(m);
      continue;
    }
    const version = hit[1];
    out.push({ ...m, job: null, release: version, slug: `release/${version}` });
    const rel = byVersion.get(version.toLowerCase());
    if (!rel) continue;
    const gone = new Set(rel.movedOut);
    const seen = new Set();
    for (const e of rel.entries) {
      if (e.type !== 'entry' || gone.has(e.slug) || seen.has(e.slug)) continue;
      seen.add(e.slug);
      out.push({ sha: m.sha, at: m.at, slug: e.slug, job: jobFromSlug(e.slug, rules), release: version, viaRelease: true });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------- the merger between runs

/** The id of the merger the stage keeps at the machine between the runner's merger runs. */
export const IDLE_MERGER_ID = 'release-merger';

/**
 * What the merger does or waits for, in public words: from the machine's release, the next release
 * (taking entries while the machine's one is checked or fixed) and the jobs waiting for a release.
 * Null when there is no release work at all (nothing unfinished and nothing queued).
 */
export function mergerDuty(machine, next, queued) {
  // short enough for a speech bubble; the machine's plate names the release
  const unfinished = machine && machine.status !== 'passed';
  // `since`: when this duty began (the bubble shows how long in public mode); null means now
  if (!unfinished) return queued > 0 ? { kind: 'wait', text: 'waiting for a release', since: machine?.passedAt ?? null } : null;
  switch (machine.activity) {
    case 'merging':
      return { kind: 'run', text: 'merging the release', since: null };
    case 'checking':
      return { kind: 'test', text: 'checking the release', background: true, since: machine.check?.result === 'running' ? machine.check.startedAt : null };
    case 'integrating':
      return { kind: 'run', text: 'integrating jobs', since: null };
    case 'working':
      return { kind: 'run', text: 'working on the release', since: null };
    default:
      break;
  }
  if (next && next.activity === 'integrating') return { kind: 'run', text: 'integrating jobs', since: null };
  if (machine.activity === 'fixing' || machine.openFailure) return { kind: 'wait', text: 'waiting for the fix', since: machine.openFailure?.at ?? machine.check?.finishedAt ?? machine.closedAt };
  if (machine.activity === 'verifying') return { kind: 'wait', text: 'waiting for the check', since: machine.closedAt };
  if (machine.counted === null || machine.capacity === null) return { kind: 'wait', text: 'waiting for the next step', since: null };
  if (machine.counted >= machine.capacity) return { kind: 'wait', text: 'waiting to close it', since: machine.lastIntegratedAt };
  return { kind: 'wait', text: `waiting for jobs (${machine.counted}/${machine.capacity})`, since: machine.lastIntegratedAt ?? machine.openedAt };
}

/**
 * The merger the stage keeps at the machine when release work is pending and no merger run is live:
 * idle, not gone. Null when there is no release work.
 */
export function idleMerger(queue, { atMs }) {
  const machine = queue.release || null;
  const next = machine ? (queue.releases || []).find((r) => r.status !== 'passed' && r.version !== machine.version) || null : null;
  const queued = (queue.entries || []).filter((e) => e.status === 'queued').length;
  const duty = mergerDuty(machine, next, queued);
  if (!duty) return null;
  const v = machine && machine.status !== 'passed' ? machine.version : null;
  const began = Date.parse(duty.since);
  const since = iso(Number.isFinite(began) && began <= atMs ? began : atMs);
  const action = { kind: duty.kind, text: duty.text, since };
  if (duty.background) action.background = true;
  return {
    id: IDLE_MERGER_ID,
    role: 'merger',
    job: v ? `RELEASE-${v}` : 'RELEASE',
    lane: null,
    station: null,
    stationTag: null,
    place: 'merge',
    tag: v ? `REL-${v}`.slice(0, 16) : 'RELEASE',
    title: v ? `Release ${v}` : 'Release',
    label: 'RELEASE',
    since,
    activeAt: iso(atMs),
    action,
    say: duty.text,
    idle: true,
  };
}

/**
 * The idle merger's log: the releases' timeline, oldest first (opened, each integration and fix merge,
 * failures, check runs, closed, passed). Public mode: steps in generic words with job ids; the private
 * view adds the failure and check reasons, redacted.
 */
export function releaseLog(releases, queueEntries, { publicMode = true, max = 300 } = {}) {
  const names = new Map((Array.isArray(queueEntries) ? queueEntries : []).map((e) => [String(e.slug).toLowerCase(), typeof e.id === 'string' && /^[A-Z0-9][A-Z0-9-]{0,40}$/.test(e.id) ? e.id : null]));
  const rows = [];
  const add = (at, text, reason = null, status = null) => {
    if (!Number.isFinite(at)) return;
    rows.push({ at, text, reason: publicMode ? null : reason ? redact(reason, 300) : null, status });
  };
  for (const r of Array.isArray(releases) ? releases : []) {
    const v = r.version;
    add(r.openedAt, `release ${v} opened`);
    for (const e of r.entries) {
      if (e.type === 'release-fix') add(e.at, `a fix merged into release ${v}`);
      else add(e.at, `${names.get(e.slug) || e.id || 'a job'} integrated into release ${v}`);
    }
    // a failed check is told by its run's line; other failures (integration) get their own
    const ranOut = (f) => r.runs.some((run) => Number.isFinite(run.finishedAt) && Math.abs(run.finishedAt - f.at) <= 60_000);
    for (const f of r.failures) if (!(f.stage === 'check' && ranOut(f))) add(f.at, `release ${v}: the ${f.stage} step failed`, f.reason, 'failed');
    for (const run of r.runs) {
      add(run.startedAt, `check ${run.n ?? ''} of release ${v} started`.replace('  ', ' '));
      if (run.result !== 'running') add(run.finishedAt, `check ${run.n ?? ''} of release ${v} ${run.result === 'flake' ? 'hit a flake' : run.result}`.replace('  ', ' '), run.reason, run.result);
    }
    add(r.closedAt, `release ${v} closed`);
    add(r.passedAt, `release ${v} passed${r.tag ? ` and was tagged ${r.tag}` : ''}`, null, 'passed');
  }
  rows.sort((a, b) => a.at - b.at);
  const kept = rows.slice(-max);
  const omitted = rows.length - kept.length;
  if (publicMode) return { entries: kept.map((x) => ({ t: iso(x.at), kind: 'release', text: x.text, count: 1, until: iso(x.at) })), omitted };
  return { entries: kept.map((x) => ({ t: iso(x.at), type: 'event', kind: 'release', status: x.status || undefined, text: x.reason ? `${x.text}: ${x.reason}` : x.text })), omitted };
}
