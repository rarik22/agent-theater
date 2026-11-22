// The configurable rules that tell the theater what a label, a command or a holder means. The built-in
// rules are generic (English keywords: setup, review, fix, prepare, verify, merge); a preset adds a
// team's own conventions (job ids, label forms, test-booth and lock commands) as data. See
// docs/PRESETS.md. Pure.

/** { "raw status": "theater status" } with string keys and values only. */
const plainMap = (m) => (m && typeof m === 'object' && !Array.isArray(m) ? Object.fromEntries(Object.entries(m).filter(([k, v]) => typeof k === 'string' && typeof v === 'string')) : {});

const rx = (source, flags = 'i') => {
  if (!source) return null;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
};

/** "$1-$2" with the groups of a match; a missing group is empty. */
export function fill(template, m) {
  return String(template ?? '').replace(/\$(\d)/g, (_, d) => (m && m[Number(d)] !== undefined ? m[Number(d)] : ''));
}

/** A public tag: capitals, digits, dot and dash only, at most 16 characters. */
export function publicTag(text, fallback = 'AGENT') {
  const t = String(text ?? '').toUpperCase().replace(/[^A-Z0-9.-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 16).replace(/[-.]+$/, '');
  return t || fallback;
}

// A release version inside a pattern: "VERSION" in a rule's match stands for it.
const VERSION_SRC = '\\d{1,4}\\.\\d{1,4}\\.\\d{1,4}(?:-[a-z0-9.]{1,12})?';
const withVersion = (src) => String(src).replace(/VERSION/g, VERSION_SRC);

/**
 * How a merge queue's entry history reads (release trains): each line "<ISO time> <text>", the first
 * rule whose `match` fits the text giving the entry's status from then on, and `release` (from the
 * match's groups) the release it is in. A preset replaces the list (rules.queue.history).
 */
export const DEFAULT_HISTORY = [
  { match: '^(?:re-)?added\\b', status: 'queued' },
  { match: '^(?:recovered as )?integrated into release (VERSION)', status: 'integrated', release: '$1' },
  { match: '^moved out\\b', status: 'moved-out' },
  { match: '^requeued\\b', status: 'queued' },
  { match: '^(?:merged into \\S+ with|recovered as merged with) release (VERSION)', status: 'merged', release: '$1' },
  { match: '^dropped\\b', status: 'dropped' },
];

const OWNER_KINDS = { merge: 'merger', merger: 'merger', integrator: 'merger', fix: 'fixer', fixer: 'fixer', release: 'check', check: 'check', checker: 'check', gate: 'check', verify: 'check', verifier: 'check', controller: 'controller', ctrl: 'controller' };

/**
 * Who a lock holder is, from its name: a preset's rules.owners first ({ match, word, kind, version },
 * with $n from the match), else the generic form "<role>-<version>" or "<role>-<run stamp>" (merger-…,
 * fixer-0.1.2, release-0.1.2 for a release's check). Returns { word, kind, version } with public words
 * (no stamps), or null for a holder it cannot read (a job slug, a host name).
 */
export function ownerInfo(holder, rules = GENERIC_RULES) {
  const h = String(holder ?? '').trim();
  if (!h) return null;
  for (const o of rules.owners || []) {
    const m = o.re.exec(h);
    if (!m) continue;
    return { word: fill(o.word, m) || null, kind: o.kind ? fill(o.kind, m) : null, version: o.version ? fill(o.version, m) || null : null };
  }
  const m = new RegExp(`^([a-z]+)[-_](?:(${VERSION_SRC})|\\d{8,14})$`, 'i').exec(h);
  if (!m) return null;
  const kind = OWNER_KINDS[m[1].toLowerCase()];
  if (!kind) return null;
  const role = m[1].toLowerCase();
  return { word: m[2] ? `${role} ${m[2]}` : role, kind, version: m[2] || null };
}

/** Compile the rules of a config once (regexes, lists) for the classifiers. */
export function compileRules(r = {}) {
  const labels = (Array.isArray(r.labels) ? r.labels : [])
    .map((rule) => (rule && rule.match ? { ...rule, re: rx(rule.match, rule.flags ?? 'i'), stripRe: rx(rule.tagStrip, 'i'), byJob: (rule.rolesByJob || []).map((x) => ({ re: rx(x.match), role: x.role })).filter((x) => x.re) } : null))
    .filter((rule) => rule && rule.re);
  const jobId = rx(r.jobId);
  const jobIdLoose = r.jobId ? rx(String(r.jobId).replace(/^\^/, '\\b').replace(/\$$/, '\\b'), 'i') : null;
  const laneOfJob = r.laneOfJob && r.laneOfJob.match ? { re: rx(r.laneOfJob.match), value: r.laneOfJob.value || '$1' } : null;
  const list = (xs) => (Array.isArray(xs) ? xs.map((s) => rx(s)).filter(Boolean) : []);
  // release: the prefix of the release-train locks (release-0.1.2); "" turns them off
  const locks = { merge: 'merge', exclusive: 'exclusive', slotPrefix: 'slot-', release: 'release-', ...(r.locks || {}) };
  return {
    labels,
    jobId,
    jobIdLoose,
    slugPrefix: rx(r.slugPrefix ?? '^agent/'),
    laneOfJob: laneOfJob && laneOfJob.re ? laneOfJob : null,
    laneId: rx(r.laneId || '^[A-Za-z0-9][A-Za-z0-9-]{0,5}$', ''),
    booth: r.booth && r.booth.match ? { re: rx(r.booth.match, 's'), exclusive: r.booth.exclusive || 'exclusive' } : null,
    lock: r.lock && r.lock.match ? { re: rx(r.lock.match, '') } : null,
    locks,
    liveChecks: list(r.liveChecks ?? ['\\be2e\\b', '\\bplaywright\\b', '\\bcypress\\b']),
    measures: list(r.measures),
    // release-train queues (docs/PRESETS.md): history wording, and status names mapped to the theater's
    queue: {
      history: (Array.isArray(r.queue?.history) ? r.queue.history : DEFAULT_HISTORY).map((h) => (h && h.match && h.status ? { re: rx(withVersion(h.match)), status: String(h.status), release: h.release || null } : null)).filter((h) => h && h.re),
      status: plainMap(r.queue?.status),
      releaseStatus: plainMap(r.queue?.releaseStatus),
    },
    owners: (Array.isArray(r.owners) ? r.owners : []).map((o) => (o && o.match ? { re: rx(withVersion(o.match)), word: String(o.word ?? '$0'), kind: o.kind ? String(o.kind) : null, version: o.version ? String(o.version) : null } : null)).filter((o) => o && o.re),
    standaloneTags: (Array.isArray(r.standaloneTags) ? r.standaloneTags : []).map((p) => (Array.isArray(p) ? { re: rx(p[0]), tag: String(p[1] || '') } : null)).filter((p) => p && p.re),
  };
}

export const GENERIC_RULES = compileRules({});

// ---------------------------------------------------------------- roles from words

/** The role a word names: setup, review, fix, prepare or integrate, verify, merge (null when none). */
export function roleOfWord(text) {
  const w = String(text ?? '').trim().toLowerCase();
  if (!w) return null;
  if (/^(setup|set up|install|bootstrap|init)\b/.test(w)) return 'setup';
  if (/^(review|judge|critique)\b/.test(w)) return 'reviewer';
  if (/^(fix|re-?fix|repair|debug|polish|patch)\b/.test(w)) return 'fixer';
  if (/^(prepare|prep|integrate|package|queue|ship)\b/.test(w)) return 'preparer';
  if (/^(verify|verification|gate|check|qa|test|audit|validate|final check)\b/.test(w)) return 'verifier';
  if (/^merge\b/.test(w)) return 'merger';
  if (/^(implement|build|code|write|develop|draft|concept|design|refactor|migrate)\b/.test(w)) return 'coder';
  if (/^(explore|research|investigate|survey|plan|probe|analy[sz]e|find|read|summari[sz]e)\b/.test(w)) return 'helper';
  return null;
}

/** Role from a job label's suffix: none = `none`, a keyword's role, else helper. */
export function roleOfSuffix(suffix, none = 'coder') {
  const s = String(suffix ?? '').trim().toLowerCase();
  if (!s) return none;
  const r = roleOfWord(s);
  return r === 'coder' ? 'coder' : r || 'helper';
}

/** The console a station shows for a workflow phase title: setup, coder, reviewer, fixer or preparer. */
export function stationKindOf(title, index = 0, count = 1) {
  const r = roleOfWord(title);
  if (r === 'setup') return 'setup';
  if (r === 'reviewer' || r === 'verifier') return 'reviewer';
  if (r === 'fixer') return 'fixer';
  if (r === 'preparer' || r === 'merger') return 'preparer';
  if (r === 'coder' || r === 'helper') return 'coder';
  // unknown words: first station sets up, last one packs, the rest code
  if (count > 2 && index === 0) return 'setup';
  if (count > 2 && index === count - 1) return 'preparer';
  return 'coder';
}

/** A station tag from a phase title: capitals, digits, space, dot and dash, at most 12 characters. */
export function stationTag(title) {
  const words = String(title ?? '').toUpperCase().replace(/[^A-Z0-9 .-]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  let out = '';
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > 12) break;
    out = next;
  }
  return out || (words[0] ? words[0].slice(0, 12) : 'STEP');
}

