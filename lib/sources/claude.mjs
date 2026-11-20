// The Claude Code adapter: finds sessions under ~/.claude/projects/*/ and reads, without writing:
//   - workflow runs: <session>/subagents/workflows/wf_*/journal.jsonl (which agent started in which
//     phase, results, failures) with the agents' transcripts agent-<id>.jsonl beside it;
//   - finished runs' records: <session>/workflows/wf_*.json (workflow name, phases, status, times);
//   - a running run's phases: the script the session launched it with (the Workflow tool's result in the
//     session transcript names the run id and the script file), or the persisted inline script;
//   - standalone subagents: <session>/subagents/agent-<id>.jsonl with agent-<id>.meta.json.
// Every reader tolerates missing files, unknown fields and lines it cannot parse: what it cannot read
// it leaves out. The shapes it relies on are listed in docs/SOURCES.md.
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { GENERIC_RULES, classifyLabel, classifyStandalone } from '../rules.mjs';
import { readCached, readJson, readRange, statOrNull } from './files.mjs';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RUN_RE = /^wf_[A-Za-z0-9-]{3,40}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

const listDirs = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
};

const globRe = (pattern) => new RegExp(`^${String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

// ---------------------------------------------------------------- sessions

/**
 * The sessions to read. With sources.workflows set: that one session. Else every session under
 * <claude>/projects/<project>/<session>/ (projects filtered by sources.projects) that was active since
 * `sinceMs` (its transcript, subagents or workflows folder changed since).
 */
export function discoverSessions(cfg, { sinceMs = 0 } = {}) {
  const s = cfg.sources;
  if (s.workflows) {
    const subagents = s.subagents || (basename(s.workflows) === 'workflows' ? dirname(s.workflows) : null);
    const dir = subagents && basename(subagents) === 'subagents' ? dirname(subagents) : null;
    return [{ key: 's0', project: null, dir, workflowsDir: s.workflows, subagentsDir: s.subagents === false ? null : subagents, runsDir: dir ? join(dir, 'workflows') : null, transcript: dir ? `${dir}.jsonl` : null }];
  }
  if (!s.claude) return [];
  const projectsDir = join(s.claude, 'projects');
  const filters = s.projects.length ? s.projects.map(globRe) : null;
  const out = [];
  for (const project of listDirs(projectsDir)) {
    if (filters && !filters.some((re) => re.test(project))) continue;
    const pdir = join(projectsDir, project);
    for (const id of listDirs(pdir)) {
      if (!/^[0-9a-f-]{8,64}$/i.test(id)) continue;
      const dir = join(pdir, id);
      const transcript = `${dir}.jsonl`;
      const subagentsDir = join(dir, 'subagents');
      const workflowsDir = join(subagentsDir, 'workflows');
      const runsDir = join(dir, 'workflows');
      const latest = Math.max(statOrNull(transcript)?.mtimeMs ?? 0, statOrNull(subagentsDir)?.mtimeMs ?? 0, statOrNull(workflowsDir)?.mtimeMs ?? 0, statOrNull(runsDir)?.mtimeMs ?? 0);
      if (!latest || latest < sinceMs) continue;
      out.push({ key: `s${out.length}`, project, dir, workflowsDir: existsSync(workflowsDir) ? workflowsDir : null, subagentsDir: existsSync(subagentsDir) && s.subagents !== false ? subagentsDir : null, runsDir: existsSync(runsDir) ? runsDir : null, transcript });
    }
  }
  return out;
}

// ---------------------------------------------------------------- journals and run records

/** Parse one journal.jsonl text: started agents (label, phase), results, failures, in order. */
export function parseJournal(text) {
  const started = new Map();
  const results = new Set();
  const failed = new Set();
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    if (row.type === 'started' && row.agentId) started.set(String(row.agentId), { label: String(row.label ?? ''), wfPhase: String(row.phase ?? ''), key: row.key ?? null });
    if (row.type === 'result' && row.agentId) results.add(String(row.agentId));
    if (row.type === 'failed' && row.agentId) failed.add(String(row.agentId));
  }
  return { started, results, failed };
}

/** A string literal's end index in `s` starting at its opening quote (template literals included). */
function skipString(s, i) {
  const q = s[i];
  for (let j = i + 1; j < s.length; j += 1) {
    if (s[j] === '\\') j += 1;
    else if (s[j] === q) return j;
  }
  return s.length;
}

/** The workflow's own name and phase titles from its script's `export const meta = { name, phases }`. */
export function parseWorkflowMeta(text) {
  const src = String(text ?? '');
  const start = src.search(/export\s+const\s+meta\s*=\s*\{/);
  if (start < 0) return { name: null, phases: [] };
  const name = /\bname\s*:\s*(['"`])([^'"`\n]{1,80})\1/.exec(src.slice(start, start + 4000));
  const at = src.slice(start, start + 20000).search(/\bphases\s*:\s*\[/);
  const phases = [];
  if (at >= 0) {
    let i = start + src.slice(start).slice(at).indexOf('[') + at;
    let depth = 0;
    let end = -1;
    for (; i < src.length; i += 1) {
      const c = src[i];
      if (c === '"' || c === "'" || c === '`') i = skipString(src, i);
      else if (c === '[') depth += 1;
      else if (c === ']') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = end > 0 ? src.slice(src.indexOf('[', start + at), end) : '';
    for (const m of body.matchAll(/\btitle\s*:\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) phases.push(m[2].replace(/\\(.)/g, '$1'));
  }
  return { name: name ? name[2] : null, phases };
}

function token(v) {
  return typeof v === 'string' && TOKEN_RE.test(v.trim()) ? v.trim() : null;
}

/** What a run is about, as a short token from its args (id, slug, name, job, task), else null. */
export function subjectOfArgs(args) {
  if (!args || typeof args !== 'object') return null;
  for (const k of ['id', 'slug', 'job', 'name', 'task', 'ticket', 'target']) {
    const t = token(args[k]);
    if (t) return t;
  }
  return null;
}

/** A finished run's record <runsDir>/<runId>.json, compacted (the script and results are not kept). */
export function readRunRecord(runsDir, runId) {
  if (!runsDir) return null;
  const { ok, data } = readJson(join(runsDir, `${runId}.json`));
  if (!ok || !data || typeof data !== 'object') return null;
  const st = statOrNull(join(runsDir, `${runId}.json`));
  const startMs = Number(data.startTime);
  const dur = Number(data.durationMs);
  const phases = Array.isArray(data.phases) ? data.phases.map((p) => (typeof p === 'string' ? p : p?.title)).filter((t) => typeof t === 'string' && t.trim()) : [];
  const meta = phases.length || data.workflowName ? null : typeof data.script === 'string' ? parseWorkflowMeta(data.script) : null;
  return {
    workflow: typeof data.workflowName === 'string' ? data.workflowName : meta?.name || null,
    phases: phases.length ? phases : meta?.phases || [],
    status: typeof data.status === 'string' ? data.status.toLowerCase() : 'completed',
    startMs: Number.isFinite(startMs) ? startMs : null,
    endMs: Number.isFinite(startMs) && Number.isFinite(dur) ? startMs + dur : st?.mtimeMs ?? null,
    subject: subjectOfArgs(data.args),
  };
}

// ---------------------------------------------------------------- the session transcript: launches

const RUN_ID_RE = /Run ID:\s*(wf_[A-Za-z0-9-]{3,40})/;
const SCRIPT_RE = /Script file:\s*([^\n\r"]+?)\s*(?:\n|\\n|$)/;
const DIR_RE = /Transcript dir:\s*[^\n\r"]*?[\\/](wf_[A-Za-z0-9-]{3,40})/;
const FIRST_READ = 64 * 1024 * 1024;
const CHUNK = 8 * 1024 * 1024;

/**
 * Follows session transcripts for workflow launches: the Workflow tool use (its args and script) and its
 * result (the run id and the script file). Reads each transcript incrementally; the first read starts at
 * most 64 MB from the end. launches(path) -> Map runId -> { scriptPath, script, name, subject }.
 */
export class LaunchIndex {
  constructor() {
    this.entries = new Map();
  }

  launches(path) {
    const st = path ? statOrNull(path) : null;
    if (!st) return new Map();
    let e = this.entries.get(path);
    if (!e || st.size < e.offset) {
      e = { offset: Math.max(0, st.size - FIRST_READ), uses: new Map(), runs: new Map(), first: true };
      this.entries.set(path, e);
    }
    while (e.offset < st.size) {
      const end = Math.min(st.size, e.offset + CHUNK);
      let buf;
      try {
        buf = readRange(path, e.offset, end);
      } catch {
        break;
      }
      const cut = buf.lastIndexOf(0x0a);
      if (cut < 0) {
        if (end >= st.size) break;
        e.offset = end; // a line longer than a chunk cannot be a launch record: skip it
        continue;
      }
      let text = buf.subarray(0, cut + 1).toString('utf8');
      // the first read may start mid-line
      if (e.first) {
        text = text.slice(text.indexOf('\n') + 1);
        e.first = false;
      }
      this.#consume(e, text);
      e.offset += cut + 1;
    }
    return e.runs;
  }

  #consume(e, text) {
    for (const line of text.split('\n')) {
      if (line.includes('"name":"Workflow"')) {
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        for (const b of Array.isArray(row?.message?.content) ? row.message.content : []) {
          if (b?.type !== 'tool_use' || b.name !== 'Workflow' || !b.id) continue;
          const input = b.input && typeof b.input === 'object' ? b.input : {};
          e.uses.set(b.id, { script: typeof input.script === 'string' ? input.script : null, name: token(input.name), subject: subjectOfArgs(input.args), resumeOf: typeof input.resumeFromRunId === 'string' ? input.resumeFromRunId : null });
          if (e.uses.size > 2000) e.uses.delete(e.uses.keys().next().value);
        }
      } else if (line.includes('Run ID:') && line.includes('"tool_result"')) {
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        for (const b of Array.isArray(row?.message?.content) ? row.message.content : []) {
          if (b?.type !== 'tool_result') continue;
          const content = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c) => c?.text || '').join('\n') : '';
          const run = RUN_ID_RE.exec(content) || DIR_RE.exec(content);
          if (!run) continue;
          const script = SCRIPT_RE.exec(content);
          const use = e.uses.get(b.tool_use_id) || {};
          e.runs.set(run[1], { scriptPath: script ? script[1].trim() : null, script: use.script || null, name: use.name || null, subject: use.subject || null });
        }
      }
    }
  }
}

/** The phases and name of a run without a record: its launch's script, a persisted inline script. */
function launchMeta(launch, runsDir, runId) {
  const tryText = (text) => {
    const m = parseWorkflowMeta(text);
    return m.phases.length || m.name ? m : null;
  };
  if (launch?.script) {
    const m = tryText(launch.script);
    if (m) return m;
  }
  if (launch?.scriptPath) {
    try {
      const m = tryText(readCached(launch.scriptPath).text);
      if (m) return m;
    } catch {
      // the script moved or is on another machine
    }
  }
  if (runsDir) {
    const scripts = join(runsDir, 'scripts');
    try {
      const f = readdirSync(scripts).find((n) => n.endsWith(`-${runId}.js`));
      if (f) {
        const m = tryText(readCached(join(scripts, f)).text);
        if (m) return m;
      }
    } catch {
      // no persisted scripts
    }
  }
  return null;
}

// ---------------------------------------------------------------- runs and agents

/**
 * Every workflow run and its agents in the sessions given. A run: { id, session, workflow, phases,
 * status (completed, killed, failed or running), startMs, endMs, subject }. An agent: { run, agentId,
 * label, wfPhase, role, job, tag, standalone: false, relaunchedAt, hasResult, transcript, mtimeMs,
 * startMs, endMs, runEndMs }. `launches` (a LaunchIndex) is only used for runs without a record.
 */
export function scanRuns(sessions, transcripts, { rules = GENERIC_RULES, launches = null, sinceMs = 0, relaunch = false } = {}) {
  const runs = [];
  const agents = [];
  let ok = false;
  for (const session of sessions) {
    if (!session.workflowsDir || !existsSync(session.workflowsDir)) continue;
    ok = true;
    let names;
    try {
      names = readdirSync(session.workflowsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && RUN_RE.test(d.name)).map((d) => d.name);
    } catch {
      continue;
    }
    const sessionAgents = [];
    for (const runId of names) {
      const runDir = join(session.workflowsDir, runId);
      const jst = statOrNull(join(runDir, 'journal.jsonl'));
      if (!jst) continue;
      const record = readRunRecord(session.runsDir, runId);
      // a run that ended before the window is not read further
      if (record && record.endMs !== null && record.endMs < sinceMs) continue;
      if (!record && jst.mtimeMs < sinceMs && (statOrNull(runDir)?.mtimeMs ?? 0) < sinceMs) continue;
      let journal;
      try {
        journal = parseJournal(readCached(join(runDir, 'journal.jsonl')).text);
      } catch {
        continue;
      }
      const run = { id: runId, session: session.key, workflow: record?.workflow || null, phases: record?.phases?.slice() || [], status: record ? record.status : 'running', startMs: record?.startMs ?? null, endMs: record && record.status !== 'running' ? record.endMs : null, subject: record?.subject || null, agentIds: [] };
      if (!record && launches) {
        const launch = launches.launches(session.transcript).get(runId);
        const meta = launchMeta(launch, session.runsDir, runId);
        if (meta) {
          run.workflow = meta.name || launch?.name || null;
          run.phases = meta.phases.slice();
        }
        if (launch?.subject) run.subject = launch.subject;
        if (!run.workflow && launch?.name) run.workflow = launch.name;
      }
      for (const [agentId, info] of journal.started) {
        if (!ID_RE.test(agentId)) continue;
        // phases the script does not declare (or a run without a known script): in order of first use
        if (info.wfPhase && !run.phases.some((p) => p.toLowerCase() === info.wfPhase.toLowerCase())) run.phases.push(info.wfPhase);
        const transcript = join(runDir, `agent-${agentId}.jsonl`);
        const st = statOrNull(transcript);
        const mtimeMs = st ? st.mtimeMs : null;
        const startMs = mtimeMs === null ? null : transcripts.firstTimestamp(transcript) ?? st.birthtimeMs ?? mtimeMs;
        const hasResult = journal.results.has(agentId) || journal.failed.has(agentId);
        const { role, job, tag } = classifyLabel(info.label, rules);
        const agent = { run: runId, session: session.key, agentId, label: info.label, wfPhase: info.wfPhase, role, job, tag, standalone: false, relaunchedAt: null, hasResult, failed: journal.failed.has(agentId), transcript, mtimeMs, startMs, endMs: hasResult ? mtimeMs : null, runEndMs: run.endMs };
        agents.push(agent);
        sessionAgents.push(agent);
        run.agentIds.push(agentId);
        if (startMs !== null && (run.startMs === null || startMs < run.startMs)) run.startMs = startMs;
      }
      if (run.startMs === null) run.startMs = jst.birthtimeMs || jst.mtimeMs;
      run.lastMs = Math.max(jst.mtimeMs, ...agents.filter((a) => a.run === runId && a.session === session.key).map((a) => a.mtimeMs ?? 0));
      runs.push(run);
    }
    if (relaunch) markRelaunches(sessionAgents);
  }
  return { ok, runs, agents };
}

/** Set relaunchedAt on every agent whose label a newer run started again (same label, other run, later start). */
export function markRelaunches(agents) {
  const byLabel = new Map();
  for (const a of agents) {
    const key = String(a.label || '').trim().toLowerCase();
    if (!key || a.startMs === null) continue;
    byLabel.set(key, [...(byLabel.get(key) || []), a]);
  }
  for (const list of byLabel.values()) {
    if (list.length < 2) continue;
    for (const a of list) {
      const later = list.filter((b) => b.run !== a.run && b.startMs > a.startMs).map((b) => b.startMs);
      if (later.length) a.relaunchedAt = Math.min(...later);
    }
  }
  return agents;
}

/**
 * Standalone subagents: the ones a session launched directly (not through a workflow), whose
 * transcripts sit in its subagents folder as agent-<id>.jsonl with agent-<id>.meta.json beside them.
 * The meta's description is private; only a tag (rules and a word list) and a role are kept. A meta
 * with finished:true has ended.
 */
export function scanStandalone(sessions, transcripts, { rules = GENERIC_RULES, sinceMs = 0 } = {}) {
  const agents = [];
  let ok = false;
  for (const session of sessions) {
    const dir = session.subagentsDir;
    if (!dir || !existsSync(dir)) continue;
    ok = true;
    let files;
    try {
      files = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && /^agent-[A-Za-z0-9_-]{1,64}\.jsonl$/.test(d.name));
    } catch {
      continue;
    }
    for (const f of files) {
      const agentId = f.name.slice(6, -6);
      const transcript = join(dir, f.name);
      const st = statOrNull(transcript);
      if (!st || st.mtimeMs < sinceMs) continue;
      let meta = {};
      const metaRead = readJson(join(dir, `agent-${agentId}.meta.json`));
      if (metaRead.ok && metaRead.data && typeof metaRead.data === 'object') meta = metaRead.data;
      // a workflow's own agent that landed here is not a standalone one
      if (meta.inWorkflowRun === true) continue;
      const startMs = transcripts.firstTimestamp(transcript) ?? (st.birthtimeMs || st.mtimeMs);
      const { role, tag } = classifyStandalone(meta, rules);
      const finished = meta.finished === true;
      agents.push({ run: 'standalone', session: session.key, agentId, label: String(meta.description || 'agent'), wfPhase: '', role, job: null, tag, standalone: true, agentType: String(meta.agentType || ''), relaunchedAt: null, hasResult: finished, transcript, mtimeMs: st.mtimeMs, startMs, endMs: finished ? st.mtimeMs : null, runEndMs: null });
    }
  }
  return { ok, agents };
}
