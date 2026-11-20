// HD stage: layouts for every export shape, the animated world (driven only by state) and the renderer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleFullMoment, sampleStateAt } from '../lib/sample.mjs';
import { ASPECTS, MAX_ROWS_BY, PARCEL, computeLayout, laneExit, outputSize, overlaps, pathLength, podBox, queueSlot, stationGeometry, windowBox, windowSlot } from '../public/hd/hd-layout.mjs';
import { FONT } from '../public/hd/hd-font.mjs';
import { PALETTE, R, RAMP_OF } from '../public/hd/hd-palette.mjs';
import { createRenderer, dockTagText, drawCard, renderFrame, wrapCaption } from '../public/hd/hd-render.mjs';
import { CONSOLE_AT, consoleSprite } from '../public/hd/hd-stations.mjs';
import { applyState, batchWindow, createWorld, sceneFor, setAspect, step } from '../public/hd/hd-world.mjs';
import { NEUTRAL, lane, ocr, stateWith } from './client-helpers.mjs';

const cfg = { maxEvents: 60, slotCount: 4 };
const G = sampleFullMoment(); // a sample moment with every role and every console kind on stage
const ids = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8'];
const inside = (b, L) => b.x >= 0 && b.y >= 0 && b.x + b.w <= L.w && b.y + b.h <= L.h;

test('every export shape keeps the composition inside its canvas on whole pixels', () => {
  assert.deepEqual(outputSize('16:9'), { w: 1920, h: 1080 });
  assert.deepEqual(outputSize('1:1'), { w: 1440, h: 1440 });
  assert.deepEqual(outputSize('4:5'), { w: 1440, h: 1800 });
  for (const aspect of Object.keys(ASPECTS)) {
    const L = computeLayout(ids, aspect);
    assert.equal(L.rows.length, Math.min(ids.length, MAX_ROWS_BY[aspect]));
    for (let i = 1; i < L.rows.length; i += 1) assert.ok(L.rows[i].y >= L.rows[i - 1].y + L.rows[i - 1].h, 'rows do not overlap');
    for (const b of [L.ctrl, L.merge, L.rack, L.vault, L.cloud]) assert.ok(inside(b, L), `${aspect}: ${JSON.stringify(b)} inside`);
    // controller top left, lanes left of the queue column, the column ends at the merge intake
    assert.ok(L.ctrl.x < 20 && L.ctrl.y < 20);
    assert.ok(L.queue.x >= L.station.x1);
    assert.ok(L.chute.y + L.chute.h === L.queue.y1);
    // yard pieces do not overlap each other
    const pieces = { merge: L.merge, rack: L.rack, vault: L.vault, cloud: L.cloud };
    const names = Object.keys(pieces);
    for (let i = 0; i < names.length; i += 1) for (let j = i + 1; j < names.length; j += 1) assert.ok(!overlaps(pieces[names[i]], pieces[names[j]]), `${aspect}: ${names[i]} / ${names[j]}`);
    // the pipe starts at the machine's outlet side and ends at the vault
    const end = L.pipe[L.pipe.length - 1];
    assert.ok(end.x >= L.vault.x && end.x <= L.vault.x + L.vault.w && end.y >= L.vault.y && end.y <= L.vault.y + L.vault.h, `${aspect}: pipe reaches the vault`);
    assert.ok(pathLength(L.uplink) > 0);
    for (let k = 0; k < 12; k += 1) {
      const s = queueSlot(L, k, 12);
      assert.ok(s.y >= L.queue.y0 && s.y + PARCEL.h <= L.chute.y, `${aspect} slot ${k}`);
    }
    const win = windowBox(L);
    for (let j = 0; j < 4; j += 1) {
      const s = windowSlot(L, j);
      assert.ok(s.x >= win.x && s.x + PARCEL.w <= win.x + win.w && s.y >= win.y && s.y + PARCEL.h <= win.y + win.h, `${aspect} window slot ${j}`);
    }
    for (let n = 0; n < 4; n += 1) assert.ok(overlaps(podBox(L, n), L.rack));
  }
  assert.equal(computeLayout(ids, '1:1').merge.flip, true, 'stacked layouts mirror the machine');
});

