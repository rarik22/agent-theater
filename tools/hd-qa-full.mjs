// QA for the full HD stage. Starts the theater server in-process, drives headless Chrome over the
// DevTools protocol and writes review images to qa/hd-full/<round>-*:
//   - real screenshots of the main page: 16:9 live and sample (a sample moment with every role), 1:1 and
//     4:5 live and sample;
//   - PNG exports taken from the page's x2 output canvas (what the video tool records);
//   - a check that what the page draws agrees with /api/state at the same moment (probe vs state);
//   - 4x zooms of every character, the controller, the test pods, the vault and remote, the merge
//     machine, and 3x zooms of lane rows with their own stations;
//   - walk-cycle and work-animation strips, a hand-off walk, and data-flow strips;
//   - a 15 s MP4 recorded through hd-recorder.mjs (as tools/render-video.mjs does), then played back in
//     the page to grab frames and measure how crisp the pixels stay.
// Always stops Chrome and the server.   node tools/hd-qa-full.mjs round1 [--port 8798] [--out qa/hd-full] [--config file]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { sampleStateAt } from '../lib/sample.mjs';
import { charFrame, lookFor } from '../public/hd/hd-chars.mjs';
import { clear, createFrame, toRGBA, blit } from '../public/hd/hd-gfx.mjs';
import { computeLayout, stationGeometry } from '../public/hd/hd-layout.mjs';
import { R } from '../public/hd/hd-palette.mjs';
import { createRenderer, renderFrame } from '../public/hd/hd-render.mjs';
import { applyState, createWorld, planeAt, sceneFor, step } from '../public/hd/hd-world.mjs';
import { startServer } from '../server.mjs';
import { launchChrome, sleep } from './cdp.mjs';
import { crop, decodePNG, encodePNG, montage, scaleNN } from './png.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const argOut = process.argv.indexOf('--out');
const OUT = argOut > 0 ? resolve(process.argv[argOut + 1]) : join(ROOT, 'qa', 'hd-full');
const argPort = process.argv.indexOf('--port');
const PORT = argPort > 0 ? Number(process.argv[argPort + 1]) : 8798;
const round = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'round1';
const ROLES = ['setup', 'coder', 'reviewer', 'fixer', 'preparer', 'merger', 'verifier', 'helper'];
mkdirSync(OUT, { recursive: true });
const report = { round, files: [], checks: {} };

function save(name, img) {
  const p = join(OUT, `${round}-${name}.png`);
  writeFileSync(p, encodePNG(img.w, img.h, img.data));
  report.files.push(p);
  console.log('saved', p, `${img.w}x${img.h}`);
  return p;
}
const savePng = (name, buf) => {
  const p = join(OUT, `${round}-${name}.png`);
  writeFileSync(p, buf);
  report.files.push(p);
  console.log('saved', p);
  return decodePNG(buf);
};
const logical = (img) => scaleNN(img, 1, 2);

/** A sample second around which every role stays on stage for 13 s. */
function allRolesMoment(cfg) {
  const has = (g) => {
    const roles = new Set(sampleStateAt(cfg, g).agents.map((a) => a.role));
    return ROLES.every((r) => roles.has(r));
  };
  const g0 = Math.floor(Date.now() / 1000);
  for (let g = g0; g < g0 + 14400; g += 1) {
    if (!has(g)) continue;
    let ok = true;
    for (let d = -6; d <= 6 && ok; d += 2) ok = has(g + d);
    if (ok) return g;
  }
  throw new Error('no sample moment with every role');
}