// ---------------------------------------------------------------- labels

/** "s03-task-02" / "agent/s03-task-02" -> "S03-TASK-02" when it is a job id of the rules; else null. */
export function jobFromSlug(text, rules = GENERIC_RULES) {
  if (!rules.jobId) return null;
  let s = String(text ?? '').trim();
  if (rules.slugPrefix) s = s.replace(rules.slugPrefix, '');
  return rules.jobId.test(s) ? s.toUpperCase() : null;
}

/** The lane of a job id by the rules (null when the rules do not say). */
export function laneOfJob(job, rules = GENERIC_RULES) {
  if (!job || !rules.laneOfJob) return null;
  const m = rules.laneOfJob.re.exec(String(job));
  if (!m) return null;
  const lane = fill(rules.laneOfJob.value, m).toUpperCase();
  return rules.laneId.test(lane) ? lane : null;
}

const TOPIC_RE = /^([a-z]+):([a-z0-9][a-z0-9-]{0,30})\b/i;

function ruleRole(rule, suffix, job) {
  const s = String(suffix || '').trim().toLowerCase();
  if (!s) {
    for (const b of rule.byJob) if (job && b.re.test(job)) return b.role;
    if (rule.roles && rule.roles['']) return rule.roles[''];
    return rule.role || 'coder';
  }
  if (rule.roles) {
    for (const [word, role] of Object.entries(rule.roles)) if (word && word !== '*' && s.startsWith(word)) return role;
    if (rule.roles['*']) return rule.roles['*'];
  }
  if (rule.role) return rule.role;
  return roleOfSuffix(s);
}