test('each row divides the lane into its own stations; every console stays inside the lane', () => {
  const kinds = ['setup', 'coder', 'reviewer', 'fixer', 'preparer'];
  for (const aspect of Object.keys(ASPECTS)) for (const big of [false, true]) for (let n = 1; n <= 6; n += 1) {
    for (const last of kinds) {
      const stations = Array.from({ length: n }, (_, i) => ({ tag: `S${i}`, kind: i === n - 1 ? last : kinds[i % kinds.length] }));
      const L = computeLayout([{ id: 'W1', stations }], aspect, { big });
      const row = L.rows[0];
      assert.equal(row.n, n);
      let prevAgent = -Infinity;
      for (let i = 0; i < n; i += 1) {
        const st = stationGeometry(L, row, i);
        assert.ok(st.agent.x > prevAgent + 40, `${aspect} n=${n}: agents ${i} apart`);
        prevAgent = st.agent.x;
        assert.ok(Number.isInteger(st.agent.x) && Number.isInteger(st.pad.x));
        const at = CONSOLE_AT[st.kind];
        if (at) assert.ok(st.x + at.dx + st.shift + consoleSprite(st.kind).w <= L.station.x1 + 2, `${aspect} n=${n} ${st.kind}: console inside the lane`);
        assert.ok(st.pad.x >= L.station.x - 6, `${aspect} n=${n}: pad inside`);
      }
    }
  }
  // six stations at most; more are ignored
  const many = Array.from({ length: 9 }, (_, i) => ({ tag: `S${i}`, kind: 'coder' }));
  assert.equal(computeLayout([{ id: 'W1', stations: many }]).rows[0].n, 6);
});

test('the header shows the station tags when every row shares them; otherwise each row has its own plates', () => {
  const a = [['PLAN', 'setup'], ['BUILD', 'coder'], ['REVIEW', 'reviewer']];
  const b = [['DRAFT', 'coder'], ['REVIEW', 'reviewer']];
  const shared = computeLayout([lane('W1', a), lane('W2', a)]);
  assert.equal(shared.perRow, false);
  assert.deepEqual(shared.header.map((h) => h.label), ['PLAN', 'BUILD', 'REVIEW']);
  const mixed = computeLayout([lane('W1', a), lane('W2', b)]);
  assert.equal(mixed.perRow, true);
  assert.deepEqual(mixed.header, []);
  // with no rows the header shows the pipeline's default stations
  assert.deepEqual(computeLayout([], '16:9', { stations: b.map(([tag, kind]) => ({ tag, kind })) }).header.map((h) => h.label), ['DRAFT', 'REVIEW']);
  // per-row plates are drawn on each row's face, readable
  const w = createWorld();
  applyState(w, stateWith({ lanes: [lane('W1', a), lane('W2', b)] }), { first: true });
  const f = renderFrame(createRenderer(), w, {});
  const row = w.layout.rows[1];
  const words = ocr(f, w.layout.station.x, w.layout.station.x1, row.face - 1, row.face + 8, [R.steel[1], R.mint[3]]);
  assert.deepEqual(words, ['DRAFT', 'REVIEW']);
});

test('every role has its place: its lane station, the merge machine and the dock', () => {
  const state = sampleStateAt(cfg, G);
  const w = createWorld();
  applyState(w, state, { first: true });
  const L = w.layout;
  const roles = new Set([...w.agents.values()].map((e) => e.role));
  for (const r of ['setup', 'coder', 'reviewer', 'fixer', 'preparer', 'merger', 'verifier', 'helper']) assert.ok(roles.has(r), r);
  for (const e of w.agents.values()) {
    const src = state.agents.find((a) => a.id === e.id);
    if (e.place === 'lane') {
      const st = stationGeometry(L, L.rowById.get(e.row), e.station);
      assert.equal(Math.round(e.x), st.agent.x);
      assert.equal(e.row, src.lane);
      assert.equal(e.station, src.station);
    } else if (e.role === 'merger') {
      assert.equal(e.place, 'merge');
      assert.ok(Math.abs(e.x - L.merger.x) < 40);
    } else {
      assert.equal(e.place, 'dock');
      assert.equal(e.y, L.dock.y);
    }
  }
  const inLanes = state.agents.filter((a) => a.lane && Number.isInteger(a.station));
  assert.equal([...w.agents.values()].filter((e) => e.place === 'lane').length, inLanes.length, 'no invented agents');
});

