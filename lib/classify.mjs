// Pure classification helpers: tool use -> action kind, public phrases, redaction, holders. Label and
// job rules live in rules.mjs (generic built-ins plus a preset's own conventions).
import { GENERIC_RULES, classifyLabel, classifyStandalone, jobFromSlug, publicTag } from './rules.mjs';

export { classifyLabel, classifyStandalone, jobFromSlug, publicTag };

export const ROLES = ['setup', 'coder', 'reviewer', 'fixer', 'preparer', 'merger', 'verifier', 'helper'];
export const KINDS = ['edit', 'read', 'search', 'run', 'test', 'browser', 'docker', 'think', 'wait'];

/** A label is shown publicly only when it is a plain workflow label (no paths, no free text). */
export function safeLabel(label) {
  const text = String(label ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9 :._-]{0,47}$/.test(text) && !/[\\/]/.test(text) ? text : 'helper';
}

function kindOfCommand(command) {
  const c = String(command ?? '').toLowerCase();
  if (/\b(test|tests|vitest|jest|pytest|verify|verify:\S+|e2e|typecheck|tsc|lint|eslint|ruff|mypy)\b|test:/.test(c)) return 'test';
  if (/\b(docker|compose|podman)\b/.test(c)) return 'docker';
  if (/\b(chrome|chromium|playwright|puppeteer|browser|cypress)\b/.test(c)) return 'browser';
  return 'run';
}

/**
 * What a command really does, for the phrase: a live check (rules.liveChecks or a test-booth command),
 * a test-time measurement (rules.measures), tests, a build, containers; null for anything else.
 */
export function detailOfCommand(command, rules = GENERIC_RULES) {
  const c = String(command ?? '').toLowerCase();
  if (rules.measures.some((re) => re.test(c))) return 'measure';
  if (rules.liveChecks.some((re) => re.test(c)) || (rules.booth && rules.booth.re.test(c))) return 'check';
  if (/\b(vitest|jest|pytest|mocha|ava|phpunit|rspec)\b|turbo\s+(run\s+)?[a-z: -]*\btest\b|\b(pnpm|yarn|bun)\s+(run\s+)?test\b|\bnpm\s+(run\s+)?test\b|node\s+--test|\bgo\s+test\b|\bcargo\s+test\b|\b(mvn|gradle|gradlew)\b.*\btest\b|\bdotnet\s+test\b/.test(c)) return 'tests';
  if (/\b(docker|compose|podman)\b/.test(c)) return 'docker';
  if (/turbo\s+(run\s+)?build\b|\b(pnpm|yarn|bun)\s+(run\s+)?build\b|\bnpm\s+run\s+build\b|vite\s+build|\btsc\s+-b\b|\bcargo\s+build\b|\bgo\s+build\b|\bmake\b|\bwebpack\b|\besbuild\b/.test(c)) return 'build';
  return null;
}

/**
 * The same, from the short description an agent gives its command, for commands that only name a
 * script ("bash scripts/run.sh", described "Run the targeted test files per package").
 */
export function detailOfDescription(description) {
  const d = String(description ?? '').toLowerCase();
  if (!d) return null;
  if (/\bmeasur/.test(d)) return 'measure';
  if (/live check|\bjourney\b|\be2e\b|end-to-end|clean verif/.test(d)) return 'check';
  if (/\btests?\b|\bvitest\b|\btest files\b/.test(d)) return 'tests';
  if (/\bdocker\b|\bcontainers?\b/.test(d)) return 'docker';
  if (/\bbuild\b/.test(d)) return 'build';
  return null;
}

/** A command that only waits: a sleep loop polling a file, or a wait on a background task's output. */
function isPoll(command, description = '') {
  const c = String(command ?? '');
  if (/^\s*wait\b|\bwait for\b/i.test(String(description))) return true;
  if (/\bsleep\s+\d/.test(c) && /\b(until|while|for)\b/.test(c)) return true;
  if (/^\s*sleep\s+\d+\s*$/.test(c)) return true;
  return /\btasks[\\/][a-z0-9]+\.output\b/i.test(c) && /\b(tail|grep|cat)\b/.test(c) && !/\b(pnpm|npm|yarn|turbo|node|docker|python|cargo|go)\b/.test(c);
}

