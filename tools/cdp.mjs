// A tiny Chrome DevTools Protocol client for QA (Node built-ins only: child_process, fs, WebSocket).
// launchChrome() starts a headless Chrome with its own temporary profile and a debugging port on
// 127.0.0.1, and returns { page, close }. page.send(method, params) talks to one tab. close() always
// stops that Chrome (by its unique profile) and removes the profile.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// CHROME_PATH wins; otherwise the usual install place for this platform.
const CHROME_CANDIDATES = {
  win32: ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/pw-browsers/chromium', '/snap/bin/chromium'],
};
const CHROME = process.env.CHROME_PATH || (CHROME_CANDIDATES[process.platform] || CHROME_CANDIDATES.linux).find((p) => existsSync(p)) || (CHROME_CANDIDATES[process.platform] || CHROME_CANDIDATES.linux)[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killProfile(tag) {
  if (process.platform !== 'win32') {
    spawnSync('pkill', ['-KILL', '-f', tag], { stdio: 'ignore' });
    return;
  }
  spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${tag}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' });
}

export async function launchChrome({ root, width = 1920, height = 1080, headless = true }) {
  const tag = `hdcdp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const profile = join(root, '.qa-profiles', tag);
  mkdirSync(profile, { recursive: true });
  // headless for QA renders; headed (a normal window) to see the page as a viewer's Chrome runs it
  const mode = headless ? ['--headless=new', '--disable-gpu', '--hide-scrollbars'] : ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--window-position=40,40'];
  // root has no user namespaces for Chrome's sandbox on Linux (containers, CI)
  const noSandbox = process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : [];
  const args = [...mode, ...noSandbox, '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${profile}`, `--window-size=${width},${height}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', 'about:blank'];
  const proc = spawn(CHROME, args, { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i += 1) await sleep(100);
  if (!existsSync(portFile)) {
    killProfile(tag);
    throw new Error('Chrome did not open a debugging port');
  }
  await sleep(200);
  const [port] = readFileSync(portFile, 'utf8').split('\n');
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('could not connect to Chrome'));
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data || ''}`));
      else resolve(msg.result);
    } else if (msg.method) for (const l of listeners) l(msg);
  };
  const page = {
    send(method, params = {}) {
      id += 1;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async eval(expression, { timeout = 60_000 } = {}) {
      const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async goto(url, { width: w = width, height: h = height } = {}) {
      await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      const loaded = new Promise((res) => {
        const off = page.on((m) => {
          if (m.method === 'Page.loadEventFired') {
            off();
            res();
          }
        });
      });
      await page.send('Page.navigate', { url });
      await Promise.race([loaded, sleep(15_000)]);
    },
    async screenshot() {
      const r = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      return Buffer.from(r.data, 'base64');
    },
    async waitFor(expression, ms = 20_000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (await page.eval(expression).catch(() => false)) return true;
        await sleep(200);
      }
      return false;
    },
  };
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  const close = async () => {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
    proc.kill();
    killProfile(tag);
    await sleep(800);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* the profile may stay locked a moment; it lives under the git-ignored .qa-profiles */
    }
  };
  return { page, close, sleep };
}

export { sleep };