test('placement: a station past the lane end is clamped, a lane without a row sends its agent to the dock', () => {
  const lanes = [lane('API', [['PLAN', 'setup'], ['BUILD', 'coder']])];
  const agents = [
    { id: 'a1', role: 'coder', lane: 'API', station: 9, action: { kind: 'edit' } },
    { id: 'a2', role: 'reviewer', lane: 'GONE', station: 1, action: { kind: 'read' } },
    { id: 'a3', role: 'helper', lane: null, station: null, tag: 'DOCS-SYNC', action: { kind: 'read' } },
    { id: 'a4', role: 'merger', place: 'merge', action: { kind: 'test' } },
    { id: 'a5', role: 'coder', lane: 'bad id!', station: 0, action: { kind: 'edit' } },
  ];
  const scene = sceneFor(stateWith({ lanes, agents }));
  const at = Object.fromEntries(scene.agents.map((a) => [a.id, [a.place, a.row ?? null, a.station ?? null]]));
  assert.deepEqual(at.a1, ['lane', 'API', 1]);
  assert.equal(at.a2[0], 'dock');
  assert.equal(at.a3[0], 'dock');
  assert.equal(at.a4[0], 'merge');
  assert.equal(at.a5[0], 'dock', 'an invalid lane id is ignored');
});

test('lanes are validated; rows prefer staffed then active lanes and keep the server order', () => {
  const lanes = [
    lane('W1', [['A', 'setup']], { active: false }),
    lane('W2', [['A', 'setup']], { active: true }),
    { id: 'not a lane', stations: [] },
    lane('W3', [['A', 'setup']], { active: false }),
    lane('W4', [['A', 'setup']], { active: false, show: false }),
    lane('W5', [['A', 'setup']], { active: false }),
  ];
  const agents = [{ id: 'x', role: 'coder', lane: 'W5', station: 0, action: { kind: 'edit' } }];
  const scene = sceneFor(stateWith({ lanes, agents }), 2);
  assert.deepEqual(scene.rowIds, ['W2', 'W5'], 'staffed W5 and active W2, in server order');
  assert.deepEqual(sceneFor(stateWith({ lanes, agents }), 8).rowIds, ['W1', 'W2', 'W3', 'W5'], 'hidden and invalid lanes never get a row');
  // hues: unique among rows and stable when other lanes come and go
  const w = createWorld();
  applyState(w, stateWith({ lanes, agents }), { first: true });
  const before = w.hues.get('W5');
  assert.equal(new Set(w.hues.values()).size, w.hues.size);
  applyState(w, stateWith({ lanes: lanes.filter((l) => l.id !== 'W1'), agents }));
  assert.equal(w.hues.get('W5'), before);
});

test('the batch counter counts only entries still in the running batch', () => {
  // a batch of four slugs where one has bounced back to its lane: the chamber holds three
  const state = stateWith({
    lanes: ['W1', 'W2', 'W3', 'W4'].map((id) => lane(id, NEUTRAL)),
    queue: {
      entries: [
        { slug: 'run-w1-1', id: 'run-w1-1', lane: 'W1', status: 'batched', readyAt: '2026-11-19T11:00:00.000Z' },
        { slug: 'run-w2-1', id: 'run-w2-1', lane: 'W2', status: 'batched', readyAt: '2026-11-19T11:01:00.000Z' },
        { slug: 'run-w3-1', id: 'run-w3-1', lane: 'W3', status: 'bounced', readyAt: '2026-11-19T11:02:00.000Z' },
        { slug: 'run-w4-1', id: 'run-w4-1', lane: 'W4', status: 'batched', readyAt: '2026-11-19T11:03:00.000Z' },
      ],
      batch: { n: 1, slugs: ['run-w1-1', 'run-w2-1', 'run-w3-1', 'run-w4-1'], startedAt: '2026-11-19T11:10:00.000Z', status: 'running' },
    },
  });
  const scene = sceneFor(state);
  assert.deepEqual(scene.window.map((e) => e.slug), ['run-w1-1', 'run-w2-1', 'run-w4-1']);
  assert.equal(batchWindow({ window: [{ slug: 'a' }, { slug: 'b' }], byStatus: new Map([['a', { status: 'merged' }], ['b', { status: 'dropped' }]]) }).length, 0);
  const w = createWorld();
  applyState(w, state, { first: true });
  assert.equal([...w.parcels.values()].filter((p) => p.mode === 'window').length, 3, 'three parcels in the chamber');
  // and the machine's counter shows the digit 3: the drawn glyph matches the font's 3
  const f = renderFrame(createRenderer(), w, {});
  const L = w.layout;
  const gx = L.merge.x + 69 + 10;
  const gy = L.merge.y + 89 + 2;
  const drawn = [];
  for (let r = 0; r < 7; r += 1) {
    let row = '';
    for (let i = 0; i < 5; i += 1) row += f.px[(gy + r) * f.w + gx + i] === R.amber[4] ? '1' : '0';
    drawn.push(row);
  }
  assert.deepEqual(drawn, FONT['3'], 'the LCD reads 3');
});

