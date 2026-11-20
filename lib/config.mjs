// Configuration: built-in defaults, an optional preset file, and an optional config file, merged in that
// order (later wins; objects merge, arrays and values replace). Every data-source path lives here; no
// other module names a path. Without any file the theater discovers Claude Code sessions under ~/.claude.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The stations of a lane when the lanes come from jobs (pipeline.lanes "jobs"): one per lane role. */
export const DEFAULT_STATIONS = [
  { tag: 'SETUP', kind: 'setup', roles: ['setup'] },
  { tag: 'CODE', kind: 'coder', roles: ['coder'] },
  { tag: 'REVIEW', kind: 'reviewer', roles: ['reviewer'] },
  { tag: 'FIX', kind: 'fixer', roles: ['fixer'] },
  { tag: 'PREP', kind: 'preparer', roles: ['preparer'] },
];

export const DEFAULTS = {
  port: 8790,
  // a name for the project, shown nowhere on the stage; null keeps it out of the state
  projectName: null,
  publicDir: 'public',
  // a preset file merged under this config (relative to the config file)
  preset: null,
  sources: {
    // Claude Code's home folder; its projects/*/ sessions are discovered. false turns discovery off.
    claude: '~/.claude',
    // only sessions of these project folders (names as under ~/.claude/projects; "*" wildcards); empty: all
    projects: [],
    // one session's workflows folder (…/<session>/subagents/workflows) instead of discovery
    workflows: null,
    // standalone subagents folder; defaults to the parent of `workflows`; false turns it off
    subagents: null,
    // a git repository whose merges into `branch` are shown at the merge machine
    repo: null,
    branch: 'main',
    // runner files (all optional, documented in docs/SOURCES.md)
    lanes: null,
    queue: null,
    locks: null,
    progress: null,
    // a JSON Lines file of theater events (docs/EVENTS.md); POST /api/events works without it
    events: null,
  },
  pipeline: {
    // "runs": one lane per workflow run, its stations the workflow's own phases.
    // "jobs": one lane per lane id of a job (rules.laneOfJob or the progress file), stations below.
    lanes: 'runs',
    stations: DEFAULT_STATIONS,
    // short titles of lanes (private view only)
    laneTitles: {},
    maxStations: 6,
  },
  // the words on the controller's LCDs; null picks them from pipeline.lanes
  counters: null,
  yard: { labels: null },
  rules: {
    // ordered label rules (docs/PRESETS.md); built-in generic rules follow them
    labels: [],
    // a job id (anchored regex); null: workflow labels carry no job ids
    jobId: null,
    slugPrefix: '^agent/',
    // the lane of a job: { match, value } (regex on the job id and a $1 template)
    laneOfJob: null,
    laneId: '^[A-Za-z0-9][A-Za-z0-9-]{0,5}$',
    // test-booth and lock commands of a runner: { match } regexes (docs/PRESETS.md)
    booth: null,
    lock: null,
    // lock folder names in the locks source
    locks: { merge: 'merge', exclusive: 'exclusive', slotPrefix: 'slot-' },
    // commands that are long live checks of the product, and test-time measurements
    liveChecks: ['\\be2e\\b', '\\bplaywright\\b', '\\bcypress\\b'],
    measures: [],
    // [regex, TAG] pairs for standalone subagents' descriptions, before the built-in words
    standaloneTags: [],
  },
  events: { post: true, maxAgents: 64, maxLanes: 32 },
  activeMinutes: 20,
  quietMinutes: 5,
  backgroundMaxMinutes: 180,
  pushSeconds: 2,
  thinkAfterSeconds: 120,
  slotCount: 4,
  eventsHours: 12,
  maxEvents: 60,
  recentQueueMinutes: 60,
  // a finished workflow run stays on stage this long
  lingerMinutes: 2,
  // the run and agent counters count this many hours back
  countHours: 24,
  replay: { defaultHours: 8, maxHours: 48, defaultFrames: 240, maxFrames: 900 },
};

const NUMBER_KEYS = ['activeMinutes', 'quietMinutes', 'backgroundMaxMinutes', 'pushSeconds', 'thinkAfterSeconds', 'slotCount', 'eventsHours', 'maxEvents', 'recentQueueMinutes', 'lingerMinutes', 'countHours'];
const PATH_KEYS = ['claude', 'workflows', 'subagents', 'repo', 'lanes', 'queue', 'locks', 'progress', 'events'];

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep merge: objects merge key by key, anything else (arrays included) replaces. */
export function merge(base, over) {
  if (!isPlain(over)) return over === undefined ? base : over;
  const out = isPlain(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over)) out[k] = isPlain(v) && isPlain(out[k]) ? merge(out[k], v) : v === undefined ? out[k] : v;
  return out;
}

/** Older key names, still read: mergeQueue, developBranch, featureStatus, phaseShort. */
function upgradeKeys(raw = {}) {
  const r = { ...raw, sources: { ...(raw.sources || {}) } };
  const s = r.sources;
  if (s.mergeQueue !== undefined && s.queue === undefined) s.queue = s.mergeQueue;
  if (s.developBranch !== undefined && s.branch === undefined) s.branch = s.developBranch;
  if (s.featureStatus !== undefined && s.progress === undefined) s.progress = s.featureStatus;
  delete s.mergeQueue;
  delete s.developBranch;
  delete s.featureStatus;
  delete s.janitorLog;
  if (raw.phaseShort && !raw.pipeline?.laneTitles) r.pipeline = { ...(raw.pipeline || {}), laneTitles: raw.phaseShort };
  delete r.phaseShort;
  return r;
}