/**
 * One tool use -> compact action { kind, wait, slot, background, push }.
 * `wait` is "lock" for the rules' lock command, "slot" for its test-booth command (the live state decides
 * whether the agent still queues or is already inside), "task" for a poll; `push` marks a git push.
 */
export function classifyToolUse(name, input = {}, rules = GENERIC_RULES) {
  const tool = String(name ?? '');
  const background = Boolean(input && input.run_in_background);
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit' || tool === 'MultiEdit') return { kind: 'edit', background };
  if (tool === 'Read' || tool === 'WebFetch' || tool === 'WebSearch') return { kind: 'read', background };
  if (tool === 'Grep' || tool === 'Glob' || tool === 'LS') return { kind: 'search', background };
  if (tool === 'Monitor' || tool === 'TaskOutput' || tool === 'Sleep') return { kind: 'wait', background, wait: 'task' };
  if (/chrome|browser/i.test(tool)) return { kind: 'browser', background };
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = String(input?.command ?? '');
    const push = /\bgit\s+(-C\s+\S+\s+)?push\b/.test(command) && !/--dry-run/.test(command);
    const extra = push ? { push: true } : {};
    const lock = rules.lock ? rules.lock.re.exec(command) : null;
    if (lock) return { kind: 'wait', background, wait: 'lock', lock: lock[1], owner: lock[2] || null, ...extra };
    const slot = rules.booth ? rules.booth.re.exec(command) : null;
    if (slot) {
      const kind = kindOfCommand(slot[3]);
      return { kind: kind === 'run' ? 'test' : kind, background, wait: 'slot', exclusive: slot[1] === rules.booth.exclusive, owner: slot[2], detail: detailOfCommand(command, rules) || 'check', ...extra };
    }
    // a loop that only waits (also when it runs in the background to notify the agent)
    if (isPoll(command, input?.description)) return { kind: 'wait', background, wait: 'task', poll: true };
    const detail = detailOfCommand(command, rules) || detailOfDescription(input?.description);
    let kind = kindOfCommand(command);
    // a command that only names a script takes its kind from what it runs: tests, a check, a measurement
    if (kind === 'run' && detail) kind = detail === 'docker' ? 'docker' : detail === 'build' ? 'run' : 'test';
    return detail ? { kind, background, detail, ...extra } : { kind, background, ...extra };
  }
  if (tool === 'Agent' || tool === 'Task') return { kind: 'run', background };
  return { kind: 'think', background };
}

const PHRASES = {
  edit: { coder: 'writing code', fixer: 'fixing the code', reviewer: 'writing review notes', verifier: 'writing up findings', preparer: 'updating the branch', setup: 'preparing the workspace', merger: 'recording the merge', default: 'editing files' },
  read: { reviewer: 'reviewing a change', verifier: 'checking the work', fixer: 'studying the review', default: 'reading code' },
  search: { reviewer: 'tracing a change', default: 'searching the code' },
  run: { setup: 'setting up the workspace', preparer: 'syncing the branch', merger: 'merging branches', default: 'running a command' },
  test: { verifier: 'running checks', reviewer: 're-running the tests', default: 'running tests' },
  browser: { default: 'testing in the browser' },
  docker: { default: 'starting containers' },
  think: { reviewer: 'reviewing a change', verifier: 'weighing the evidence', merger: 'planning the merge', fixer: 'planning a fix', default: 'thinking' },
  wait: { lock: 'waiting for the merge lock', slot: 'waiting for a test booth', task: 'waiting for a long check', default: 'waiting' },
};
const DETAIL_PHRASES = { check: 'running a live check', measure: 'measuring test times', tests: 'running tests', build: 'building', docker: 'starting containers' };

/**
 * Generic, public-safe phrase for an action: never a command, path, host or name. detail (from the
 * command: check, measure, tests, build, docker) names what a test or run really is; background adds
 * that it runs in the background while the agent waits on it.
 */