test('a queue entry slides out of its lane; a merge flows to the vault and a packet rises to the remote', () => {
  const base = stateWith({ lanes: [lane('WEB', NEUTRAL)] });
  const w = createWorld();
  applyState(w, base, { first: true });
  const entry = { slug: 'run-web-1', id: 'run-web-1', lane: 'WEB', status: 'ready', readyAt: '2026-11-19T12:00:01.000Z' };
  applyState(w, { ...base, queue: { entries: [entry], batch: null } });
  const p = w.parcels.get('run-web-1');
  assert.equal(p.x, laneExit(w.layout, w.layout.rowById.get('WEB')).x, 'starts at the end of its lane');
  for (let i = 0; i < 600; i += 1) step(w, 1 / 60);
  const slot = queueSlot(w.layout, 0, 1);
  assert.deepEqual([Math.round(p.x), Math.round(p.y)], [slot.x, slot.y]);
  applyState(w, { ...base, queue: { entries: [{ ...entry, status: 'batched' }], batch: { n: 1, slugs: ['run-web-1'], startedAt: '2026-11-19T12:00:05.000Z', status: 'running' } } });
  for (let i = 0; i < 600; i += 1) step(w, 1 / 60);
  assert.equal(p.mode, 'window');
  applyState(w, { ...base, queue: { entries: [{ ...entry, status: 'merged', mergedAt: '2026-11-19T12:01:00.000Z' }], batch: null } });
  assert.equal(w.lastMerged, w.t, 'the machine shows pass');
  let intake = false;
  let cloud = false;
  for (let i = 0; i < 60 * 30 && !cloud; i += 1) {
    step(w, 1 / 60);
    if (w.vaultIntake > 0) intake = true;
    if (w.cloudFlash > 0 && w.cloudFlash > w.vaultIntake) cloud = true;
  }
  assert.ok(intake, 'the vault took the merge in');
  assert.ok(cloud, 'a packet reached the remote');
});

test('a finished run sends a parcel from its lane through the machine into the vault', () => {
  const base = stateWith({ lanes: [lane('API', NEUTRAL, { status: 'completed', done: 3 })] });
  const w = createWorld();
  applyState(w, base, { first: true });
  const done = { id: 'done:run-api-4:1', at: '2026-11-19T12:00:01.000Z', type: 'done', job: 'run-api-4', lane: 'API', text: 'lane API run finished' };
  applyState(w, { ...base, events: [done] });
  const p = w.parcels.get(`run:${done.id}`);
  assert.ok(p, 'a parcel leaves the lane');
  assert.equal(p.x, laneExit(w.layout, w.layout.rowById.get('API')).x);
  assert.equal(w.lastMerged, w.t, 'the machine lights');
  let intake = false;
  for (let i = 0; i < 60 * 40 && !intake; i += 1) {
    step(w, 1 / 60);
    if (w.vaultIntake > 0) intake = true;
  }
  assert.ok(intake, 'the run reached the vault');
  assert.equal(w.parcels.size, 0);
  // the same event again (the next poll) is not replayed
  applyState(w, { ...base, events: [done] });
  assert.equal(w.parcels.size, 0);
  // a run whose lane has no row lights the machine and sends the flow only
  const w2 = createWorld();
  applyState(w2, stateWith({ lanes: [] }), { first: true });
  applyState(w2, stateWith({ lanes: [], events: [{ ...done, lane: 'ZZZ' }] }));
  assert.equal(w2.parcels.size, 0);
  assert.equal(w2.flows.length, 1);
});

