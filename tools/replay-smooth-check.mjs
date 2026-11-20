// QA tool: play real replay windows through the stage's world (in Node, no browser) the way a video does
// and check that the time-lapse never teleports: every agent moves at most walking speed per frame, and
// every role change of a job (the next agent of the job arriving after the last one) plays a walk from
// the last agent's spot to the new station.
//   node tools/replay-smooth-check.mjs --date 2026-11-19 --segments "10:20-10:32,12:05-12:20" [--seconds 12] [--aspect 16:9] [--out qa/marketing/smooth-check.json]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { buildReplay } from '../lib/replay.mjs';
import { createTheater } from '../lib/state.mjs';
import { SPEED, applyState, createWorld, step } from '../public/hd/hd-world.mjs';
import { parseSegments } from './render-video.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const o = { date: new Date().toISOString().slice(0, 10), segments: null, seconds: 12, aspect: '16:9', out: join(ROOT, 'qa', 'marketing', 'smooth-check.json') };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--date') (o.date = v), (i += 1);
    else if (k === '--segments') (o.segments = v), (i += 1);
    else if (k === '--seconds') (o.seconds = Number(v)), (i += 1);
    else if (k === '--aspect') (o.aspect = v), (i += 1);
    else if (k === '--out') (o.out = resolve(v)), (i += 1);
    // --config <file> is read by loadConfig() itself
    else if (k === '--config') i += 1;
    else throw new Error(`unknown option ${k}`);
  }
  if (!o.segments) throw new Error('--segments is required');
  o.segments = parseSegments(o.segments, o.date);
  return o;
}

/** Play replay frames like the stage: frames spread over `seconds`, 60 fps world steps at speed 2.5. */
export function playFrames(frames, { seconds, aspect = '16:9', fps = 60, speed = 2.5 }) {
  const w = createWorld({ aspect });
  applyState(w, frames[0], { first: true });
  const t0 = Date.parse(frames[0].now);
  const span = Date.parse(frames.at(-1).now) - t0;
  const track = new Map(); // id -> { role, job, first: {x,y,tx,ty}, last: {x,y}, maxStep, walking, appearedAt }
  let next = 1;
  let maxStep = 0;
  const limit = (SPEED.walk * speed) / fps + 1;
  const jumps = [];
  for (let i = 0; i <= seconds * fps; i += 1) {
    const sim = t0 + (i / (seconds * fps)) * span;
    while (next < frames.length && Date.parse(frames[next].now) <= sim) {
      applyState(w, frames[next]);
      next += 1;
    }
    step(w, 1 / fps, speed);
    for (const e of w.agents.values()) {
      if (e.state === 'out') continue;
      let tr = track.get(e.id);
      if (!tr) {
        tr = { id: e.id, role: e.role, job: e.job, row: e.row, first: { x: e.x, y: e.y, tx: e.tx, ty: e.ty }, last: { x: e.x, y: e.y }, walkFrames: 0, appearedAt: i / fps };
        track.set(e.id, tr);
        continue;
      }
      const d = Math.hypot(e.x - tr.last.x, e.y - tr.last.y);
      if (d > maxStep) maxStep = d;
      // a lane reshuffle (rows added or removed) moves the whole row; only count jumps within a layout
      if (d > limit) jumps.push({ id: e.id, role: e.role, at: Number((i / fps).toFixed(2)), px: Number(d.toFixed(1)) });
      tr.last = { x: e.x, y: e.y };
      if (e.walking) tr.walkFrames += 1;
    }
  }
  return { tracks: [...track.values()], maxStep, limit, jumps };
}

export async function smoothCheck(o) {
  const theater = createTheater(loadConfig());
  const report = { date: o.date, aspect: o.aspect, seconds: o.seconds, segments: [] };
  for (const sg of o.segments) {
    const data = await buildReplay(theater, { fromMs: Date.parse(sg.from), toMs: Date.parse(sg.to), frames: Math.round(o.seconds * 14), publicMode: true });
    const res = playFrames(data.frames, { seconds: o.seconds, aspect: o.aspect });
    // role changes: an agent of a job that arrived after an agent of the same job in another role
    const byJob = new Map();
    for (const t of res.tracks) if (t.job && t.row) byJob.set(t.job, [...(byJob.get(t.job) || []), t]);
    const changes = [];
    for (const [job, ts] of byJob) {
      ts.sort((a, b) => a.appearedAt - b.appearedAt);
      for (let i = 1; i < ts.length; i += 1) {
        if (ts[i].role === ts[i - 1].role || ts[i].appearedAt === 0) continue;
        const t = ts[i];
        const walked = Math.hypot(t.first.x - t.first.tx, t.first.y - t.first.ty) > 2 && t.walkFrames > 0;
        const fromSpot = Math.hypot(t.first.x - ts[i - 1].last.x, t.first.y - ts[i - 1].last.y) <= 2;
        changes.push({ job, from: ts[i - 1].role, to: t.role, at: Number(t.appearedAt.toFixed(2)), walked, fromLastSpot: fromSpot, walkFrames: t.walkFrames });
      }
    }
    report.segments.push({
      from: sg.from,
      to: sg.to,
      frames: data.frames.length,
      stepS: Math.round(data.stepMs / 1000),
      agents: res.tracks.length,
      roleChanges: changes,
      roleChangesWalked: changes.filter((c) => c.walked).length,
      maxStepPx: Number(res.maxStep.toFixed(2)),
      walkLimitPx: Number(res.limit.toFixed(2)),
      jumps: res.jumps,
    });
  }
  mkdirSync(dirname(o.out), { recursive: true });
  writeFileSync(o.out, `${JSON.stringify(report, null, 1)}\n`);
  return report;
}

if (import.meta.main) {
  try {
    const r = await smoothCheck(parseArgs(process.argv.slice(2)));
    for (const s of r.segments) console.log(`${s.from.slice(11, 16)}-${s.to.slice(11, 16)} UTC: ${s.frames} frames (${s.stepS} s apart), ${s.agents} agents, role changes ${s.roleChanges.length} (walked ${s.roleChangesWalked}), max step ${s.maxStepPx} px (walk limit ${s.walkLimitPx}), jumps ${s.jumps.length}${s.jumps.length ? ` ${JSON.stringify(s.jumps.slice(0, 5))}` : ''}`);
  } catch (e) {
    console.error(e?.stack || e);
    process.exitCode = 1;
  }
}
