// Time-lapse: rebuilds a past window as events plus evenly spaced state frames, so the stage can play
// them compressed into 15-60 s with the same renderer it uses for live state.
import { IDLE_MERGER_ID, entryStateAt, idleMerger, releasesViewAt } from './releases.mjs';
import { publicTag } from './rules.mjs';
import {
  agentEnd,
  agentView,
  allAgents,
  assignChips,
  batchView,
  buildEvents,
  collect,
  endedRuns,
  entryView,
  featureTotals,
  jobLanes,
  laneOfJob,
  laneView,
  lateMerges,
  rememberAgents,
  locksView,
  placeOf,
  projectTotals,
  pushesOf,
  queueView,
  runCounters,
  runLanesAt,
  stripEvent,
  withRelease,
  withRunJob,
} from './state.mjs';
import { backgroundAt, saidAt, useAt } from './transcripts.mjs';

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const LONG_KINDS = new Set(['test', 'docker', 'browser', 'run']);

/**
 * What an agent was doing at time t, from its tool-use history (no lock owners are known for the past).
 * With its transcript entry, a background command in flight at t that the agent was waiting on (its
 * last tool only polled, launched it, or finished more than 30 s before) shows as what that command does.
 */
export function replayAction(uses, t, thinkAfterMs, entry = null, bgMaxMs = 3 * 3600_000) {
  const use = useAt(uses, t);
  const bg = entry ? backgroundAt(entry, t, bgMaxMs).filter((b) => !b.poll) : [];
  if (bg.length && (!use || use.poll || use.wait === 'task' || use.id === bg[0].id || t - use.at > 30_000)) {
    const b = bg[0];
    if (b.wait === 'lock') return { kind: 'wait', waitFor: 'lock', use: b, background: true };
    if (b.wait === 'slot') return { kind: b.kind === 'wait' || b.kind === 'think' ? 'test' : b.kind, waitFor: null, use: b, detail: b.detail || 'check', background: true, inSlot: true };
    return { kind: b.kind === 'wait' || b.kind === 'think' ? 'run' : b.kind, waitFor: null, use: b, detail: b.detail || null, background: true };
  }
  if (!use) return { kind: 'think', waitFor: null, use: null };
  const age = t - use.at;
  if (use.wait === 'lock') return age <= 30 * 60_000 ? { kind: 'wait', waitFor: 'lock', use } : { kind: 'think', waitFor: null, use };
  if (use.wait === 'task') return age <= 30 * 60_000 ? { kind: 'wait', waitFor: 'task', use } : { kind: 'think', waitFor: null, use };
  if (use.wait === 'slot') return age <= 30 * 60_000 ? { kind: use.kind, waitFor: null, use, inSlot: true } : { kind: 'think', waitFor: null, use };
  const limit = LONG_KINDS.has(use.kind) ? Math.max(thinkAfterMs, 10 * 60_000) : thinkAfterMs;
  return age <= limit ? { kind: use.kind, waitFor: null, use } : { kind: 'think', waitFor: null, use };
}

/**
 * The agent lives a replay frame at time t shows, for the step (prevT, t] since the previous frame:
 *   - every agent alive at t;
 *   - an agent whose whole life fell inside the step (it started after prevT and ended by t), so a
 *     short session is never skipped by a coarse time-lapse; it shows for this one frame, doing what it
 *     did last (`at` is the moment its action is read); not in the final frame of a window that ends
 *     now, which is the live state (brief: false);
 *   - but of the sessions of one job in the step, an ended one gives way to one that is alive at t or
 *     started later (the job handed over: coder to reviewer, and so on), so the stage sees the earlier
 *     session leave and the next one arrive in the same frame and plays the walk between them.
 * lives: [{ agent: { id, job, startMs }, end, ... }]. Returns [{ life, at }] in input order.
 */
export function livesInStep(lives, prevT, t, { liveEnd = null, brief: showBrief = true } = {}) {
  const picked = [];
  for (const life of lives) {
    const { agent, end } = life;
    if (agent.startMs > t) continue;
    const alive = (agent.startMs <= t && t < end) || (liveEnd !== null && end === liveEnd);
    const brief = showBrief && !alive && agent.startMs > prevT && end > prevT && end <= t;
    if (alive) picked.push({ life, at: t, alive: true });
    else if (brief) picked.push({ life, at: Math.max(agent.startMs, end - 1), alive: false });
  }
  const jobOf = (p) => p.life.agent.runJob || p.life.agent.job;
  return picked
    .filter((p) => {
      if (p.alive || !jobOf(p)) return true;
      return !picked.some((q) => q !== p && jobOf(q) === jobOf(p) && (q.alive || q.life.agent.startMs > p.life.agent.startMs));
    })
    .map(({ life, at }) => ({ life, at }));
}

