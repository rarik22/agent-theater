import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { startServer } from '../server.mjs';
import { NOW, assertStateShape, fakeExec, setupFixtures } from './helpers.mjs';

let fx;
let server;
let port;

before(async () => {
  fx = setupFixtures();
  mkdirSync(fx.cfg.publicDir, { recursive: true });
  writeFileSync(join(fx.cfg.publicDir, 'index.html'), '<!doctype html><title>stage</title><script src="app.js"></script>');
  writeFileSync(join(fx.cfg.publicDir, 'app.js'), 'console.log("stage")');
  writeFileSync(join(fx.dir, 'outside.txt'), 'must not be served');
  server = await startServer(fx.cfg, { port: 0, exec: fakeExec, now: () => NOW, onError: () => {} });
  port = server.address().port;
});

after(async () => {
  await server.stop();
  fx.cleanup();
});

function get(path, { method = 'GET', host, body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host: host || `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(body ?? undefined);
  });
}

const post = (body, headers = { 'content-type': 'application/json' }) => get('/api/events', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers });

test('binds to 127.0.0.1 only', () => {
  assert.equal(server.address().address, '127.0.0.1');
});

test('GET /api/state serves the live state as JSON', async () => {
  const res = await get('/api/state');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^application\/json/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(res.headers['content-security-policy'], /default-src 'self'/);
  const state = JSON.parse(res.body);
  assertStateShape(state);
  assert.equal(state.agents.length, 13);
  assert.equal(state.public, true);
});

test('?public=0 and ?sample=1 switch the view', async () => {
  const priv = JSON.parse((await get('/api/state?public=0')).body);
  assert.equal(priv.public, false);
  assert.ok(priv.agents.find((a) => a.id === 'a02coder').action.text.startsWith('Run backlog tests'));
  const sample = JSON.parse((await get('/api/state?sample=1')).body);
  assert.equal(sample.sample, true);
  assert.ok(sample.agents.length > 0, 'the sample has agents');
});

test('?sample=1&at=<seconds> serves the sample at a fixed moment; at is ignored for live data', async () => {
  const a = JSON.parse((await get('/api/state?sample=1&at=1795001559')).body);
  const b = JSON.parse((await get('/api/state?sample=1&at=1795001559')).body);
  assert.equal(a.now, new Date(1795001559 * 1000).toISOString());
  assert.deepEqual(a.agents, b.agents);
  const later = JSON.parse((await get('/api/state?sample=1&at=1795001659')).body);
  assert.notDeepEqual(a.agents.map((x) => x.id), later.agents.map((x) => x.id));
  const live = JSON.parse((await get('/api/state?at=1795001559')).body);
  assert.equal(live.sample, false);
  assert.notEqual(live.now, a.now);
});

test('GET /api/stream pushes state as server-sent events', async () => {
  const first = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/stream', headers: { host: `127.0.0.1:${port}` } }, (res) => {
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'], /^text\/event-stream/);
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        const m = /(?:^|\n)data: (.+)\n\n/.exec(buf);
        if (m) {
          req.destroy();
          resolve(JSON.parse(m[1]));
        }
      });
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
    req.end();
  });
  assertStateShape(first);
  assert.equal(first.mode, 'live');
});

test('GET /api/replay?from=&to= replays a past window and refuses a bad one', async () => {
  const ok = await get('/api/replay?from=2026-11-19T09:00:00Z&to=2026-11-19T11:00:00Z&frames=5');
  assert.equal(ok.status, 200);
  const r = JSON.parse(ok.body);
  assert.equal(r.from, '2026-11-19T09:00:00.000Z');
  assert.equal(r.to, '2026-11-19T11:00:00.000Z');
  assert.equal(r.frameCount, 5);
  for (const bad of ['from=2026-11-19T11:00:00Z&to=2026-11-19T10:00:00Z', 'from=yesterday&to=2026-11-19T10:00:00Z', 'from=2026-11-19T10:00:00Z']) {
    const res = await get('/api/replay?' + bad);
    assert.equal(res.status, 400, bad);
    assert.ok(JSON.parse(res.body).error);
  }
  const sample = JSON.parse((await get('/api/replay?sample=1&from=2026-11-19T09:00:00Z&to=2026-11-19T10:00:00Z&frames=4')).body);
  assert.equal(sample.frames.at(-1).now, '2026-11-19T10:00:00.000Z');
});

test('GET /api/replay returns frames', async () => {
  const res = await get('/api/replay?hours=2&frames=5');
  assert.equal(res.status, 200);
  const r = JSON.parse(res.body);
  assert.equal(r.mode, 'replay');
  assert.equal(r.frameCount, 5);
  assert.equal(r.hours, 2);
  const sample = JSON.parse((await get('/api/replay?hours=8&frames=12&sample=1')).body);
  assert.equal(sample.sample, true);
  assert.equal(sample.frameCount, 12);
});

test('GET /api/health lists the sources', async () => {
  const body = JSON.parse((await get('/api/health')).body);
  assert.equal(body.ok, true);
  assert.equal(body.sources.workflows, 'ok');
});

test('serves the stage files and nothing outside public/', async () => {
  const index = await get('/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /^text\/html/);
  assert.match(index.body, /<title>stage<\/title>/);
  const js = await get('/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /^text\/javascript/);
  assert.equal((await get('/app.js', { method: 'HEAD' })).body, '');
  for (const path of ['/../outside.txt', '/%2e%2e/outside.txt', '/..%2foutside.txt', '/%2e%2e%5coutside.txt', '/.hidden', '/missing.js', '/api/unknown']) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
    assert.ok(!res.body.includes('must not be served'), path);
  }
});

test('rejects foreign Host headers and non-GET methods', async () => {
  assert.equal((await get('/api/state', { host: 'evil.example' })).status, 421);
  assert.equal((await get('/api/state', { host: `attacker.test:${port}` })).status, 421);
  assert.equal((await get('/api/state', { host: `localhost:${port}` })).status, 200);
  const post = await get('/api/state', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});

test('shows a placeholder page until the stage is installed', async () => {
  const other = setupFixtures();
  const s = await startServer(other.cfg, { port: 0, exec: fakeExec, now: () => NOW, onError: () => {} });
  try {
    const res = await new Promise((resolve, reject) => {
      const p = s.address().port;
      request({ host: '127.0.0.1', port: p, path: '/', headers: { host: `127.0.0.1:${p}` } }, (r) => {
        let body = '';
        r.on('data', (c) => (body += c));
        r.on('end', () => resolve({ status: r.statusCode, body }));
      })
        .on('error', reject)
        .end();
    });
    assert.equal(res.status, 200);
    assert.match(res.body, /stage files/);
  } finally {
    await s.stop();
    other.cleanup();
  }
});

test('POST /api/events adds lanes and agents of other agent tools', async () => {
  const ok = await post([
    { lane: 'checkout', stations: ['Plan', 'Build', 'Test'], tag: 'checkout' },
    { agent: 'bot-1', lane: 'checkout', station: 'Build', action: 'edit', text: 'editing cart.ts for dev@example.com' },
    { agent: 'bot-2', lane: 'checkout', station: 2, role: 'verifier', action: 'test' },
  ]);
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { accepted: 3, refused: [] });
  const state = JSON.parse((await get('/api/state')).body);
  assertStateShape(state);
  const lane = state.pipeline.lanes.find((l) => l.tag === 'CHECKOUT');
  assert.deepEqual(lane.stations.map((x) => x.tag), ['PLAN', 'BUILD', 'TEST']);
  assert.equal(lane.active, true);
  const bot = state.agents.find((a) => a.id === 'ev-bot-1');
  assert.deepEqual([bot.lane, bot.station, bot.stationTag, bot.role, bot.action.kind, bot.action.text], [lane.id, 1, 'BUILD', 'coder', 'edit', 'writing code']);
  assert.equal(state.agents.find((a) => a.id === 'ev-bot-2').role, 'verifier');
  assert.ok(!JSON.stringify(state).includes('cart.ts'), 'the free text stays out of the public view');
  const priv = JSON.parse((await get('/api/state?public=0')).body);
  assert.equal(priv.agents.find((a) => a.id === 'ev-bot-1').action.text, 'editing cart.ts for ***');
  // finished agents leave; a lane marked done is completed
  await post([{ agent: 'bot-1', status: 'done' }, { agent: 'bot-2', status: 'done' }, { lane: 'checkout', status: 'done' }]);
  const after = JSON.parse((await get('/api/state')).body);
  assert.ok(!after.agents.some((a) => a.id.startsWith('ev-')));
  assert.equal(after.pipeline.lanes.find((l) => l.tag === 'CHECKOUT').status, 'completed');
  assert.ok(after.events.some((e) => e.type === 'done' && e.lane === lane.id));
  // a progress event sets the controller's counter
  await post({ progress: { done: 3, total: 10 } });
  const p = JSON.parse((await get('/api/state')).body).project;
  assert.deepEqual([p.done, p.total], [3, 10]);
});

test('POST /api/events refuses what it should', async () => {
  assert.equal((await post({ lane: 'x' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post({ lane: 'x' }, { 'content-type': 'application/json', origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('{nope', { 'content-type': 'application/json' })).status, 400);
  const bad = await post([{ lane: '../etc' }, { agent: 'a b' }, { nothing: true }]);
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(bad.body).refused.length, 3);
  const nd = await post('{"agent":"nd-1","lane":"nd","station":"Run","action":"run"}\n{"agent":"nd-2","lane":"nd","action":"read"}\n', { 'content-type': 'application/x-ndjson' });
  assert.deepEqual(JSON.parse(nd.body), { accepted: 2, refused: [] });
  assert.equal((await get('/api/events', { method: 'PUT' })).status, 405);
});