test('a stopped run puffs at its chip; a push sends a packet to the remote', () => {
  const base = stateWith({ lanes: [lane('CLI', NEUTRAL, { status: 'killed' })] });
  const w = createWorld();
  applyState(w, base, { first: true });
  applyState(w, { ...base, events: [{ id: 'stopped:run-cli-2:1', type: 'stopped', job: 'run-cli-2', lane: 'CLI' }, { id: 'pushed:push:1', type: 'pushed', job: null }] });
  assert.equal(w.planes.length, 0, 'no paper plane: nothing bounced');
  assert.equal(w.puffs.length, 1);
  assert.equal(w.packets.length, 1);
  let cloud = false;
  for (let i = 0; i < 60 * 20 && !cloud; i += 1) {
    step(w, 1 / 60);
    if (w.cloudFlash > 0) cloud = true;
  }
  assert.ok(cloud, 'the packet reached the remote');
});

test('a bounce flies a paper plane home to its lane chip', () => {
  const base = stateWith({ lanes: [lane('APP', NEUTRAL)] });
  const entry = { slug: 'run-app-1', id: 'run-app-1', lane: 'APP', readyAt: '2026-11-19T11:59:00.000Z' };
  const w = createWorld();
  applyState(w, { ...base, queue: { entries: [{ ...entry, status: 'batched' }], batch: { n: 1, slugs: ['run-app-1'], startedAt: '2026-11-19T11:59:30.000Z', status: 'running' } } }, { first: true });
  applyState(w, { ...base, queue: { entries: [{ ...entry, status: 'bounced' }], batch: null } });
  assert.equal(w.planes.length, 1);
  for (let i = 0; i < 60 * 3; i += 1) step(w, 1 / 60);
  assert.equal(w.planes.length, 0);
  assert.ok(w.chipFlash.has('APP'), 'the lane chip flashes red on landing');
});

test('frames use palette indices only, are deterministic in every shape, and label the sample', () => {
  for (const aspect of Object.keys(ASPECTS)) {
    const run = () => {
      const w = createWorld({ aspect });
      applyState(w, sampleStateAt(cfg, G), { first: true });
      for (let i = 0; i < 60; i += 1) step(w, 1 / 60);
      return renderFrame(createRenderer(), w, { sample: true });
    };
    const a = run();
    assert.equal(a.w, ASPECTS[aspect].w);
    assert.equal(a.h, ASPECTS[aspect].h);
    assert.ok(a.px.every((v) => v < PALETTE.length));
    assert.deepEqual(a.px, run().px, `${aspect} is deterministic`);
    const L = computeLayout([], aspect);
    assert.equal(a.px[L.tag.y * a.w + L.tag.x + 1], R.amber[3], `${aspect} SAMPLE tag`);
  }
});

test('with no agents in the state no character is drawn', () => {
  const state = { ...sampleStateAt(cfg, G), agents: [] };
  const w = createWorld();
  applyState(w, state, { first: true });
  const f = renderFrame(createRenderer(), w, {});
  const people = f.px.filter((v) => ['skin', 'tan', 'deep', 'hair', 'ink', 'blond'].includes(RAMP_OF[v].ramp)).length;
  assert.equal(people, 0);
});

test('switching the export shape rebuilds the scene at its new size', () => {
  const w = createWorld();
  applyState(w, sampleStateAt(cfg, G), { first: true });
  setAspect(w, '4:5');
  assert.equal(w.layout.w, 720);
  assert.equal(w.layout.h, 900);
  const f = renderFrame(createRenderer(), w, {});
  assert.equal(f.h, 900);
});