export function publicPhrase(kind, role, waitFor, { detail = null, background = false } = {}) {
  const table = PHRASES[kind] || PHRASES.think;
  let text;
  if (kind === 'wait') text = table[waitFor] || table.default;
  else if (detail && DETAIL_PHRASES[detail] && (kind === 'test' || kind === 'run' || kind === 'docker' || kind === 'browser')) text = DETAIL_PHRASES[detail];
  else text = table[role] || table.default;
  return background && kind !== 'wait' && kind !== 'think' ? `${text} (background)` : text;
}

const SECRET_PATTERNS = [
  /\b(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9-]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|npm_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{12,})\b/g,
  /\b(bearer|token|password|passwd|secret|api[_-]?key)(\s*[:=]\s*|\s+)\S+/gi,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
];

/** Shorten text for the private view and strip obvious secrets, e-mail addresses and home paths. */
export function redact(text, max = 90) {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim();
  for (const re of SECRET_PATTERNS) s = s.replace(re, (m, a) => (a && /^(bearer|token|password|passwd|secret|api)/i.test(a) ? `${a} ***` : '***'));
  s = s.replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+/gi, '~').replace(/\/(home|Users)\/[^/\s"']+/g, '~').replace(/\/mnt\/[a-z]\/Users\/[^/\s"']+/gi, '~');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Redact a block of text for the private log: the same secrets, e-mail addresses and home paths as
 * redact(), but line breaks are kept (runs of blank lines shrink to one) and the cut is longer.
 */
export function redactBlock(text, max = 4000) {
  let s = String(text ?? '').replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  for (const re of SECRET_PATTERNS) s = s.replace(re, (m, a) => (a && /^(bearer|token|password|passwd|secret|api)/i.test(a) ? `${a} ***` : '***'));
  s = s.replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+/gi, '~').replace(/\/(home|Users)\/[^/\s"']+/g, '~').replace(/\/mnt\/[a-z]\/Users\/[^/\s"']+/gi, '~');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * What an agent says it is doing, from its latest message: the first sentence of the text, without
 * markdown, redacted, at most `max` characters. Null for an empty message.
 */
export function sayOf(text, max = 140) {
  const lines = String(text ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:[#>*+-]+|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const plain = lines.join(' ').replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
  const first = /^(.+?[.!?…])(\s|$)/.exec(plain);
  const s = redact(first && first[1].length >= 12 ? first[1] : plain, max);
  return s || null;
}

/** Private-mode description of a tool use (still redacted, never full file contents). */
export function privateText(name, input = {}) {
  if (input.description) return redact(input.description);
  if (input.file_path) {
    const parts = String(input.file_path).split(/[\\/]+/);
    return redact(`${name} ${parts.slice(-2).join('/')}`);
  }
  if (input.pattern) return redact(`${name} ${input.pattern}`);
  if (input.command) return redact(String(input.command).replace(/^cd \S+ && /, ''));
  return redact(name);
}

/** "s02-task-06 1795080240" -> { holder: "s02-task-06", since: ISO } (null when unreadable). */
export function parseOwner(text) {
  const m = /^\s*(\S+)\s+(\d{9,12})\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  return { holder: m[1], since: new Date(Number(m[2]) * 1000).toISOString() };
}

/** Lock/slot holder for display: job ids upper-cased; other names shown only when known-safe. */
export function displayHolder(holder, { publicMode, knownSlugs = new Set(), rules = GENERIC_RULES } = {}) {
  if (!holder) return null;
  const job = jobFromSlug(holder, rules);
  if (job) return job;
  const lower = String(holder).toLowerCase();
  if (knownSlugs.has(lower)) return lower;
  if (/^merge[-_]?batch/.test(lower)) return 'merge batch';
  if (!publicMode) return redact(holder, 40);
  return 'agent';
}

export const ROLE_NOUN = {
  setup: 'setup',
  coder: 'coding',
  reviewer: 'review',
  fixer: 'fix',
  preparer: 'merge prep',
  merger: 'merge batch',
  verifier: 'verification',
  helper: 'helper',
};
