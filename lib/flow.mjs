// The flow, worked out from the workflows themselves: which workflows build things (each run a lane,
// its stations the workflow's own phases) and which take finished work to the target branch (their runs
// drive the merge machine instead of taking a lane), what the machine is doing now (the live merge
// run's phase), and which release it works on (a version in the run's subject or its agents' labels).
// No runner files are needed; a team's queue and lock files only add detail (releases.mjs). Pure.

// a phase that takes work to the target branch, and one that builds it
const MERGE_WORDS = /\b(integrat\w*|merg\w*|releas\w*|ship\w*|land\w*|deploy\w*|publish\w*|promot\w*|tag)\b/i;
const BUILD_WORDS = /\b(implement\w*|code|coding|build\w*|develop\w*|writ\w*|draft\w*|refactor\w*|setup|set up|scaffold\w*|design\w*|migrat\w*)\b/i;
const VERSION_IN_TEXT = /\bv?(\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9.]{1,12})?)\b/i;

/** Whether a name matches one of a config's names or /regex/ strings. */
function named(list, name) {
  if (!Array.isArray(list) || !name) return false;
  return list.some((p) => {
    const s = String(p);
    const re = /^\/(.+)\/([a-z]*)$/.exec(s);
    if (!re) return s.toLowerCase() === name.toLowerCase();
    try {
      return new RegExp(re[1], re[2] || 'i').test(name);
    } catch {
      return false;
    }
  });
}

/**
 * What a workflow does, from its declared phases: "merge" when its phases take work to the branch
 * (integrate, merge, release, ship, deploy, publish, tag) and none builds anything (implement, code,
 * build, develop, write, draft, set up); else "job". `pipeline.mergeWorkflows` / `pipeline.jobWorkflows`
 * (names or "/regex/") decide first. A run without known phases is judged by its workflow's name.
 */
export function workflowKind(run, pipeline = {}) {
  const name = String(run?.workflow || '');
  if (named(pipeline.mergeWorkflows, name)) return 'merge';
  if (named(pipeline.jobWorkflows, name)) return 'job';
  const phases = Array.isArray(run?.phases) ? run.phases : [];
  if (!phases.length) return /\b(release|merge|integrat\w*|deploy|ship)\b/i.test(name.replace(/[-_]/g, ' ')) ? 'merge' : 'job';
  const merges = phases.some((p) => MERGE_WORDS.test(p));
  const builds = phases.some((p) => BUILD_WORDS.test(p));
  return merges && !builds ? 'merge' : 'job';
}

/**
 * What the merge machine does during a merge workflow's phase: fixing (fix, repair; a review that
 * follows a fix phase), integrating, checking (verify, check, test, gate), merging (merge, release,
 * ship, deploy, publish, tag), else working.
 */
export function phaseActivity(title, phases = []) {
  const t = String(title || '').toLowerCase();
  if (/\b(fix\w*|repair\w*|patch\w*|debug\w*)\b/.test(t)) return 'fixing';
  if (/\breview\w*\b/.test(t)) {
    const i = phases.findIndex((p) => String(p).toLowerCase() === t);
    const before = (i > 0 ? phases.slice(0, i) : []).map((p) => String(p).toLowerCase());
    return before.some((p) => /\b(fix\w*|repair\w*)\b/.test(p)) ? 'fixing' : 'checking';
  }
  if (/\bintegrat\w*\b/.test(t)) return 'integrating';
  if (/\b(verif\w*|check\w*|test\w*|gate|qa|validat\w*|audit\w*)\b/.test(t)) return 'checking';
  if (MERGE_WORDS.test(t)) return 'merging';
  return 'working';
}

/** The role of an agent of a merge workflow, by what its phase does: the merger, a fixer or a reviewer. */
export function mergeRole(phase, phases = []) {
  const t = String(phase || '').toLowerCase();
  if (/\breview\w*\b/.test(t)) return 'reviewer';
  return phaseActivity(phase, phases) === 'fixing' ? 'fixer' : 'merger';
}

/** A release version a run is about: its subject, else the newest of its agents' labels that names one. */
export function versionOf(run, agents = []) {
  const hit = VERSION_IN_TEXT.exec(String(run?.subject || ''));
  if (hit) return hit[1];
  for (const a of [...agents].sort((x, y) => (y.startMs ?? 0) - (x.startMs ?? 0))) {
    const m = VERSION_IN_TEXT.exec(String(a.label || ''));
    if (m) return m[1];
  }
  return null;
}

/** How specific an activity is: a live merge beats a check, a check an integration, then a fix. */
export const ACTIVITY_RANK = { merging: 0, checking: 1, integrating: 2, fixing: 3, working: 4 };
export const isActive = (activity) => activity in ACTIVITY_RANK;

/**
 * What the merge machine does at time t from the merge workflows alone: of their runs alive at t, the
 * most specific one's phase (its newest agent's), as { activity, phase, version, since, workflow, run }.
 * Null when no merge run is alive. `runEnd(run)` gives when a run ended (or null while it runs).
 */
export function machineFlow(raw, t, { runEnd }) {
  let best = null;
  for (const run of raw.runs || []) {
    if (run.kind !== 'merge' || run.startMs === null || run.startMs > t) continue;
    const end = runEnd(run);
    if (end !== null && end !== undefined && end < t) continue;
    const agents = (raw.workflows?.agents || []).filter((a) => a.run === run.id && a.session === run.session && a.startMs !== null && a.startMs <= t).sort((a, b) => a.startMs - b.startMs);
    const latest = agents[agents.length - 1];
    const phase = latest?.wfPhase || run.phases[0] || '';
    const flow = { activity: phaseActivity(phase, run.phases), phase, version: versionOf(run, agents), since: latest?.startMs ?? run.startMs, workflow: run.workflow || null, run: run.id };
    if (!best || ACTIVITY_RANK[flow.activity] < ACTIVITY_RANK[best.activity]) best = flow;
  }
  return best;
}
