// Agent Theater server: serves the stage (public/) and the live state of AI agents at work. Read-only
// on every data source; binds 127.0.0.1 only; zero npm dependencies.
//
//   agent-theater [--port N] [--config file]   start on http://127.0.0.1:<port> (default 8790)
//   agent-theater --once                        print a one-shot summary of the live state and exit
//
// API: GET /api/state, GET /api/stream (Server-Sent Events, every pushSeconds), GET /api/replay?hours=8,
// GET /api/health, POST /api/events (the event API, docs/EVENTS.md). Query: public=0 shows redacted tool
// descriptions (default public=1: generic phrases), sample=1 serves the labelled sample simulation.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { APP_DIR, configPath, loadConfig } from './lib/config.mjs';
import { buildReplay, replayWindow } from './lib/replay.mjs';
import { sampleReplay, sampleState } from './lib/sample.mjs';
import { buildLiveState, createTheater } from './lib/state.mjs';

const HOST = '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

// Same-origin only: the stage works offline, so nothing may load from elsewhere.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': CSP,
};

const FALLBACK_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Theater</title><style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#fff7ec;color:#2b2233;padding:24px}code{background:#ffe7c7;padding:1px 6px;border-radius:6px}</style></head>
<body><h1>Agent Theater</h1><p>The server is running, but the stage files (<code>public/index.html</code> and its modules) are not installed.</p>
<p>Live data: <a href="/api/state">/api/state</a> · stream: <code>/api/stream</code> · time-lapse: <a href="/api/replay?hours=2&amp;frames=60">/api/replay</a> · sample: <a href="/api/state?sample=1">/api/state?sample=1</a></p></body></html>`;

const flag = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback;
  return !/^(0|false|no|off)$/i.test(value);
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...BASE_HEADERS, ...headers });
  res.end(body);
}

function sendJson(req, res, status, value) {
  const body = JSON.stringify(value);
  send(res, status, req.method === 'HEAD' ? undefined : body, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
}

/** Create the HTTP server (not yet listening). `options.exec` replaces git, `options.now` the clock. */
export function createTheaterServer(cfg, options = {}) {
  const theater = createTheater(cfg, { exec: options.exec });
  const clock = options.now || Date.now;
  const publicDir = resolve(cfg.publicDir);
  const stateCache = new Map();
  const replayCache = new Map();
  const streams = new Set();

  /** Build (or reuse, for 900 ms) the state for one parameter set; concurrent callers share a build. */
  function getState(publicMode, sample, atMs = null) {
    if (sample) return Promise.resolve(sampleState(cfg, { now: atMs ?? clock(), publicMode }));
    const key = `live|${publicMode}`;
    const hit = stateCache.get(key);
    if (hit && clock() - hit.at < 900) return hit.promise;
    const promise = buildLiveState(theater, { now: clock(), publicMode });
    stateCache.set(key, { at: clock(), promise });
    promise.catch(() => stateCache.delete(key));
    return promise;
  }

  function getReplay(params) {
    if (params.sample) return Promise.resolve(sampleReplay(cfg, { now: clock(), hours: params.hours, frames: params.frames, publicMode: params.publicMode, fromMs: params.fromMs, toMs: params.toMs }));
    const key = `${params.publicMode}|${params.hours}|${params.frames}|${params.fromMs}|${params.toMs}`;
    const hit = replayCache.get(key);
    if (hit && clock() - hit.at < 15_000) return hit.promise;
    const promise = buildReplay(theater, { now: clock(), hours: params.hours, frames: params.frames, publicMode: params.publicMode, fromMs: params.fromMs, toMs: params.toMs });
    replayCache.set(key, { at: clock(), promise });
    promise.catch(() => replayCache.delete(key));
    for (const [k, v] of replayCache) if (clock() - v.at > 60_000) replayCache.delete(k);
    return promise;
  }

  function openStream(req, res, publicMode, sample) {
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    let busy = false;
    const push = async () => {
      if (busy || res.writableEnded) return;
      busy = true;
      try {
        const state = await getState(publicMode, sample);
        if (!res.writableEnded) res.write(`id: ${Date.parse(state.now) || clock()}\ndata: ${JSON.stringify(state)}\n\n`);
      } catch {
        if (!res.writableEnded) res.write(': state unavailable\n\n');
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(push, Math.max(250, cfg.pushSeconds * 1000));
    const stream = { timer, res };
    streams.add(stream);
    const close = () => {
      clearInterval(timer);
      streams.delete(stream);
    };
    req.on('close', close);
    res.on('error', close);
    push();
  }

  /**
   * POST /api/events: one JSON event, a JSON array of events, or JSON Lines. Only JSON content types are
   * accepted (a browser page elsewhere cannot send one without a preflight this server never answers),
   * and a request from a page of another origin is refused.
   */
  function receiveEvents(req, res, port) {
    const type = String(req.headers['content-type'] || '').toLowerCase();
    if (!/^application\/(json|x-ndjson|jsonl)\b/.test(type)) return sendJson(req, res, 415, { error: 'send application/json or application/x-ndjson' });
    const origin = req.headers.origin;
    if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(String(origin).toLowerCase())) return sendJson(req, res, 403, { error: 'cross-origin events are refused' });
    let size = 0;
    const chunks = [];
    let refused = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > 256 * 1024) {
        refused = true;
        sendJson(req, res, 413, { error: 'at most 256 kB per request' });
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (refused) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      let list;
      try {
        if (/x-ndjson|jsonl/.test(type)) list = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
        else {
          const v = JSON.parse(text);
          list = Array.isArray(v) ? v : [v];
        }
      } catch {
        return sendJson(req, res, 400, { error: 'the body is not valid JSON' });
      }
      const now = clock();
      const errors = [];
      list.slice(0, 500).forEach((ev, i) => {
        const why = theater.events.apply(ev, now);
        if (why) errors.push({ index: i, error: why });
      });
      stateCache.clear();
      sendJson(req, res, errors.length === list.length && list.length ? 400 : 200, { accepted: Math.min(list.length, 500) - errors.length, refused: errors });
    });
  }

  function serveStatic(req, res, pathname) {
    let path;
    try {
      path = decodeURIComponent(pathname);
    } catch {
      return send(res, 400, 'bad request', { 'content-type': 'text/plain; charset=utf-8' });
    }
    if (path.includes('\0') || path.split('/').some((seg) => seg.startsWith('.') && seg !== '')) return send(res, 404, 'not found', { 'content-type': 'text/plain; charset=utf-8' });
    if (path.endsWith('/')) path += 'index.html';
    const file = resolve(publicDir, `.${path}`);
    if (file !== publicDir && !file.startsWith(publicDir + sep)) return send(res, 404, 'not found', { 'content-type': 'text/plain; charset=utf-8' });
    let target = file;
    let st = null;
    try {
      st = statSync(target);
      if (st.isDirectory()) {
        target = join(target, 'index.html');
        st = statSync(target);
      }
    } catch {
      st = null;
    }
    if (!st || !st.isFile()) {
      if (path === '/index.html') return send(res, 200, req.method === 'HEAD' ? undefined : FALLBACK_PAGE, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return send(res, 404, 'not found', { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(target);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  const server = createServer(async (req, res) => {
    try {
      const port = server.address()?.port;
      const host = String(req.headers.host || '').toLowerCase();
      if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) {
        return send(res, 421, 'misdirected request', { 'content-type': 'text/plain; charset=utf-8' });
      }
      const url = new URL(req.url, `http://${HOST}`);
      if (req.method === 'POST' && url.pathname === '/api/events' && cfg.events?.post !== false) return receiveEvents(req, res, port);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      const publicMode = flag(url.searchParams.get('public'), true);
      const sample = flag(url.searchParams.get('sample'), false);
      // sample=1&at=<unix seconds> asks for the sample simulation at a fixed moment (QA screenshots)
      const at = Number(url.searchParams.get('at'));
      const atMs = sample && Number.isFinite(at) && at > 0 && at < 4e9 ? Math.floor(at) * 1000 : null;
      if (url.pathname === '/api/state') return sendJson(req, res, 200, await getState(publicMode, sample, atMs));
      if (url.pathname === '/api/stream') return openStream(req, res, publicMode, sample);
      if (url.pathname === '/api/replay') {
        const hours = Number(url.searchParams.get('hours')) || cfg.replay.defaultHours;
        const frames = Number(url.searchParams.get('frames')) || cfg.replay.defaultFrames;
        // ?from=<ISO>&to=<ISO> replays a past window instead of the last N hours
        const fromQ = url.searchParams.get('from');
        const toQ = url.searchParams.get('to');
        let win = {};
        if (fromQ !== null || toQ !== null) {
          win = { fromMs: Date.parse(fromQ), toMs: Date.parse(toQ) };
          try {
            replayWindow(cfg, { now: clock(), ...win });
          } catch (error) {
            return sendJson(req, res, 400, { error: error.message });
          }
        }
        return sendJson(req, res, 200, await getReplay({ hours, frames, publicMode, sample, ...win }));
      }
      if (url.pathname === '/api/health') {
        const state = sample ? null : await getState(true, false);
        return sendJson(req, res, 200, { ok: true, now: new Date(clock()).toISOString(), sources: state ? state.sources : 'sample' });
      }
      if (url.pathname.startsWith('/api/')) return sendJson(req, res, 404, { error: 'not found' });
      return serveStatic(req, res, url.pathname);
    } catch (error) {
      if (!res.headersSent) sendJson(req, res, 500, { error: 'internal error' });
      else res.destroy();
      if (options.onError) options.onError(error);
    }
  });

  const endStreams = () => {
    for (const s of streams) {
      clearInterval(s.timer);
      s.res.end();
    }
    streams.clear();
  };
  server.on('close', endStreams);
  /** Stop: end the open event streams (they never finish on their own), then close the server. */
  server.stop = () =>
    new Promise((resolveStop) => {
      endStreams();
      server.close(() => resolveStop());
      server.closeIdleConnections();
    });
  server.theater = theater;
  return server;
}