test('title and end cards fit their words; dock plates shorten tags generically', () => {
  assert.deepEqual(wrapCaption('agents at work!', 400), ['AGENTS AT WORK']);
  assert.equal(wrapCaption('one two three four five six', 400).join(' ').split(' ').length, 5, 'five words at most');
  assert.deepEqual(wrapCaption('AI agents building the website', 640), ['AI AGENTS BUILDING THE WEBSITE']);
  assert.deepEqual(wrapCaption('AI agents building the website', 300), ['AI AGENTS BUILDING THE', 'WEBSITE']);
  assert.deepEqual(wrapCaption('AI agents building the website', 230), ['AI AGENTS BUILDING', 'THE WEBSITE']);
  const w = createWorld();
  applyState(w, sampleStateAt(cfg, G), { first: true });
  const f = renderFrame(createRenderer(), w, {});
  drawCard(f, 'title', 0.5, { caption: 'AGENTS AT WORK', sub: 'LIVE' });
  assert.ok(f.px.includes(R.steel[4]), 'the title is drawn');
  assert.equal(dockTagText('BUILD-SITE', 60), 'BUILD-SITE');
  assert.equal(dockTagText('BUILD-SITE', 30), 'SITE');
  assert.equal(dockTagText('REL-1.2.0', 40), '1.2.0');
  assert.equal(dockTagText('LONGWORDTAG', 20), 'LON');
});

test('the controller shows the real totals with the state\'s words, and one gauge per lane', () => {
  const state = sampleStateAt(cfg, G);
  const draw = (project, batch, agents = state.agents, lanes = state.pipeline.lanes) => {
    const w = createWorld();
    applyState(w, { ...state, agents, pipeline: { ...state.pipeline, lanes }, project: { ...state.project, batch: null, ...project }, queue: { ...state.queue, batch } }, { first: true });
    const rd = createRenderer();
    const f = renderFrame(rd, w, {});
    return { f, rd, L: w.layout, onStage: [...w.agents.values()].filter((e) => e.state !== 'out').length };
  };
  const batch = { n: 7, slugs: [], startedAt: state.now, status: 'running' };
  const a = draw({ done: 123, total: 600, features: { done: 77, total: 400 } }, batch);
  const { f, L } = a;
  const cx = L.ctrl.x;
  const cy = L.ctrl.y;
  // the main LCD across the top: RUNS 123/600 [bar] 20% (floored: 123/600 is 20.5%)
  assert.deepEqual(ocr(f, cx + 66, cx + L.ctrl.w - 18, cy, cy + 13, [R.cyan[3], R.cyan[4], R.cyan[5]]), ['123/600', '20%']);
  assert.deepEqual(ocr(f, cx + 66, cx + 100, cy, cy + 13, [R.steel[0]]), ['RUNS'], 'the word comes from the state');
  assert.equal(a.rd.readout.jobs, '123/600');
  assert.equal(a.rd.readout.pct, '20%');
  // the ring's dial: the number of agents working now (every agent on stage)
  assert.ok(a.onStage > 0);
  assert.deepEqual(ocr(f, cx + 114, cx + 142, cy + 18, cy + 36, [R.cyan[4], R.cyan[5]]), [String(a.onStage)]);
  // the readout: AGENTS 77/400 and LIVE 7 (the queue's batch number when the project has none)
  assert.deepEqual(ocr(f, cx + 156, cx + 216, cy + 11, cy + 21, [R.steel[0]]), ['AGENTS']);
  assert.deepEqual(ocr(f, cx + 156, cx + 216, cy + 20, cy + 32, [R.mint[3], R.mint[4]]), ['77/400']);
  assert.deepEqual(ocr(f, cx + 156, cx + 216, cy + 31, cy + 43, [R.amber[4], R.amber[5]]), ['7']);
  // other totals draw other digits; no totals draw dashes, never invented numbers
  const b = draw({ done: 600, total: 600, features: { done: 400, total: 400 } }, null, []);
  assert.deepEqual(ocr(b.f, cx + 66, cx + L.ctrl.w - 18, cy, cy + 13, [R.cyan[3], R.cyan[4], R.cyan[5]]), ['600/600', '100%']);
  assert.deepEqual(ocr(b.f, cx + 114, cx + 142, cy + 18, cy + 36, [R.steel[0]]), ['0']);
  assert.equal(b.rd.readout.batch, '-');
  const c = draw({ done: null, total: null, features: null, labels: null }, null);
  assert.deepEqual([c.rd.readout.jobs, c.rd.readout.pct, c.rd.readout.features], ['--/--', '--%', '--/--']);
  assert.deepEqual(ocr(c.f, cx + 66, cx + L.ctrl.w - 18, cy, cy + 13, [R.cyan[3], R.cyan[4], R.cyan[5]]), ['--/--', '--%']);
  assert.deepEqual(ocr(c.f, cx + 66, cx + 100, cy, cy + 13, [R.steel[0]]), ['JOBS'], 'default words without labels');
  // the lane gauges follow each lane's progress: a finished lane is full, an empty one is not
  const full = draw({}, null, [], [lane('W1', NEUTRAL, { status: 'completed', done: 3, active: false, progress: { done: 3, total: 3 } }), lane('W2', NEUTRAL, { done: 0, active: false, progress: { done: 0, total: 3 } })]);
  const col = (fr, x) => {
    let n = 0;
    for (let y = cy + 15; y < cy + 26; y += 1) if (fr.px[y * fr.w + x] === R.mint[2] || fr.px[y * fr.w + x] === R.mint[3]) n += 1;
    return n;
  };
  assert.equal(col(full.f, cx + 67), 11, 'W1 gauge full');
  assert.equal(col(full.f, cx + 71), 0, 'W2 gauge empty');
});

