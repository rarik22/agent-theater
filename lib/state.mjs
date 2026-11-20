// Builds the live state served at /api/state and /api/stream from the read-only sources.
//
// Lanes (the rows of the stage) come from one of two models (pipeline.lanes):
//   - "runs" (the default): one lane per workflow run, its stations the workflow's own phases; an agent
//     stands at the station of the phase it was started in, so a run's agents move along its lane;
//   - "jobs": one lane per lane id of a job (rules.laneOfJob or the progress file), with the configured
//     stations; an agent stands at the station of its role (a preset's runner pipeline).
// Agents of the event API (POST /api/events or a JSON Lines file) join their own lanes in both models.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROLE_NOUN, displayHolder, publicPhrase, redact, safeLabel } from './classify.mjs';
import { GENERIC_RULES, compileRules, jobFromSlug, laneOfJob as laneOfJobRule, publicTag, roleOfWord, stationKindOf, stationTag } from './rules.mjs';
import { LaunchIndex, discoverSessions, scanRuns, scanStandalone } from './sources/claude.mjs';
import { EventStore } from './sources/events.mjs';
import { GitReader, readLanes, readLocks, readProgress, readQueue } from './sources/runner.mjs';
import { TranscriptCache, backgroundAt } from './transcripts.mjs';

/** One long-lived context per server: config, compiled rules and caches. */
export function createTheater(cfg, { exec } = {}) {
  const rules = compileRules(cfg.rules);
  return {
    cfg,
    rules,
    transcripts: new TranscriptCache(rules),
    git: new GitReader(cfg, exec, rules),
    launches: new LaunchIndex(),
    events: new EventStore({ maxAgents: cfg.events?.maxAgents, maxLanes: cfg.events?.maxLanes, maxStations: cfg.pipeline.maxStations }),
    chips: new Map(),
    discovery: { at: -Infinity, since: Infinity, sessions: [] },
  };
}