/** Start listening on 127.0.0.1 (never another interface). */
export function startServer(cfg, options = {}) {
  const server = createTheaterServer(cfg, { onError: (e) => console.error('request failed:', e?.message || e), ...options });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? cfg.port, HOST, () => resolvePromise(server));
  });
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const HELP = `Agent Theater: a live pixel-art stage of AI agents at work. Works with Claude Code.

Usage: agent-theater [--port N] [--config file] [--once] [--version]

  --port N        listen on http://127.0.0.1:N (default 8790, or "port" in the config)
  --config file   read this config file (default: ./agent-theater.config.json, then config.json
                  next to the app; without one, Claude Code sessions under ~/.claude are discovered)
  --once          print a one-shot summary of the live state and exit
  --version       print the version

Open http://127.0.0.1:8790 for the live stage, ?sample=1 for the labelled sample.`;

async function printSummary(cfg) {
  const theater = createTheater(cfg);
  const state = await buildLiveState(theater, { now: Date.now(), publicMode: true });
  const count = (list, key) => list.reduce((acc, x) => ((acc[x[key]] = (acc[x[key]] || 0) + 1), acc), {});
  console.log(
    JSON.stringify(
      {
        agents: state.agents.length,
        roles: count(state.agents, 'role'),
        actions: count(state.agents.map((a) => a.action), 'kind'),
        queue: count(state.queue.entries, 'status'),
        slotsHeld: state.slots.filter((s) => s.holder).length,
        lockHeld: Boolean(state.lock),
        events: count(state.events, 'type'),
        project: { done: state.project.done, total: state.project.total, labels: state.project.labels },
        lanes: state.pipeline.lanes.filter((l) => l.show).map((l) => `${l.id} ${l.tag} ${l.status} ${l.done}/${l.stations.length}`),
        sources: state.sources,
      },
      null,
      2,
    ),
  );
}

const isMain = import.meta.main === true || process.env.AGENT_THEATER_MAIN === '1';

if (isMain) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }
  if (process.argv.includes('--version')) {
    console.log(JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')).version);
    process.exit(0);
  }
  let cfg;
  try {
    cfg = loadConfig(configPath());
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const portArg = argValue('--port');
  if (portArg !== undefined) {
    const p = Number(portArg);
    if (!Number.isInteger(p) || p < 0 || p > 65535) {
      console.error(`--port: not a port: ${portArg}`);
      process.exit(1);
    }
    cfg.port = p;
  }
  if (process.argv.includes('--once')) {
    printSummary(cfg).catch((error) => {
      console.error(error?.message || error);
      process.exitCode = 1;
    });
  } else {
    if (!existsSync(join(cfg.publicDir, 'index.html'))) console.warn('note: public/index.html is missing; serving a placeholder page until the stage files are installed');
    startServer(cfg).then(
      (server) => {
        console.log(`Agent Theater on http://${HOST}:${server.address().port}`);
        const stop = () => server.stop().then(() => process.exit(0));
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
      },
      (error) => {
        console.error(`could not start: ${error?.message || error}`);
        process.exitCode = 1;
      },
    );
  }
}