/** Compare what the page draws (probe) with /api/state fetched at the same time. */
function compareProbe(probe, state, maxRows = 8) {
  const scene = sceneFor(state, maxRows);
  const issues = [];
  const drawn = new Map(probe.agents.map((a) => [a.id, a]));
  for (const a of scene.agents) {
    const d = drawn.get(a.id);
    if (!d) {
      issues.push(`agent ${a.id} (${a.role}) is in the state but not drawn`);
      continue;
    }
    if (d.role !== a.role) issues.push(`agent ${a.id}: drawn as ${d.role}, state says ${a.role}`);
    if (a.place === 'lane' && scene.rowIds.includes(a.row) && (d.row !== a.row || d.station !== a.station)) issues.push(`agent ${a.id}: drawn at ${d.row}/${d.station}, state says ${a.row}/${a.station}`);
    if (a.place === 'merge' && d.place !== 'merge') issues.push(`merger ${a.id} not at the merge machine`);
  }
  for (const d of probe.agents) if (!scene.agents.some((a) => a.id === d.id)) issues.push(`drawn agent ${d.id} is not in the state`);
  const win = scene.window.map((e) => e.slug);
  if (JSON.stringify(win) !== JSON.stringify(probe.window)) issues.push(`merge window ${JSON.stringify(probe.window)} vs state ${JSON.stringify(win)}`);
  const belt = scene.belt.map((e) => e.slug);
  if (JSON.stringify(belt) !== JSON.stringify(probe.belt)) issues.push(`queue ${JSON.stringify(probe.belt)} vs state ${JSON.stringify(belt)}`);
  if (JSON.stringify(scene.rowIds) !== JSON.stringify(probe.rows)) issues.push(`rows ${probe.rows} vs ${scene.rowIds}`);
  for (const r of scene.rows) {
    const drawnRow = (probe.stations || []).find((x) => x.id === r.id);
    if (!drawnRow || JSON.stringify(drawnRow.tags) !== JSON.stringify(r.stations.map((st) => st.tag))) issues.push(`row ${r.id}: stations ${JSON.stringify(drawnRow && drawnRow.tags)} vs ${JSON.stringify(r.stations.map((st) => st.tag))}`);
  }
  const held = (state.slots || []).filter((s) => s && s.holder).length;
  const drawnHeld = probe.pods.filter(Boolean).length;
  if (held !== drawnHeld) issues.push(`pods held: drawn ${drawnHeld}, state ${held}`);
  if (Boolean(state.lock) !== Boolean(probe.lock)) issues.push(`lock: drawn ${probe.lock}, state ${JSON.stringify(state.lock)}`);
  const liveLanes = scene.lanes.slice(0, 16).filter((l) => l.active || l.status === 'waiting' || scene.agents.some((a) => a.lane === l.id)).map((l) => l.id);
  if (JSON.stringify(liveLanes) !== JSON.stringify(probe.lanes)) issues.push(`lane lamps ${probe.lanes} vs ${liveLanes}`);
  return { agents: scene.agents.length, drawn: probe.agents.length, window: win.length, belt: belt.length, pods: held, lock: probe.lock, issues };
}

/** Share of aligned 2x2 blocks whose four pixels match (within tol): 1.0 = perfectly crisp x2 pixels. */
function crispness(img, tol = 10) {
  let ok = 0;
  let n = 0;
  for (let y = 0; y + 1 < img.h; y += 2) for (let x = 0; x + 1 < img.w; x += 2) {
    const at = (xx, yy) => (yy * img.w + xx) * 4;
    const a = at(x, y);
    let same = true;
    for (const b of [at(x + 1, y), at(x, y + 1), at(x + 1, y + 1)]) for (let c = 0; c < 3; c += 1) if (Math.abs(img.data[a + c] - img.data[b + c]) > tol) same = false;
    if (same) ok += 1;
    n += 1;
  }
  return ok / n;
}