/**
 * Queue entry status at a past time: from the entry's history with release trains (queued, integrated,
 * moved-out, merged, dropped), else from readyAt / bounces / batches / mergedAt (merge batches). Null before
 * the entry was queued. entryStateAt (releases.mjs) also gives the release.
 */
export function entryStatusAt(entry, batches, t) {
  return entryStateAt(entry, batches, t)?.status ?? null;
}

/**
 * The replay window: the last `hours` up to now, or an explicit [fromMs, toMs] window in the past.
 * Throws a RangeError with a readable message for a window it cannot serve.
 */
export function replayWindow(cfg, { now, hours, fromMs, toMs }) {
  if (fromMs !== undefined || toMs !== undefined) {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) throw new RangeError('from and to must both be ISO times');
    if (toMs <= fromMs) throw new RangeError('to must be after from');
    if (fromMs > now) throw new RangeError('the window starts in the future');
    const to = Math.min(toMs, now);
    if (to - fromMs > cfg.replay.maxHours * 3600_000) throw new RangeError(`the window is longer than ${cfg.replay.maxHours} hours`);
    if (to - fromMs < 60_000) throw new RangeError('the window is shorter than a minute');
    return { from: fromMs, to, hours: Math.round(((to - fromMs) / 3600_000) * 1000) / 1000, live: to >= now };
  }
  const h = Math.min(Math.max(Number(hours) || cfg.replay.defaultHours, 0.25), cfg.replay.maxHours);
  return { from: now - h * 3600_000, to: now, hours: h, live: true };
}

/**
 * GET /api/replay?hours=N&frames=M or /api/replay?from=<ISO>&to=<ISO>&frames=M
 *   -> { mode: "replay", from, to, hours, stepMs, events, frames: [state] }.
 * Each frame has the live schema (mode "replay") and carries the events since the previous frame. A
 * window that ends before now is rebuilt the same way; its last frame is not "now", so it has no lock
 * owners and no test-booth owners beyond what the commands show. Event-API agents are live only.
 */