/**
 * Workflow label -> { role, job, suffix, tag }. The rules' label patterns come first (docs/PRESETS.md);
 * then the generic forms: "verb:topic" (fix:queue fixer, tag QUEUE; verify:all verifier, tag VERIFY),
 * a leading keyword (review, fix, prepare, verify, merge...), else a helper.
 */
export function classifyLabel(label, rules = GENERIC_RULES) {
  const text = String(label ?? '').trim();
  for (const rule of rules.labels) {
    const m = rule.re.exec(text);
    if (!m) continue;
    let job = rule.job !== undefined ? fill(rule.job, m).trim() : null;
    if (job && rule.upper !== false) job = job.toUpperCase();
    if (job === '') job = null;
    const suffix = (rule.suffix !== undefined ? fill(rule.suffix, m) : '').trim().toLowerCase();
    let tagText = rule.tag !== undefined ? fill(rule.tag, m) : job || text;
    if (rule.stripRe) tagText = tagText.replace(rule.stripRe, '');
    return { role: ruleRole(rule, suffix, job), job, suffix, tag: publicTag(tagText, rule.tagFallback || 'AGENT') };
  }
  const lower = text.toLowerCase();
  const topic = TOPIC_RE.exec(lower);
  if (topic) {
    const verb = topic[1];
    let role = roleOfWord(verb) || 'helper';
    if (role === 'reviewer') role = 'verifier';
    return { role, job: null, suffix: lower, tag: publicTag(topic[2] === 'all' ? verb : topic[2]) };
  }
  const first = lower.split(/\s+/)[0];
  const tag = publicTag(first);
  // a review, judge or check outside a job is a verifier (a lens over the work, not a lane reviewer)
  let role = roleOfWord(lower) || 'helper';
  if (role === 'reviewer') role = 'verifier';
  return { role, job: null, suffix: lower, tag };
}

const STANDALONE_WORDS = [
  [/\brelease/, 'RELEASE'],
  [/\bmerge/, 'MERGE'],
  [/\bqueue\b/, 'QUEUE'],
  [/\bdocker\b|\bcontainers?\b/, 'DOCKER'],
  [/\bdocs?\b|\bdocument/, 'DOCS'],
  [/\bsecurity\b|\baudit\b/, 'SECURITY'],
  [/\btests?\b|\bmeasure/, 'TESTS'],
  [/\bdesign\b|\bui\b/, 'DESIGN'],
  [/\bdeploy/, 'DEPLOY'],
  [/\brefactor/, 'REFACTOR'],
  [/\bresearch|\bexplore|\binvestigat/, 'RESEARCH'],
];

/** meta { description, agentType } of a standalone subagent -> { role, tag } (public-safe). */
export function classifyStandalone(meta = {}, rules = GENERIC_RULES) {
  const d = String(meta?.description ?? '').toLowerCase();
  const type = String(meta?.agentType ?? '').toLowerCase();
  let tag = null;
  if (rules.jobIdLoose) {
    const job = rules.jobIdLoose.exec(d);
    if (job) tag = publicTag(job[0]);
  }
  for (const p of rules.standaloneTags) {
    if (tag) break;
    const m = p.re.exec(d);
    if (m) tag = publicTag(fill(p.tag, m));
  }
  for (const [re, t] of STANDALONE_WORDS) if (!tag && re.test(d)) tag = t;
  tag = tag || 'AGENT';
  let role = 'coder';
  if (type === 'explore' || type === 'plan' || /\b(research|explore|investigat|survey|find)\w*/.test(d)) role = 'helper';
  else if (/\breview/.test(d)) role = 'reviewer';
  else if (/\b(fix|repair|debug)\w*/.test(d)) role = 'fixer';
  else if (/\b(verify|verification|check|qa|gate|audit)\b/.test(d)) role = 'verifier';
  return { role, tag };
}
