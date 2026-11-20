// What the journals say happened at given moments of a replay window: rebuilds the window the same way
// the server does (/api/replay?from&to) and, for each time asked, prints the nearest frame's agents by
// role and lane, the queue, the running batch, slot holders and the merges and bounces so far. Use it
// to check video frame grabs against the sources. Read-only.
//   node tools/replay-check.mjs [--config file] --from 2026-11-19T10:00:00Z --to 2026-11-19T13:30:00Z --frames 630 \
//        --at 2026-11-19T10:30:00Z [--at ...] [--out qa/replay/journal-check.json]
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../lib/config.mjs';
import { buildReplay } from '../lib/replay.mjs';
import { createTheater } from '../lib/state.mjs';

const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : null;
};
const ats = args.flatMap((a, i) => (a === '--at' ? [args[i + 1]] : []));
const cfg = loadConfig();
const r = await buildReplay(createTheater(cfg), { now: Date.now(), frames: Number(opt('--frames')) || 630, fromMs: Date.parse(opt('--from')), toMs: Date.parse(opt('--to')) });
const summary = (f) => {
  const roles = {};
  for (const a of f.agents) roles[a.role] = (roles[a.role] || 0) + 1;
  const byLane = {};
  for (const a of f.agents) if (a.lane) (byLane[a.lane] ||= []).push(a.station === null ? a.role : `${a.role}@${a.stationTag || a.station}`);
  return {
    at: f.now,
    agents: f.agents.length,
    roles,
    lanes: byLane,
    side: f.agents.filter((a) => !a.lane).map((a) => a.role),
    queue: f.queue.entries.map((e) => `${e.id}:${e.status}`),
    batch: f.queue.batch ? { n: f.queue.batch.n, slugs: f.queue.batch.slugs } : null,
    slots: f.slots.filter((s) => s.holder).map((s) => s.holder),
  };
};
const out = { from: r.from, to: r.to, frames: r.frameCount, stepMs: r.stepMs, notes: r.notes, events: r.events.filter((e) => ['merged', 'bounced', 'queued'].includes(e.type)).map((e) => `${e.at} ${e.type} ${e.job || e.slug || ''}`), at: [] };
for (const a of ats) {
  const t = Date.parse(a);
  const f = r.frames.reduce((best, x) => (Math.abs(Date.parse(x.now) - t) < Math.abs(Date.parse(best.now) - t) ? x : best), r.frames[0]);
  const merged = r.events.filter((e) => e.type === 'merged' && Date.parse(e.at) <= Date.parse(f.now)).map((e) => e.job || e.slug);
  out.at.push({ asked: a, ...summary(f), mergedSoFar: merged });
}
if (opt('--out')) writeFileSync(opt('--out'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