function expandPath(value, baseDir) {
  if (typeof value !== 'string' || !value) return null;
  const v = value === '~' || value.startsWith('~/') || value.startsWith('~\\') ? join(homedir(), value.slice(1)) : value;
  return isAbsolute(v) ? v : resolve(baseDir, v);
}

/** Merge a raw config (and its preset, already merged by loadConfig) over the defaults and normalize it. */
export function normalizeConfig(raw = {}, baseDir = APP_DIR) {
  const cfg = merge(DEFAULTS, upgradeKeys(raw));
  cfg.sources = { ...cfg.sources };
  for (const key of PATH_KEYS) {
    const v = cfg.sources[key];
    cfg.sources[key] = v === false || v === '' || v === undefined || v === null ? null : expandPath(v, baseDir);
  }
  // an explicit workflows folder means one known session: no discovery unless asked for
  if (raw?.sources?.workflows && raw?.sources?.claude === undefined) cfg.sources.claude = null;
  if (raw?.sources?.subagents === false) cfg.sources.subagents = false;
  else if (!cfg.sources.subagents && cfg.sources.workflows && /[\\/]workflows[\\/]?$/.test(cfg.sources.workflows)) cfg.sources.subagents = dirname(cfg.sources.workflows);
  cfg.sources.projects = Array.isArray(cfg.sources.projects) ? cfg.sources.projects.map(String) : [];
  if (!cfg.sources.branch || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(cfg.sources.branch)) cfg.sources.branch = 'main';
  // the stage files ship with the app: a config only moves them when it names publicDir itself
  cfg.publicDir = raw.publicDir ? expandPath(raw.publicDir, baseDir) : join(APP_DIR, 'public');
  const port = Number(cfg.port);
  cfg.port = Number.isInteger(port) && port >= 0 && port < 65536 ? port : DEFAULTS.port;
  for (const key of NUMBER_KEYS) {
    const n = Number(cfg[key]);
    cfg[key] = Number.isFinite(n) && n > 0 ? n : DEFAULTS[key];
  }
  cfg.pipeline = { ...cfg.pipeline, lanes: cfg.pipeline.lanes === 'jobs' ? 'jobs' : 'runs' };
  if (!Array.isArray(cfg.pipeline.stations) || !cfg.pipeline.stations.length) cfg.pipeline.stations = DEFAULT_STATIONS;
  cfg.pipeline.maxStations = Math.min(6, Math.max(1, Number(cfg.pipeline.maxStations) || 6));
  const runs = cfg.pipeline.lanes === 'runs';
  cfg.counters = merge(runs ? { jobs: 'RUNS', features: 'AGENTS', batch: 'LIVE' } : { jobs: 'JOBS', features: 'FEATURES', batch: 'BATCH' }, cfg.counters || {});
  cfg.yard = { labels: merge(runs ? { test: 'TEST', merge: 'FINISH', develop: 'DONE', remote: 'REMOTE' } : { test: 'TEST', merge: 'MERGE', develop: 'DEVELOP', remote: 'REMOTE' }, cfg.yard?.labels || {}) };
  cfg.projectName = typeof cfg.projectName === 'string' && cfg.projectName.trim() ? cfg.projectName.trim() : null;
  return cfg;
}

/** The config file to read: --config, AGENT_THEATER_CONFIG, ./agent-theater.config.json, <app>/config.json. */
export function configPath(argv = process.argv, env = process.env, cwd = process.cwd()) {
  const i = argv.indexOf('--config');
  if (i >= 0 && argv[i + 1]) return resolve(cwd, argv[i + 1]);
  if (env.AGENT_THEATER_CONFIG) return resolve(cwd, env.AGENT_THEATER_CONFIG);
  for (const p of [join(cwd, 'agent-theater.config.json'), join(APP_DIR, 'config.json')]) if (existsSync(p)) return p;
  return null;
}

function readJsonFile(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read the ${what} ${path}: ${error.message}`);
  }
}

/** Read the config (and its preset) from `path`, or use the defaults when there is none. */
export function loadConfig(path = configPath()) {
  if (!path) return normalizeConfig({}, process.cwd());
  const raw = readJsonFile(path, 'config file');
  const base = dirname(resolve(path));
  if (!raw.preset) return normalizeConfig(raw, base);
  const presetPath = expandPath(raw.preset, base);
  const preset = readJsonFile(presetPath, 'preset');
  // paths in the preset are relative to the preset; the config's own paths to the config
  const presetSources = {};
  for (const [k, v] of Object.entries(preset.sources || {})) presetSources[k] = PATH_KEYS.includes(k) && typeof v === 'string' ? expandPath(v, dirname(presetPath)) : v;
  return normalizeConfig(merge({ ...preset, sources: presetSources }, raw), base);
}