test('a run merged (by the event) leaves the merge window, even if the queue file lags', () => {
  const entries = [
    { slug: 'run-api-1', id: 'run-api-1', lane: 'API', status: 'batched', readyAt: '2026-11-19T10:21:00.000Z' },
    { slug: 'run-web-1', id: 'run-web-1', lane: 'WEB', status: 'batched', readyAt: '2026-11-19T10:21:00.000Z' },
  ];
  const batch = { n: 1, slugs: ['run-api-1', 'run-web-1'], startedAt: '2026-11-19T12:10:00.000Z', status: 'running' };
  const base = stateWith({ lanes: [lane('API', NEUTRAL), lane('WEB', NEUTRAL)], queue: { entries, batch } });
  const w = createWorld();
  applyState(w, base, { first: true });
  assert.equal(w.scene.window.length, 2);
  const merged = { id: 'merged:run-api-1:1', at: '2026-11-19T12:16:07.000Z', type: 'merged', job: 'run-api-1', slug: 'run-api-1', lane: 'API', text: 'lane API merged' };
  applyState(w, { ...base, now: '2026-11-19T12:17:00.000Z', events: [merged] });
  assert.deepEqual(w.scene.window.map((e) => e.slug), ['run-web-1'], 'the merged run left the batch');
  assert.equal(w.parcels.get('run-api-1').mode, 'merging', 'and rides out of the chamber');
  assert.equal(w.lastMerged, w.t);
  // later frames that no longer carry the event still keep it out
  applyState(w, { ...base, now: '2026-11-19T12:30:00.000Z', events: [] });
  assert.deepEqual(w.scene.window.map((e) => e.slug), ['run-web-1']);
  // a run queued again after its merge is shown again
  applyState(w, { ...base, now: '2026-11-19T13:00:00.000Z', queue: { entries: [{ ...entries[0], status: 'ready', readyAt: '2026-11-19T12:50:00.000Z' }], batch: null } });
  assert.deepEqual(w.scene.belt.map((e) => e.slug), ['run-api-1']);
});

test('free text in the state is never drawn: lanes, tags and words are validated', () => {
  const state = stateWith({
    lanes: [lane('W1', [['C:/Users/x', 'coder'], ['ok', 'reviewer']], { tag: 'rm -rf /' })],
    agents: [{ id: 'a', role: 'coder', lane: 'W1', station: 0, tag: '/home/someone/secret', action: { kind: 'edit', text: 'cat /etc/passwd' } }],
    project: { done: 1, total: 2, labels: { jobs: 'my secret', features: '/etc', batch: 'OK' } },
    yard: { labels: { test: 'C:/x', merge: 'MERGE', develop: 'DONE', remote: 'https://x' } },
  });
  const w = createWorld();
  applyState(w, state, { first: true });
  assert.deepEqual(w.layout.rows[0].stations.map((s) => s.tag), ['', '']);
  assert.equal([...w.agents.values()][0].tag, null);
  assert.deepEqual(w.project.labels, { jobs: 'JOBS', features: 'FEATURES', batch: 'OK' });
  assert.deepEqual(w.yardLabels, { test: 'TEST', merge: 'MERGE', develop: 'DONE', remote: 'REMOTE' });
  assert.ok(renderFrame(createRenderer(), w, {}).px.every((v) => v < PALETTE.length));
});