const iso = (ms) => (ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
const runsMode = (cfg) => cfg.pipeline.lanes === 'runs';

function sessionsFor(theater, sinceMs, now) {
  const d = theater.discovery;
  if (now - d.at < 10_000 && d.since <= sinceMs && Date.now() - d.real < 10_000) return d.sessions;
  const sessions = discoverSessions(theater.cfg, { sinceMs });
  theater.discovery = { at: now, real: Date.now(), since: sinceMs, sessions };
  return sessions;
}

/** Read every source once. `sinceMs` bounds the history that is read (runs, git merges). */
export async function collect(theater, { sinceMs, now = Date.now() }) {
  const { cfg, transcripts, git, rules } = theater;
  const s = cfg.sources;
  const scanSince = Math.min(sinceMs, now - cfg.countHours * 3600_000);
  const sessions = sessionsFor(theater, scanSince, now);
  const runsScan = scanRuns(sessions, transcripts, { rules, launches: runsMode(cfg) ? theater.launches : null, sinceMs: scanSince, relaunch: Boolean(cfg.rules.relaunchByLabel) });
  const standalone = scanStandalone(sessions, transcripts, { rules, sinceMs: scanSince });
  const progress = readProgress(s.progress, rules);
  const lanes = readLanes(s.lanes, rules);
  const queue = readQueue(s.queue);
  const locks = readLocks(s.locks, cfg.slotCount, rules);
  const events = s.events ? theater.events.follow(s.events, now) : { ok: false };
  const [merges, after] = await Promise.all([git.merges(sinceMs), progress.base ? git.mergesAfter(progress.base) : Promise.resolve({ ok: true, merges: [] })]);
  const state = (configured, ok) => (configured ? (ok ? 'ok' : 'unavailable') : 'off');
  const sources = {
    claude: s.workflows ? (runsScan.ok || standalone.ok ? 'ok' : 'unavailable') : s.claude ? (existsSync(join(s.claude, 'projects')) ? 'ok' : 'unavailable') : 'off',
    workflows: state(Boolean(s.claude || s.workflows), runsScan.ok),
    subagents: state(Boolean(s.claude || s.subagents), standalone.ok),
    progress: state(Boolean(s.progress), progress.ok),
    lanes: state(Boolean(s.lanes), lanes.ok),
    queue: state(Boolean(s.queue), queue.ok),
    locks: state(Boolean(s.locks), locks.ok),
    git: state(Boolean(s.repo), merges.ok),
    events: s.events ? state(true, events.ok) : cfg.events?.post === false ? 'off' : 'ok',
  };
  return { now, rules, sessions, runs: runsScan.runs, workflows: { ok: runsScan.ok, agents: runsScan.agents }, standalone, progress, lanes, queue, locks, merges, after, sources };
}

/** Every agent the sources know: workflow agents, then standalone subagents. */
export const allAgents = (raw) => [...raw.workflows.agents, ...(raw.standalone?.agents || [])];

const FOREGROUND_MAX_MS = 11 * 60_000; // a foreground command times out after 10 minutes

/**
 * Whether an agent is still working at `now`, and if not when it ended and why:
 *   - result: the journal has its result or failure (or a standalone meta says finished);
 *   - run: its run has a record that ended (completed or stopped) before now;
 *   - relaunched: a newer run started the same label (rules.relaunchByLabel);
 *   - stopped: its transcript ends with "[Request interrupted by user]" and nothing after;
 *   - quiet: its transcript has been quiet longer than quietMs and nothing is in flight: no background
 *     command without its completion notice (younger than bgMaxMs) and no foreground tool still
 *     running (younger than 11 minutes).
 * Otherwise it is active; `background` lists its background commands in flight, newest first.
 */
export function agentLiveness(agent, entry, { now, quietMs, bgMaxMs }) {
  const lastActivity = Math.max(entry?.lastAt ?? 0, entry ? 0 : agent.mtimeMs ?? 0) || agent.startMs || 0;
  if (agent.hasResult) return { active: false, endMs: agent.endMs ?? agent.mtimeMs, reason: 'result', background: [] };
  if (agent.runEndMs !== null && agent.runEndMs !== undefined && agent.runEndMs <= now) return { active: false, endMs: Math.max(agent.startMs ?? 0, agent.runEndMs), reason: 'run', background: [] };
  if (agent.relaunchedAt !== null && agent.relaunchedAt !== undefined && agent.relaunchedAt <= now) return { active: false, endMs: Math.min(agent.relaunchedAt, Math.max(lastActivity, agent.startMs ?? 0)), reason: 'relaunched', background: [] };
  if (entry && entry.interruptedAt !== null && entry.interruptedAt !== undefined) return { active: false, endMs: entry.interruptedAt, reason: 'stopped', background: [] };
  const background = backgroundAt(entry, now, bgMaxMs);
  const last = entry?.uses?.length ? entry.uses[entry.uses.length - 1] : null;
  const foreground = Boolean(last && last.id && !last.background && entry.pending.has(last.id) && now - (last.at ?? now) <= FOREGROUND_MAX_MS);
  if (background.length || foreground) return { active: true, endMs: null, reason: background.length ? 'background' : 'tool', background };
  if (now - lastActivity > quietMs) return { active: false, endMs: lastActivity, reason: 'quiet', background: [] };
  return { active: true, endMs: null, reason: 'recent', background };
}

/** The end of an agent's life for the timeline: when it ended, or null while it is still working. */
export function agentEnd(agent, entry, cfg, now) {
  const l = agentLiveness(agent, entry, { now, quietMs: cfg.quietMinutes * 60_000, bgMaxMs: cfg.backgroundMaxMinutes * 60_000 });
  return l.active ? null : l.endMs;
}

// ---------------------------------------------------------------- lanes

/** Chip codes (at most 6 characters) for a tag: its first part, then shorter forms with a number. */
function chipCandidates(tag) {
  const t = publicTag(tag, 'RUN');
  const parts = t.split(/[-.]/).filter(Boolean);
  const head = parts[0] || 'RUN';
  // a short first part as it is (BUG-42 -> BUG); a long one with its next part (RELEASE-CUT -> RELCUT)
  const first = head.length <= 6 || parts.length < 2 ? head.slice(0, 6) : `${head.slice(0, 3)}${parts[1].slice(0, 3)}`;
  const out = [first];
  if (parts.length > 1) out.push(`${head.slice(0, 3)}${parts[parts.length - 1].slice(0, 3)}`);
  for (let n = 2; n < 100; n += 1) out.push(`${first.slice(0, n < 10 ? 5 : 4)}${n}`);
  return out.filter((c) => /^[A-Z0-9][A-Z0-9-]{0,5}$/.test(c));
}

/** Give each lane (sorted oldest first) a chip code unique among the lanes given; `map` keeps them stable. */
export function assignChips(lanes, map) {
  const used = new Set();
  for (const lane of lanes) {
    let chip = map.get(lane.key);
    if (!chip || used.has(chip)) {
      chip = chipCandidates(lane.tag).find((c) => !used.has(c)) || `L${used.size}`;
      map.set(lane.key, chip);
    }
    used.add(chip);
    lane.id = chip;
  }
  if (map.size > 5000) for (const k of [...map.keys()].slice(0, 1000)) map.delete(k);
  return lanes;
}

/** Stations of a workflow run from its phase titles (at most maxStations; later phases share the last). */
export function runStations(phases, maxStations = 6) {
  const list = (phases.length ? phases : ['Work']).slice(0, maxStations);
  return list.map((title, i) => ({ tag: stationTag(title), kind: stationKindOf(title, i, list.length) }));
}

const phaseIndex = (run, wfPhase, maxStations) => {
  const i = run.phases.findIndex((p) => p.toLowerCase() === String(wfPhase || '').toLowerCase());
  return Math.min(Math.max(0, i), Math.min(maxStations, Math.max(1, run.phases.length)) - 1);
};

/**
 * When a run ended for the stage: its record's end; for a run without a record whose agents have all
 * ended and that has been quiet for quietMs, its last activity (it stopped without a record).
 */
function runEndAt(run, agentEnds, now, quietMs) {
  if (run.endMs !== null) return { at: run.endMs, recorded: true };
  const ends = run.agentIds.map((id) => agentEnds.get(`${run.session}:${id}`));
  if (ends.length && ends.every((e) => e !== null && e !== undefined) && now - run.lastMs > quietMs) return { at: Math.max(...ends), recorded: false };
  return { at: null, recorded: false };
}

/**
 * The lanes of the "runs" model at time t: every run that has started by t and has not left the stage
 * (it ended less than lingerMinutes before t, or it is still running), oldest first.
 */
export function runLanesAt(raw, cfg, t, { agentEnds, chips, now = t }) {
  const quietMs = cfg.quietMinutes * 60_000;
  const lingerMs = cfg.lingerMinutes * 60_000;
  const lanes = [];
  for (const run of raw.runs) {
    if (run.startMs === null || run.startMs > t) continue;
    const end = runEndAt(run, agentEnds, now, quietMs);
    if (end.at !== null && t > end.at + (end.recorded ? lingerMs : 0)) continue;
    const stations = runStations(run.phases, cfg.pipeline.maxStations);
    const started = raw.workflows.agents.filter((a) => a.run === run.id && a.session === run.session && a.startMs !== null && a.startMs <= t).sort((a, b) => a.startMs - b.startMs);
    const latest = started[started.length - 1];
    const current = latest ? phaseIndex(run, latest.wfPhase, cfg.pipeline.maxStations) : 0;
    const ended = end.at !== null && t >= end.at;
    const status = ended ? (end.recorded ? (run.status === 'completed' ? 'completed' : 'killed') : 'idle') : 'running';
    const done = status === 'completed' ? stations.length : current;
    lanes.push({ key: `${run.session}:${run.id}`, run, tag: publicTag(run.subject || run.workflow || 'RUN', 'RUN'), stations, current: ended ? null : current, done, status, startMs: run.startMs, endMs: end.at, recorded: end.recorded });
  }
  return lanes.sort((a, b) => a.startMs - b.startMs || a.key.localeCompare(b.key));
}

/** Runs with a record that ended in [fromMs, toMs], as lanes for their done/stopped events. */
export function endedRuns(raw, fromMs, toMs, chips) {
  const out = [];
  for (const run of raw.runs) {
    if (run.endMs === null || run.endMs < fromMs || run.endMs > toMs) continue;
    const key = `${run.session}:${run.id}`;
    const tag = publicTag(run.subject || run.workflow || 'RUN', 'RUN');
    out.push({ key, run, tag, id: chips.get(key) || chipCandidates(tag)[0], endMs: run.endMs, recorded: true });
  }
  return out;
}

/** Event-API lanes at time t (live only). */
function eventLanes(theater, cfg, now) {
  const quietMs = cfg.quietMinutes * 60_000;
  const lingerMs = cfg.lingerMinutes * 60_000;
  const store = theater.events;
  const live = store.liveAgents(now, quietMs);
  const out = [];
  for (const lane of store.lanes.values()) {
    const agents = live.filter((a) => a.lane === lane.key);
    if (lane.status === 'running' && !agents.length && now - lane.lastMs > quietMs) continue;
    if (lane.status !== 'running' && now - (lane.endMs ?? lane.lastMs) > lingerMs) continue;
    const tags = lane.stations.length ? lane.stations : ['WORK'];
    const stations = tags.map((tag, i) => ({ tag, kind: stationKindOf(tag, i, tags.length) }));
    const current = agents.length ? Math.max(...agents.map((a) => a.station ?? 0)) : null;
    const done = lane.status === 'completed' ? stations.length : current ?? 0;
    out.push({ key: `ev:${lane.key}`, eventLane: lane, tag: publicTag(lane.tag || lane.key, 'LANE'), stations, current: lane.status === 'running' ? current : null, done, status: lane.status === 'running' ? 'running' : lane.status, startMs: lane.startMs, endMs: lane.endMs, recorded: true });
  }
  return out;
}

/** The lane of a job in the "jobs" model: by the rules, else from the progress file. */
export function laneOfJob(job, raw) {
  if (!job) return null;
  return laneOfJobRule(job, raw.rules || GENERIC_RULES) || raw.progress.jobs.get(job)?.lane || null;
}

/** Queue slugs that may be shown as-is (branch names of queued work). */
export function knownSlugs(raw) {
  return new Set(raw.queue.entries.map((e) => String(e.slug).toLowerCase()).filter((s) => /^[a-z0-9][a-z0-9._-]{0,40}$/.test(s)));
}

function entryName(entry, rules) {
  return jobFromSlug(entry.slug, rules) || (typeof entry.id === 'string' && /^[A-Z0-9][A-Z0-9-]{0,40}$/.test(entry.id) ? entry.id : null) || entry.slug;
}

/** Jobs merged into the branch after the progress snapshot that the snapshot does not count yet. */
export function lateMerges(raw) {
  const late = new Map();
  for (const m of raw.after.merges) {
    const job = m.job;
    if (!job || late.has(job)) continue;
    const known = raw.progress.jobs.get(job);
    if (known && known.status !== 'done') late.set(job, { ...m, lane: known.lane });
  }
  return late;
}

/** The lanes of the "jobs" model: every known lane id, with its jobs' done/total. */
export function jobLanes(raw, cfg, { activeLanes = new Set(), doneShift = null } = {}) {
  const rules = raw.rules || GENERIC_RULES;
  const ids = new Set([...Object.keys(raw.progress.laneTitles || {}), ...Object.keys(cfg.pipeline.laneTitles || {}), ...Object.keys(raw.lanes.lanes || {}), ...raw.lanes.waiting].filter((id) => rules.laneId.test(id)));
  for (const job of raw.progress.jobs.values()) if (job.lane) ids.add(job.lane);
  for (const id of activeLanes) if (rules.laneId.test(id)) ids.add(id);
  const counts = {};
  for (const job of raw.progress.jobs.values()) {
    if (!job.lane) continue;
    counts[job.lane] ||= { done: 0, total: 0 };
    counts[job.lane].total += 1;
    if (job.status === 'done') counts[job.lane].done += 1;
  }
  for (const m of lateMerges(raw).values()) if (counts[m.lane]) counts[m.lane].done += 1;
  const waiting = new Set(raw.lanes.waiting);
  const stations = cfg.pipeline.stations.slice(0, cfg.pipeline.maxStations).map((s) => ({ tag: stationTag(s.tag), kind: ['setup', 'coder', 'reviewer', 'fixer', 'preparer'].includes(s.kind) ? s.kind : 'coder' }));
  return [...ids].sort().map((id) => {
    const job = raw.lanes.lanes[id]?.job || null;
    let done = raw.progress.ok ? counts[id]?.done ?? 0 : null;
    if (done !== null && doneShift) done = Math.max(0, done - doneShift(id));
    const total = raw.progress.ok ? counts[id]?.total ?? 0 : null;
    const active = Boolean(raw.lanes.lanes[id]) || activeLanes.has(id);
    return {
      key: `lane:${id}`,
      id,
      tag: publicTag(id, 'LANE'),
      title: cfg.pipeline.laneTitles?.[id] || raw.progress.laneTitles?.[id] || null,
      stations,
      current: null,
      done: 0,
      status: active ? 'running' : waiting.has(id) ? 'waiting' : total && done === total ? 'completed' : 'idle',
      show: active,
      active,
      waiting: waiting.has(id),
      job,
      progress: done !== null && total !== null ? { done, total } : null,
    };
  });
}

export function projectTotals(raw) {
  if (!raw.progress.ok) return { done: null, total: null };
  return { done: raw.progress.totals.done + lateMerges(raw).size, total: raw.progress.totals.total };
}

/** Tracked features done/total: feature jobs done in the snapshot plus feature jobs merged since. */
export function featureTotals(raw) {
  if (!raw.progress.ok || !Number.isFinite(raw.progress.totals.features) || raw.progress.totals.features <= 0) return null;
  let late = 0;
  for (const m of lateMerges(raw).values()) if (raw.progress.jobs.get(m.job)?.kind === 'feature') late += 1;
  return { done: raw.progress.totals.featuresDone + late, total: raw.progress.totals.features };
}

/** The runs model's counters: runs completed/started and agents finished/started in the last countHours. */
export function runCounters(raw, cfg, t) {
  const from = t - cfg.countHours * 3600_000;
  const runs = raw.runs.filter((r) => r.startMs !== null && r.startMs >= from && r.startMs <= t);
  const agents = raw.workflows.agents.filter((a) => a.startMs !== null && a.startMs >= from && a.startMs <= t);
  return {
    done: runs.filter((r) => r.status === 'completed' && r.endMs !== null && r.endMs <= t).length,
    total: runs.length,
    features: { done: agents.filter((a) => a.hasResult && a.endMs !== null && a.endMs <= t).length, total: agents.length },
  };
}

// ---------------------------------------------------------------- agents

function agentTitle(agent, raw, batch) {
  if (agent.job && !agent.runJob) {
    const fromProgress = raw.progress.jobs.get(agent.job)?.title;
    if (fromProgress) return fromProgress;
    const entry = raw.queue.entries.find((e) => jobFromSlug(e.slug, raw.rules) === agent.job);
    if (entry?.title) return String(entry.title);
    return agent.job;
  }
  if (agent.role === 'merger' && !agent.runJob) return batch ? `Merge batch ${batch.n}` : 'Merge batch';
  if (agent.standalone) return agent.tag || 'AGENT';
  return safeLabel(agent.label);
}

function holderIs(owner, agent, commandOwner) {
  if (!owner?.holder) return false;
  const h = owner.holder.toLowerCase();
  if (commandOwner && h === String(commandOwner).toLowerCase()) return true;
  if (agent.job && h === agent.job.toLowerCase()) return true;
  return agent.role === 'merger' && /merge/.test(h);
}

/**
 * The action of a background command an agent waits on: what the command really does (tests, a live
 * check, a measurement, a build, containers), inside its booth when the lock files say it holds one,
 * or waiting for a booth when it does not yet.
 */
function backgroundAction(agent, b, locks) {
  if (b.wait === 'slot') {
    const holds = b.exclusive ? holderIs(locks.exclusive, agent, b.owner) : locks.slots.some((s) => holderIs(s.owner, agent, b.owner));
    if (!holds) return { kind: 'wait', waitFor: 'slot', use: b, background: true };
    return { kind: b.kind === 'wait' || b.kind === 'think' ? 'test' : b.kind, waitFor: null, use: b, detail: b.detail || 'check', background: true, inSlot: holds };
  }
  if (b.wait === 'lock') return { kind: 'wait', waitFor: 'lock', use: b, background: true };
  return { kind: b.kind === 'think' || b.kind === 'wait' ? 'run' : b.kind, waitFor: null, use: b, detail: b.detail || null, background: true };
}

/** An agent waits on its background run when its last tool only polls, or launched it, or finished a while ago. */
function waitsOnBackground(last, entry, b, now) {
  if (!last) return true;
  if (last.poll || last.wait === 'task' || last.id === b.id) return true;
  const pending = Boolean(last.id && entry.pending.has(last.id));
  return !pending && now - (last.at ?? now) > 30_000;
}

/** Decide what a live agent is doing now from its last tool use, its background runs and the lock/slot owners. */
export function liveAction(agent, entry, { now, thinkAfterMs, locks, background = [] }) {
  const last = entry?.uses?.length ? entry.uses[entry.uses.length - 1] : null;
  // waiting on a background command: show what that command does, never "thinking". A background
  // loop that only waits for another run stands for nothing itself: the real run is the one to show.
  const work = background.find((b) => !b.poll) || null;
  if (background.length && waitsOnBackground(last, entry, work || background[0], now)) {
    if (work) return backgroundAction(agent, work, locks);
    return { kind: 'wait', waitFor: 'task', use: background[0], background: true };
  }
  if (!last) return { kind: 'think', waitFor: null, use: null };
  const pending = Boolean(last.id && entry.pending.has(last.id));
  const age = now - (last.at ?? now);
  const movedOn = Boolean(entry.lastAssistantAt && entry.lastAssistantAt > (last.at ?? 0) + 5000);
  const recent = pending || age <= thinkAfterMs;
  if (last.wait === 'lock') {
    const owner = last.lock === locks.names?.merge ? locks.merge : last.lock === locks.names?.exclusive ? locks.exclusive : null;
    if (holderIs(owner, agent, last.owner)) return { kind: recent ? 'run' : 'think', waitFor: null, use: last };
    if (!movedOn) return { kind: 'wait', waitFor: 'lock', use: last };
    return { kind: 'think', waitFor: null, use: last };
  }
  if (last.wait === 'slot') {
    const holds = last.exclusive ? holderIs(locks.exclusive, agent, last.owner) : locks.slots.some((s) => holderIs(s.owner, agent, last.owner));
    if (holds) return { kind: last.kind, waitFor: null, use: last, inSlot: true };
    if ((pending || last.background) && !movedOn) return { kind: 'wait', waitFor: 'slot', use: last };
    return { kind: recent ? last.kind : 'think', waitFor: null, use: last };
  }
  if (last.wait === 'task') return recent ? { kind: 'wait', waitFor: 'task', use: last } : { kind: 'think', waitFor: null, use: last };
  return { kind: recent ? last.kind : 'think', waitFor: null, use: last };
}

/**
 * Where an agent stands: { lane, station, place, runJob }. Runs model: its run's lane, at its phase's
 * station. Jobs model: its job's lane, at the station of its role; a merger stands at the merge
 * machine. Standalone agents and agents without a lane stand on the dock (lane null).
 */
export function placeOf(agent, raw, cfg, laneByKey) {
  if (agent.standalone) return { lane: null, station: null, place: null };
  if (runsMode(cfg)) {
    const lane = laneByKey.get(`${agent.session}:${agent.run}`);
    if (!lane) return { lane: null, station: null, place: null };
    return { lane: lane.id, station: phaseIndex(lane.run, agent.wfPhase, cfg.pipeline.maxStations), place: null };
  }
  const lane = laneOfJob(agent.job, raw);
  if (agent.role === 'merger') return { lane, station: null, place: 'merge' };
  const station = cfg.pipeline.stations.findIndex((s) => Array.isArray(s.roles) && s.roles.includes(agent.role));
  return { lane, station: lane && station >= 0 && station < cfg.pipeline.maxStations ? station : null, place: null };
}

/** Shape one agent for the public schema. */
export function agentView(agent, raw, { kind, waitFor, use, detail = null, background = false }, { publicMode, batch, sinceMs, activeAtMs, where, lane }) {
  let text = publicPhrase(kind, agent.role, waitFor, { detail: detail ?? use?.detail ?? null, background });
  if (!publicMode && use && kind !== 'think') text = use.text || text;
  const view = {
    id: agent.agentId,
    role: agent.role,
    job: agent.runJob || agent.job,
    lane: where.lane,
    station: where.station,
    stationTag: lane && where.station !== null ? lane.stations[where.station]?.tag ?? null : null,
    tag: agent.tag || null,
    title: agentTitle(agent, raw, batch),
    // a standalone subagent's description is free text: public mode shows only its tag
    label: agent.standalone ? (publicMode ? agent.tag || 'AGENT' : redact(agent.label, 60)) : publicMode ? safeLabel(agent.label) : redact(agent.label, 60),
    since: iso(sinceMs ?? agent.startMs),
    activeAt: iso(activeAtMs ?? agent.mtimeMs),
    action: { kind, text },
  };
  if (where.place) view.place = where.place;
  if (background) view.action.background = true;
  if (agent.standalone) view.standalone = true;
  if (!publicMode && use) view.action.tool = use.name;
  return view;
}

/** A workflow agent in the runs model takes its run as its job (so the stage walks it between stations). */
export function withRunJob(agent, cfg, lane) {
  if (!runsMode(cfg) || agent.standalone || !lane) return agent;
  const role = roleOfWord(agent.wfPhase);
  return { ...agent, runJob: agent.run.replace(/^wf_/, 'RUN-').toUpperCase().replace(/[^A-Z0-9-]/g, '-').slice(0, 32), role: role || agent.role };
}

function whoText(agent, publicMode) {
  if (agent.job) return `${agent.job} ${ROLE_NOUN[agent.role] || 'agent'}`;
  return publicMode ? safeLabel(agent.label) : redact(agent.label, 60);
}

const TYPE_ORDER = { queued: 0, started: 1, finished: 2, bounced: 3, merged: 4, done: 5, stopped: 6, pushed: 7 };

/**
 * All events between fromMs and toMs (inclusive), oldest first. `runLanes` (runs model) gives the
 * finished runs their done/stopped events; `pushes` lists git pushes seen in agents' transcripts.
 */
export function buildEvents(raw, fromMs, toMs, { publicMode, laneOfAgent = () => null, runLanes = [], pushes = [] }) {
  const rules = raw.rules || GENERIC_RULES;
  const events = [];
  const within = (t) => Number.isFinite(t) && t >= fromMs && t <= toMs;
  const push = (at, type, job, text, extra = {}) => events.push({ id: `${type}:${extra.key || job || ''}:${at}`, at: iso(at), atMs: at, type, job: job || null, text, ...extra });
  for (const a of raw.workflows.agents) {
    const lane = laneOfAgent(a);
    if (within(a.startMs)) push(a.startMs, 'started', a.job, `${whoText(a, publicMode)} started`, { role: a.role, lane, agent: a.agentId, key: a.agentId });
    if (a.hasResult && within(a.endMs)) push(a.endMs, 'finished', a.job, `${whoText(a, publicMode)} finished`, { role: a.role, lane, agent: a.agentId, key: a.agentId });
  }
  for (const l of runLanes) {
    if (!l.recorded || !within(l.endMs) || !l.id) continue;
    if (l.run?.status === 'completed' || l.eventLane?.status === 'completed') push(l.endMs, 'done', null, `${l.tag} done`, { lane: l.id, key: l.key });
    else push(l.endMs, 'stopped', null, `${l.tag} stopped`, { lane: l.id, key: l.key });
  }
  for (const p of pushes) if (within(p.at)) push(p.at, 'pushed', null, 'a change was pushed', { lane: p.lane, key: `${p.agent}:${p.at}` });
  for (const e of raw.queue.entries) {
    const name = entryName(e, rules);
    const job = jobFromSlug(e.slug, rules);
    const lane = typeof (e.lane ?? e.phase) === 'string' ? e.lane ?? e.phase : laneOfJob(job, raw);
    const readyAt = Date.parse(e.readyAt);
    if (within(readyAt)) push(readyAt, 'queued', job || name, `${name} queued for merge`, { slug: e.slug, lane, key: e.slug });
    for (const b of Array.isArray(e.bounces) ? e.bounces : []) {
      const at = Date.parse(b?.at);
      if (!within(at)) continue;
      const reason = !publicMode && (b.reason || b.note) ? `: ${redact(b.reason || b.note, 80)}` : '';
      push(at, 'bounced', job || name, `${name} bounced back to its lane${reason}`, { slug: e.slug, lane, key: e.slug });
    }
    if (raw.sources.git !== 'ok' && e.status === 'merged') {
      const at = Date.parse(e.mergedAt);
      if (within(at)) push(at, 'merged', job || name, `${name} merged`, { slug: e.slug, lane, key: e.slug });
    }
  }
  const slugs = knownSlugs(raw);
  for (const m of raw.merges.merges) {
    if (!within(m.at)) continue;
    const entry = raw.queue.entries.find((e) => String(e.slug).toLowerCase() === m.slug);
    const name = m.job || (entry ? entryName(entry, rules) : /^[a-z0-9][a-z0-9._-]{0,40}$/.test(m.slug) || slugs.has(m.slug) ? m.slug : 'a change');
    const lane = m.job ? laneOfJob(m.job, raw) : entry && typeof (entry.lane ?? entry.phase) === 'string' ? entry.lane ?? entry.phase : null;
    push(m.at, 'merged', m.job || name, `${name} merged`, { slug: m.slug, lane, key: m.slug });
  }
  events.sort((a, b) => a.atMs - b.atMs || (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9));
  return events;
}

export function stripEvent({ atMs, ...rest }) {
  return rest;
}

/** Git pushes in the parsed transcripts of the agents given: [{ at, agent, lane }]. */
export function pushesOf(theater, agents, laneOfAgent) {
  const out = [];
  for (const a of agents) {
    const entry = theater.transcripts.entries.get(a.transcript);
    if (!entry) continue;
    for (const u of entry.uses) if (u.push && Number.isFinite(u.at)) out.push({ at: u.at, agent: a.agentId, lane: laneOfAgent(a) });
  }
  return out;
}

/** One queue entry in the public schema; `status` and `t` let replay show a past status. */
export function entryView(e, raw, publicMode, status = String(e.status || 'ready'), t = Infinity) {
  const job = jobFromSlug(e.slug, raw.rules);
  const bounces = (Array.isArray(e.bounces) ? e.bounces : []).filter((b) => !Number.isFinite(t) || Date.parse(b?.at) <= t);
  const view = {
    slug: e.slug,
    id: entryName(e, raw.rules),
    lane: typeof (e.lane ?? e.phase) === 'string' ? e.lane ?? e.phase : laneOfJob(job, raw),
    status,
    title: typeof e.title === 'string' ? e.title : null,
    kind: typeof e.kind === 'string' ? e.kind : null,
    bounces: bounces.length,
    readyAt: iso(Date.parse(e.readyAt)),
  };
  if (!publicMode && bounces.length) {
    const last = bounces[bounces.length - 1];
    view.lastBounce = redact(last?.reason || last?.note || '', 80) || null;
  }
  return view;
}

export function batchView(b) {
  return b ? { n: Number(b.n), slugs: Array.isArray(b.slugs) ? b.slugs : [], startedAt: iso(Date.parse(b.startedAt)), status: 'running' } : null;
}

/** The queue as the belt shows it: waiting work always, finished work for `recentMs` after it settled. */
export function queueView(raw, now, recentMs, publicMode) {
  const entries = [];
  for (const e of raw.queue.entries) {
    const settled = Date.parse(e.mergedAt || e.updatedAt);
    if ((e.status === 'merged' || e.status === 'dropped') && !(Number.isFinite(settled) && now - settled <= recentMs)) continue;
    entries.push(entryView(e, raw, publicMode));
  }
  const running = raw.queue.batches.filter((b) => b.status === 'running').at(-1) || null;
  const finished = raw.queue.batches.filter((b) => b.status !== 'running').at(-1) || null;
  return {
    entries,
    batch: batchView(running),
    lastBatch: finished ? { n: Number(finished.n), status: String(finished.status || ''), finishedAt: iso(Date.parse(finished.finishedAt)) } : null,
  };
}

function ownerView(owner, publicMode, slugs, raw) {
  if (!owner) return null;
  const holder = displayHolder(owner.holder, { publicMode, knownSlugs: slugs, rules: raw.rules });
  const job = jobFromSlug(owner.holder, raw.rules);
  return { holder, job, lane: laneOfJob(job, raw), since: owner.since };
}

/**
 * Test booths, the exclusive hold and the merge lock. With a locks source they come from its owner
 * files; without one, the booths hold the agents running tests or checks in the background now.
 */
export function locksView(raw, cfg, publicMode, agents = []) {
  const slugs = knownSlugs(raw);
  if (!raw.locks.ok && cfg.sources.locks) {
    return { slots: Array.from({ length: cfg.slotCount }, (_, i) => ({ n: i + 1, holder: null, job: null, lane: null, since: null, unavailable: true })), exclusive: null, lock: null };
  }
  if (!raw.locks.ok) {
    const testing = agents.filter((a) => a.action.background && (a.action.kind === 'test' || a.action.kind === 'browser'));
    const seen = new Set();
    const holders = testing.filter((a) => {
      const k = a.lane || a.tag || a.id;
      return seen.has(k) ? false : seen.add(k);
    });
    return {
      slots: Array.from({ length: cfg.slotCount }, (_, i) => {
        const a = holders[i];
        return a ? { n: i + 1, holder: a.lane || a.tag || 'agent', job: a.job, lane: a.lane, since: a.activeAt } : { n: i + 1, holder: null, job: null, lane: null, since: null };
      }),
      exclusive: null,
      lock: null,
    };
  }
  return {
    slots: raw.locks.slots.map((s) => ({ n: s.n, ...(ownerView(s.owner, publicMode, slugs, raw) || { holder: null, job: null, lane: null, since: null }) })),
    exclusive: ownerView(raw.locks.exclusive, publicMode, slugs, raw),
    lock: ownerView(raw.locks.merge, publicMode, slugs, raw),
  };
}

/** The lanes in the public schema (show and active decided by the caller). */
export function laneView(l) {
  return { id: l.id, tag: l.tag, stations: l.stations.map((s) => ({ tag: s.tag, kind: s.kind })), current: l.current ?? null, done: l.done ?? 0, status: l.status, show: Boolean(l.show), active: Boolean(l.active), progress: l.progress ?? { done: l.done ?? 0, total: l.stations.length } };
}

// ---------------------------------------------------------------- the live state

/** The live state (schema documented in docs/API.md). */
export async function buildLiveState(theater, { now = Date.now(), publicMode = true } = {}) {
  const { cfg, transcripts } = theater;
  const eventsFrom = now - cfg.eventsHours * 3600_000;
  const raw = await collect(theater, { sinceMs: eventsFrom, now });
  raw.locks.names = theater.rules.locks;
  const quietMs = cfg.quietMinutes * 60_000;
  const bgMaxMs = cfg.backgroundMaxMinutes * 60_000;
  const thinkAfterMs = cfg.thinkAfterSeconds * 1000;
  const queue = queueView(raw, now, cfg.recentQueueMinutes * 60_000, publicMode);
  // liveness of every workflow agent (ends are needed to tell a stopped run from a running one)
  const live = [];
  const agentEnds = new Map();
  for (const agent of allAgents(raw)) {
    if (agent.mtimeMs === null) continue;
    const old = now - agent.mtimeMs > Math.max(quietMs, bgMaxMs);
    // a transcript untouched for longer than the longest background run cannot be live; skip reading it
    const entry = agent.hasResult || old ? null : transcripts.get(agent.transcript);
    const life = agent.hasResult ? { active: false, endMs: agent.endMs } : old ? { active: false, endMs: agent.runEndMs ?? agent.mtimeMs } : agentLiveness(agent, entry, { now, quietMs, bgMaxMs });
    agentEnds.set(`${agent.session}:${agent.agentId}`, life.active ? null : life.endMs);
    if (life.active) live.push({ agent, entry, life });
  }
  // lanes
  let lanes;
  if (runsMode(cfg)) {
    lanes = runLanesAt(raw, cfg, now, { agentEnds, chips: theater.chips, now });
  } else {
    const active = new Set(live.map(({ agent }) => laneOfJob(agent.job, raw)).filter(Boolean));
    lanes = jobLanes(raw, cfg, { activeLanes: active });
  }
  const evLanes = eventLanes(theater, cfg, now);
  if (runsMode(cfg)) assignChips([...lanes, ...evLanes].sort((a, b) => a.startMs - b.startMs), theater.chips);
  else assignChips(evLanes, theater.chips);
  const laneByKey = new Map([...lanes, ...evLanes].map((l) => [l.key, l]));
  const laneById = new Map([...lanes, ...evLanes].map((l) => [l.id, l]));
  const agents = [];
  for (const { agent: a0, entry, life } of live) {
    const lane0 = runsMode(cfg) && !a0.standalone ? laneByKey.get(`${a0.session}:${a0.run}`) : null;
    const agent = withRunJob(a0, cfg, lane0);
    const where = placeOf(agent, raw, cfg, laneByKey);
    const action = liveAction(agent, entry, { now, thinkAfterMs, locks: raw.locks, background: life.background });
    agents.push(agentView(agent, raw, action, { publicMode, batch: queue.batch, activeAtMs: Math.max(agent.mtimeMs, entry?.lastAt ?? 0), where, lane: where.lane ? laneById.get(where.lane) : null }));
  }
  // event-API agents
  for (const a of theater.events.liveAgents(now, quietMs)) {
    const lane = a.lane ? laneByKey.get(`ev:${a.lane}`) : null;
    const station = lane ? Math.min(a.station ?? 0, lane.stations.length - 1) : null;
    const role = theater.events.roleOf(a);
    const kind = now - a.actionAt > thinkAfterMs && a.kind !== 'wait' ? 'think' : a.kind;
    agents.push({ id: `ev-${a.id}`.slice(0, 80), role, job: lane ? `EV-${lane.id}` : null, lane: lane ? lane.id : null, station, stationTag: lane && station !== null ? lane.stations[station].tag : null, tag: a.tag ? publicTag(a.tag) : null, title: a.tag ? publicTag(a.tag) : 'AGENT', label: publicMode ? (a.tag ? publicTag(a.tag) : 'agent') : redact(a.text || a.id, 60), since: iso(a.startMs), activeAt: iso(a.lastMs), action: { kind, text: !publicMode && a.text ? a.text : publicPhrase(kind, role, kind === 'wait' ? 'task' : null) } });
  }
  agents.sort((a, b) => String(a.lane ?? '~').localeCompare(String(b.lane ?? '~')) || String(a.since).localeCompare(String(b.since)));
  const allLanes = [...lanes, ...evLanes];
  const onLane = new Set(agents.filter((a) => a.lane && a.station !== null).map((a) => a.lane));
  const withAgents = new Set(agents.map((a) => a.lane).filter(Boolean));
  for (const l of allLanes) {
    if (runsMode(cfg) || l.key.startsWith('ev:')) {
      l.active = onLane.has(l.id);
      l.show = true;
    } else {
      l.active = l.active || withAgents.has(l.id);
      l.show = l.active;
    }
  }
  // events
  const laneOfAgent = (a) => {
    if (runsMode(cfg)) return laneByKey.get(`${a.session}:${a.run}`)?.id ?? theater.chips.get(`${a.session}:${a.run}`) ?? null;
    return laneOfJob(a.job, raw);
  };
  const ended = runsMode(cfg) ? [...endedRuns(raw, eventsFrom, now, theater.chips), ...evLanes] : evLanes;
  const pushes = pushesOf(theater, live.map((x) => x.agent), laneOfAgent);
  const events = buildEvents(raw, eventsFrom, now, { publicMode, laneOfAgent, runLanes: ended, pushes }).slice(-cfg.maxEvents).map(stripEvent);
  // counters
  let project;
  if (runsMode(cfg)) {
    const c = runCounters(raw, cfg, now);
    project = { name: cfg.projectName, done: c.done, total: c.total, features: c.features, batch: allLanes.filter((l) => l.status === 'running').length };
  } else {
    const totals = projectTotals(raw);
    project = { name: cfg.projectName, done: totals.done, total: totals.total, features: featureTotals(raw), batch: queue.batch ? queue.batch.n : null };
  }
  if (theater.events.progress) Object.assign(project, { done: theater.events.progress.done, total: theater.events.progress.total });
  project.labels = { ...cfg.counters };
  return {
    now: iso(now),
    mode: 'live',
    sample: false,
    public: publicMode,
    project,
    pipeline: { model: cfg.pipeline.lanes, stations: cfg.pipeline.stations.slice(0, cfg.pipeline.maxStations).map((s) => ({ tag: stationTag(s.tag), kind: s.kind })), lanes: allLanes.map(laneView) },
    agents,
    queue,
    ...locksView(raw, cfg, publicMode, agents),
    events,
    yard: { labels: { ...cfg.yard.labels } },
    sources: raw.sources,
  };
}