async function main() {
  const cfg = loadConfig();
  const G = allRolesMoment(cfg);
  const AT = G - 6; // the page starts 6 s early, so the screenshot 7 s later lands inside the window
  report.sampleAt = G;
  console.log('sample moment with every role:', G, new Date(G * 1000).toISOString());
  const server = await startServer(cfg, { port: PORT });
  const base = `http://127.0.0.1:${PORT}`;
  const { page, close } = await launchChrome({ root: ROOT });
  try {
    const shoot = async (name, path, w, h, waitS = 7) => {
      await page.goto(base + path, { width: w, height: h });
      await page.waitFor('window.__theater && window.__theater.feed.everData');
      await sleep(waitS * 1000);
      return savePng(name, await page.screenshot());
    };
    const exportPng = async (name) => {
      const url = await page.eval("(() => { window.__theater.render(performance.now(), true); return document.querySelector('canvas[aria-hidden]').toDataURL('image/png'); })()");
      return savePng(name, Buffer.from(url.split(',')[1], 'base64'));
    };
    const probeCheck = async (name, maxRows) => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const probe = await page.eval('window.__theater.probe()');
        const sample = probe.sample;
        const q = sample ? `?sample=1&at=${Math.floor(AT + (await page.eval('(performance.now() - window.__theater.feed.t0) / 1000')))}` : '';
        const state = await (await fetch(`${base}/api/state${q}`)).json();
        const probe2 = await page.eval('window.__theater.probe()');
        const res = compareProbe(probe2, state, maxRows);
        if (!res.issues.length || attempt === 3) {
          report.checks[name] = res;
          console.log('probe check', name, res.issues.length ? res.issues : 'drawn = /api/state');
          return res;
        }
        await sleep(1000);
      }
    };

    // ---- 16:9 live (with probe check and PNG export)
    const live = await shoot('live-16x9', '/?aspect=16x9&calm=0&ui=0&probe=1', 1920, 1080);
    await probeCheck('live-16x9', 8);
    await exportPng('export-live-16x9');
    const liveState = await (await fetch(`${base}/api/state`)).json();
    writeFileSync(join(OUT, `${round}-live-state.json`), JSON.stringify(liveState, null, 1));
    // ---- 16:9 sample with every role
    const sample = await shoot('sample-16x9', `/?sample=1&at=${AT}&aspect=16x9&calm=0&ui=0&probe=1`, 1920, 1080);
    const sampleProbe = await page.eval('window.__theater.probe()');
    await probeCheck('sample-16x9', 8);
    await exportPng('export-sample-16x9');
    // ---- square and portrait (screenshots and exports)
    await shoot('sample-1x1', `/?sample=1&at=${AT}&aspect=1x1&calm=0&ui=0`, 1440, 1440);
    await exportPng('export-sample-1x1');
    await shoot('live-1x1', '/?aspect=1x1&calm=0&ui=0&probe=1', 1440, 1440);
    await probeCheck('live-1x1', 6);
    await shoot('sample-4x5', `/?sample=1&at=${AT}&aspect=4x5&calm=0&ui=0`, 1440, 1800);
    await exportPng('export-sample-4x5');
    await shoot('live-4x5', '/?aspect=4x5&calm=0&ui=0&probe=1', 1440, 1800);
    await probeCheck('live-4x5', 8);

    // ---- zooms of every character (positions from the page's own probe), controller, yard
    const S = logical(sample);
    const L = computeLayout(sceneFor(sampleStateAt(cfg, G)).rows, '16:9');
    const tiles = [];
    for (const role of ROLES) {
      const a = sampleProbe.agents.find((x) => x.role === role && !x.walking);
      if (!a) continue;
      const tile = scaleNN(crop(S, a.x - 34, a.y - 58, 80, 64), 4);
      save(`zoom4-${role}`, tile);
      tiles.push(tile);
    }
    save('zoom4-characters', montage(tiles.slice(0, 4), { gap: 8 }));
    save('zoom4-characters-b', montage(tiles.slice(4), { gap: 8 }));
    save('zoom4-controller', scaleNN(crop(S, 0, 0, 300, 60), 4));
    save('zoom4-test-pods', scaleNN(crop(S, L.rack.x - 10, L.rack.y - 20, L.rack.w + 20, L.rack.h + 30), 4));
    save('zoom3-vault-remote', scaleNN(crop(S, L.vault.x - 20, L.cloud.y - 18, 140, L.vault.y + L.vault.h + 18 - (L.cloud.y - 18)), 3));
    save('zoom4-merge', scaleNN(crop(S, L.merge.x - 64, L.merge.y - 20, 240, 150), 4));

    // ---- lane rows with their own stations (each workflow's phases), sample and live
    for (const [name, img, st] of [['sample', S, sampleStateAt(cfg, G)], ['live', logical(live), liveState]]) {
      const RL = computeLayout(sceneFor(st).rows, '16:9');
      if (!RL.rows.length) continue;
      const top = RL.rows[0].y - 4;
      const last = RL.rows[Math.min(2, RL.rows.length - 1)];
      save(`zoom3-lanes-${name}`, scaleNN(crop(img, 0, top, RL.queue.x1 + 4, last.y + last.h + 4 - top), 3));
    }

    // ---- strips rendered by the same modules in Node
    // walk cycles of four roles, sprite level (x6)
    const walkRows = ['coder', 'setup', 'fixer', 'verifier'].map((role) => {
      const frames = [0, 1, 2, 3, 4, 5].map((k) => {
        const f = createFrame(38, 50);
        clear(f, R.void[2]);
        const fr = charFrame(lookFor(role, 7), { pose: 'walk', k });
        blit(f, fr.body, 2, 2);
        blit(f, fr.front, 2, 2);
        return scaleNN({ w: f.w, h: f.h, data: toRGBA(f) }, 6);
      });
      return montage(frames, { gap: 6 });
    });
    save('walk-cycles-x6', montage(walkRows, { gap: 8, vertical: true }));
    // work animation of every role, in the scene at the all-roles moment (x4, 6 frames each)
    const w = createWorld({ aspect: '16:9' });
    applyState(w, sampleStateAt(cfg, G), { first: true });
    const rd = createRenderer();
    const workRows = [];
    for (const role of ROLES) {
      const e = [...w.agents.values()].find((x) => x.role === role);
      if (!e) continue;
      const frames = [];
      const t0 = w.t;
      for (let i = 0; i < 6; i += 1) {
        while (w.t < t0 + i * 0.18) step(w, 1 / 60);
        const f = renderFrame(rd, w, { sample: true });
        frames.push(scaleNN(crop({ w: f.w, h: f.h, data: toRGBA(f) }, Math.round(e.x) - 30, Math.round(e.y) - 58, 72, 62), 3));
      }
      workRows.push(montage(frames, { gap: 6 }));
    }
    save('work-animations-x3', montage(workRows, { gap: 8, vertical: true }));
    // a hand-off walk in the scene: the next phase's agent of a run walks from the last one's station to its own
    const handoff = (() => {
      for (let g = G - 3000; g < G + 3000; g += 1) {
        const a = sampleStateAt(cfg, g);
        const b = sampleStateAt(cfg, g + 2);
        for (const prev of a.agents.filter((x) => x.lane && Number.isInteger(x.station))) {
          const next = b.agents.find((x) => x.job === prev.job && x.station === prev.station + 1);
          if (next && !a.agents.some((x) => x.id === next.id) && !b.agents.some((x) => x.id === prev.id)) return { g, lane: prev.lane, from: prev.station, to: next.station };
        }
      }
      return null;
    })();
    if (handoff) {
      const ww = createWorld({ aspect: '16:9' });
      applyState(ww, sampleStateAt(cfg, handoff.g), { first: true });
      for (let i = 0; i < 120; i += 1) step(ww, 1 / 60);
      applyState(ww, sampleStateAt(cfg, handoff.g + 2));
      const row = ww.layout.rowById.get(handoff.lane);
      const s0 = stationGeometry(ww.layout, row, handoff.from);
      const s1 = stationGeometry(ww.layout, row, handoff.to);
      const rr = createRenderer();
      const frames = [];
      for (let i = 0; i < 8; i += 1) {
        const f = renderFrame(rr, ww, { sample: true });
        frames.push(scaleNN(crop({ w: f.w, h: f.h, data: toRGBA(f) }, s0.agent.x - 30, row.y - 6, Math.min(300, s1.agent.x - s0.agent.x + 80), row.h + 6), 2));
        for (let k = 0; k < 30; k += 1) step(ww, 1 / 60);
      }
      save('walk-handoff-in-scene', montage([montage(frames.slice(0, 4), { gap: 6 }), montage(frames.slice(4), { gap: 6 })], { gap: 6, vertical: true }));
    }

    // ---- data-flow strips (sample, Node): a bounce flies home; a merge flows to the vault and the remote;
    //      a finished run leaves its lane through the machine into the vault
    const flowStrip = (find, name, frames, every, region) => {
      const g0 = Math.floor(Date.now() / 1000);
      for (let g = g0; g < g0 + 7200; g += 1) {
        const a = sampleStateAt(cfg, g);
        const b = sampleStateAt(cfg, g + 2);
        if (!find(a, b)) continue;
        const fw = createWorld({ aspect: '16:9' });
        applyState(fw, a, { first: true });
        for (let i = 0; i < 120; i += 1) step(fw, 1 / 60);
        applyState(fw, b);
        const fr = createRenderer();
        const out = [];
        for (let k = 0; k < frames; k += 1) {
          const f = renderFrame(fr, fw, { sample: true });
          const r = region(fw.layout, fw);
          out.push(scaleNN(crop({ w: f.w, h: f.h, data: toRGBA(f) }, r.x, r.y, r.w, r.h), 2));
          for (let i = 0; i < Math.round(every * 60); i += 1) step(fw, 1 / 60);
        }
        const half = Math.ceil(out.length / 2);
        save(name, montage([montage(out.slice(0, half), { gap: 6 }), montage(out.slice(half), { gap: 6 })], { gap: 6, vertical: true }));
        return g;
      }
      console.log('no moment for', name);
      return null;
    };
    const statusOf = (st, status) => new Set(st.queue.entries.filter((e) => e.status === status).map((e) => e.slug));
    flowStrip((a, b) => [...statusOf(b, 'bounced')].some((s) => statusOf(a, 'batched').has(s)), 'flow-bounce-plane', 6, 0.35, (Lw, fw) => {
      // follow the plane along its arc home
      const pl = fw.planes[0];
      const q = pl ? planeAt(fw, pl) : { x: Lw.merge.x, y: Lw.merge.y };
      return { x: Math.max(0, Math.min(Lw.w - 200, q.x - 100)), y: Math.max(0, Math.min(Lw.h - 120, q.y - 60)), w: 200, h: 120 };
    });
    flowStrip((a, b) => [...statusOf(b, 'merged')].some((s) => statusOf(a, 'batched').has(s)) && statusOf(b, 'bounced').size === 0, 'flow-merge-to-remote', 8, 0.55, (Lw) => ({ x: Lw.merge.x - 20, y: Lw.cloud.y - 16, w: Lw.w - Lw.merge.x + 20, h: Lw.merge.y + Lw.merge.h - Lw.cloud.y + 24 }));
    const newDone = (a, b) => b.events.some((e) => e.type === 'done' && e.lane && !a.events.some((x) => x.id === e.id));
    flowStrip(newDone, 'flow-run-done', 8, 0.6, (Lw) => ({ x: Lw.station.x1 - 200, y: 100, w: Lw.w - Lw.station.x1 + 200, h: Lw.h - 100 }));

    // ---- a 15 s MP4 from the main page, played back in the page to check it
    await page.goto(`${base}/?aspect=16x9&calm=0&ui=0`, { width: 1920, height: 1080 });
    await page.waitFor('window.__theater && window.__theater.feed.everData');
    await sleep(2000);
    const clip = await page.eval("import('/hd/hd-recorder.mjs').then((m) => m.record({ seconds: 15 }))", { timeout: 90_000 });
    const ext = clip.mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const videoPath = join(OUT, `${round}-record-15s.${ext}`);
    writeFileSync(videoPath, Buffer.from(clip.base64, 'base64'));
    report.files.push(videoPath);
    const check = await page.eval(`(async () => {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true;
      v.src = URL.createObjectURL(window.__lastClip);
      document.body.appendChild(v);
      await v.play();
      const want = [1.0, 6.0, 13.5];
      const frames = [];
      let lastTime = 0;
      await new Promise((resolve) => {
        const cb = (now, meta) => {
          lastTime = meta.mediaTime;
          if (want.length && meta.mediaTime >= want[0]) {
            const c = document.createElement('canvas');
            c.width = v.videoWidth; c.height = v.videoHeight;
            c.getContext('2d').drawImage(v, 0, 0);
            frames.push({ t: meta.mediaTime, png: c.toDataURL('image/png') });
            want.shift();
          }
          if (!v.ended) v.requestVideoFrameCallback(cb);
        };
        v.requestVideoFrameCallback(cb);
        v.onended = () => resolve();
        setTimeout(resolve, 25000);
      });
      return { width: v.videoWidth, height: v.videoHeight, played: Math.max(lastTime, v.currentTime), duration: v.duration, frames };
    })()`, { timeout: 60_000 });
    const metrics = [];
    for (const fr of check.frames) {
      const img = savePng(`video-frame-${fr.t.toFixed(1)}s`, Buffer.from(fr.png.split(',')[1], 'base64'));
      metrics.push({ t: Number(fr.t.toFixed(2)), crisp2x2: Number(crispness(img).toFixed(4)) });
      if (fr === check.frames[1]) save('video-frame-zoom4', scaleNN(crop(img, 1230, 760, 330, 200), 4));
    }
    const ref = crispness(live);
    report.checks.video = { file: videoPath, mime: clip.mime, bytes: clip.size, width: check.width, height: check.height, played: Number(check.played.toFixed(2)), duration: check.duration, frames: metrics, screenshotCrisp2x2: Number(ref.toFixed(4)) };
    console.log('video', report.checks.video);
  } finally {
    await close();
    await server.stop();
    writeFileSync(join(OUT, `${round}-report.json`), JSON.stringify(report, null, 1));
    await sleep(1500);
    try {
      rmSync(join(ROOT, '.qa-profiles'), { recursive: true, force: true });
    } catch {
      /* Chrome may hold the profile a moment longer; the folder is scratch */
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