export async function buildReplay(theater, { now = Date.now(), hours, frames, publicMode = true, fromMs, toMs } = {}) {
  const { cfg, transcripts } = theater;
  const runs = cfg.pipeline.lanes === 'runs';
  const win = replayWindow(cfg, { now, hours, fromMs, toMs });
  const n = Math.min(Math.max(Math.round(Number(frames) || cfg.replay.defaultFrames), 2), cfg.replay.maxFrames);
  const { from, to } = win;
  const raw = await collect(theater, { sinceMs: from, now });
  raw.locks.names = theater.rules.locks;
  rememberAgents(theater, raw);
  const thinkAfterMs = cfg.thinkAfterSeconds * 1000;
  const bgMaxMs = cfg.backgroundMaxMinutes * 60_000;
  // release trains next to the merge batches they replaced: frames play both histories
  const trains = Array.isArray(raw.queue.releases) && raw.queue.releases.length > 0;
  const recentMs = cfg.recentQueueMinutes * 60_000;

  // Agents whose lifetime overlaps the window, with their full tool-use history. A life ends at its
  // result, its run's end, its relaunch, its stop, or when its transcript went quiet with nothing in
  // flight (agentLiveness); one still working runs to now.
  const lives = [];
  const agentEnds = new Map();
  for (const a of allAgents(raw)) {
    if (a.startMs === null || a.mtimeMs === null) continue;
    const entry = a.startMs > to || a.mtimeMs < from ? null : transcripts.get(a.transcript);
    const endOrNull = agentEnd(a, entry, cfg, now);
    agentEnds.set(`${a.session}:${a.agentId}`, endOrNull);
    if (a.startMs > to || a.mtimeMs < from) continue;
    const end = endOrNull ?? now;
    if (end < from) continue;
    lives.push({ agent: a, end, uses: entry?.uses || [], entry });
  }

  const stepMs = (to - from) / (n - 1);
  const times = Array.from({ length: n }, (_, i) => (i === n - 1 ? to : Math.round(from + i * stepMs)));
  // lanes per frame first (runs model), so every lane has its chip before the events are built
  const chips = new Map();
  const lanesAt = times.map((t) => (runs ? assignChips(runLanesAt(raw, cfg, t, { agentEnds, now }), chips) : null));
  for (const life of lives) {
    if (!runs || life.agent.standalone) continue;
    const key = `${life.agent.session}:${life.agent.run}`;
    life.agent = withRunJob(life.agent, cfg, { id: chips.get(key) });
  }
  const laneOfAgent = (a) => (runs ? chips.get(`${a.session}:${a.run}`) ?? null : laneOfJob(a.job, raw));
  const pushes = pushesOf(theater, lives.map((l) => l.agent), laneOfAgent);
  const events = buildEvents(raw, from, to, { publicMode, laneOfAgent, runLanes: runs ? endedRuns(raw, from, to, chips) : [], pushes });
  const totals = projectTotals(raw);
  const features = featureTotals(raw);
  const late = lateMerges(raw);
  // Job merges that the done counter includes, so earlier frames can count them back out.
  const countedMerges = raw.merges.merges.filter((m) => m.job && (raw.progress.jobs.get(m.job)?.status === 'done' || late.has(m.job)));
  const out = [];
  let prevT = -Infinity;
  let eventIndex = 0;
  for (let i = 0; i < n; i += 1) {
    const t = times[i];
    const frameEvents = [];
    while (eventIndex < events.length && events[eventIndex].atMs <= t) {
      if (events[eventIndex].atMs > prevT) frameEvents.push(stripEvent(events[eventIndex]));
      eventIndex += 1;
    }
    const prevStepT = prevT;
    prevT = t;
    const after = countedMerges.filter((m) => m.at > t);
    const shiftByLane = {};
    for (const m of after) {
      const l = laneOfJob(m.job, raw);
      if (l) shiftByLane[l] = (shiftByLane[l] || 0) + 1;
    }
    const frameLanes = runs ? lanesAt[i] : null;
    const laneByKey = new Map((frameLanes || []).map((l) => [l.key, l]));
    const agents = [];
    const inSlot = [];
    for (const { life, at } of livesInStep(lives, i === 0 ? t : prevStepT, t, { liveEnd: i === n - 1 && win.live ? now : null, brief: !(i === n - 1 && win.live) })) {
      const { agent, uses, entry } = life;
      const action = { ...replayAction(uses, at, thinkAfterMs, entry, bgMaxMs), said: saidAt(entry, at) };
      let where = placeOf(agent, raw, cfg, laneByKey);
      // a brief session of a run that has already left the stage stands on the dock
      if (runs && where.lane && !frameLanes.some((l) => l.id === where.lane)) where = { lane: null, station: null, place: null };
      const lane = where.lane ? (frameLanes || []).find((l) => l.id === where.lane) : null;
      const view = agentView(agent, raw, action, { publicMode, batch: null, activeAtMs: action.use?.at ?? agent.startMs, atMs: at, where, lane: lane || (where.lane ? { stations: cfg.pipeline.stations } : null) });
      agents.push(view);
      if (action.inSlot && view.job) inSlot.push(view);
    }
    agents.sort((a, b) => String(a.lane ?? '~').localeCompare(String(b.lane ?? '~')) || String(a.since).localeCompare(String(b.since)));
    let lanes;
    if (runs) {
      const onLane = new Set(agents.filter((a) => a.lane && a.station !== null).map((a) => a.lane));
      lanes = frameLanes.map((l) => laneView({ ...l, show: true, active: onLane.has(l.id) }));
    } else {
      const active = new Set(agents.map((a) => a.lane).filter(Boolean));
      lanes = jobLanes(raw, cfg, { activeLanes: active, doneShift: (l) => shiftByLane[l] || 0 }).map(laneView);
    }
    const queueEntries = [];
    for (const e of raw.queue.entries) {
      const st = entryStateAt(e, raw.queue.batches, t);
      if (!st || st.status === 'merged' || st.status === 'dropped') continue;
      queueEntries.push(entryView(e, raw, publicMode, st.status, t, st.release));
    }
    const running = raw.queue.batches.find((b) => Date.parse(b.startedAt) <= t && (!Number.isFinite(Date.parse(b.finishedAt)) || t < Date.parse(b.finishedAt)));
    const frameQueue = { entries: queueEntries, batch: batchView(running) };
    // release trains: each release as it stood at t (no lock owners are known for the past)
    if (trains) Object.assign(frameQueue, releasesViewAt(raw.queue.releases, t, { publicMode, recentMs }));
    if (trains && !agents.some((a) => a.role === 'merger')) {
      const idle = idleMerger(frameQueue, { atMs: t });
      if (idle) agents.push(idle);
    }
    let project;
    if (runs) {
      const c = runCounters(raw, cfg, t);
      project = { name: cfg.projectName, done: c.done, total: c.total, features: c.features, batch: frameLanes.filter((l) => l.status === 'running').length };
    } else {
      const done = totals.done === null ? null : Math.max(0, totals.done - after.length);
      const featuresAfter = after.filter((m) => raw.progress.jobs.get(m.job)?.kind === 'feature').length;
      project = { name: cfg.projectName, done, total: totals.total, features: features ? { done: Math.max(0, features.done - featuresAfter), total: features.total } : null, batch: running ? Number(running.n) : null };
    }
    project.labels = { ...cfg.counters };
    withRelease(project, frameQueue);
    let booths;
    if (raw.locks.ok) {
      const seen = new Set();
      const booth = inSlot.filter((a) => (seen.has(a.job) ? false : seen.add(a.job))).slice(0, cfg.slotCount);
      booths = { slots: Array.from({ length: cfg.slotCount }, (_, k) => (booth[k] ? { n: k + 1, holder: booth[k].job, job: booth[k].job, lane: booth[k].lane, since: booth[k].activeAt } : { n: k + 1, holder: null, job: null, lane: null, since: null })), exclusive: null, lock: null };
    } else booths = locksView(raw, cfg, publicMode, agents);
    out.push({
      now: iso(t),
      mode: 'replay',
      sample: false,
      public: publicMode,
      project,
      pipeline: { model: cfg.pipeline.lanes, stations: cfg.pipeline.stations.map((s) => ({ tag: publicTag(s.tag), kind: s.kind })), lanes },
      agents,
      queue: frameQueue,
      ...booths,
      events: frameEvents,
      yard: { labels: { ...cfg.yard.labels } },
    });
  }
  // When the window ends now, the final frame is "now": it shows the real queue, booths and lock owners.
  if (win.live && raw.locks.ok) {
    const live = queueView(raw, now, cfg.recentQueueMinutes * 60_000, publicMode);
    const { lastBatch, ...current } = live;
    const final = out[out.length - 1];
    Object.assign(final, {
      queue: { ...current, entries: live.entries.filter((e) => e.status !== 'merged' && e.status !== 'dropped') },
      ...locksView(raw, cfg, publicMode),
    });
    if (trains) {
      // the idle merger follows the release as it is now
      const hadIdle = final.agents.some((a) => a.id === IDLE_MERGER_ID);
      final.agents = final.agents.filter((a) => a.id !== IDLE_MERGER_ID);
      const idle = hadIdle || !final.agents.some((a) => a.role === 'merger') ? idleMerger(final.queue, { atMs: now }) : null;
      if (idle) final.agents.push(idle);
      final.project = withRelease({ ...final.project, labels: { ...cfg.counters } }, final.queue);
    }
  }
  const last = out[out.length - 1];
  return {
    mode: 'replay',
    sample: false,
    public: publicMode,
    from: iso(from),
    to: iso(to),
    hours: win.hours,
    window: fromMs !== undefined,
    frameCount: out.length,
    stepMs: Math.round(stepMs),
    project: last.project,
    sources: raw.sources,
    notes: [
      runs ? 'Lanes are workflow runs, rebuilt from their journals, run records and agent transcripts.' : 'Agents, queue and merges are rebuilt from transcripts, the queue file and git history.',
      raw.locks.ok ? (win.live ? 'Test-booth occupancy in past frames is inferred from booth commands; lock owners are only known for the last frame.' : 'Test-booth occupancy is inferred from booth commands; lock owners of a past window are not known and are shown free.') : 'Test booths show agents that ran tests or checks in the background.',
    ],
    events: events.map(stripEvent),
    frames: out,
  };
}
