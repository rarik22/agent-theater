// QA tool: the stage on phones and tablets, through Chrome device emulation (CSS size, devicePixelRatio,
// touch, orientation, and safe-area insets when this Chrome supports overriding them).
//   node tools/mobile-check.mjs [--out qa/mobile] [--port 8797] [--sample] [--config file]
// For each device it loads the live stage (/?probe=1), waits for data, saves a device-pixel screenshot
// and checks: the layout chosen for the shape, the canvas sized in device pixels at a whole scale (or
// the fractional phone fill), centred inside the safe area, no page scrolling, crisp scaling (every art
// pixel a uniform block in the screenshot), and the controller's numbers equal to /api/state. It writes
// <out>/report.json and close-up crops of the controller and the lanes at device resolution.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { startServer } from '../server.mjs';
import { launchChrome, sleep } from './cdp.mjs';
import { RGB } from '../public/hd/hd-palette.mjs';
import { crop, decodePNG, encodePNG } from './png.mjs';

const PALETTE_RGB = new Set(RGB.map(([r, g, b]) => (r << 16) | (g << 8) | b));

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEVICES = [
  { name: 'phone-390x844-dpr3-portrait', w: 390, h: 844, dpr: 3, orientation: 'portraitPrimary', safe: { top: 47, right: 0, bottom: 34, left: 0 } },
  { name: 'phone-412x915-dpr2.625-portrait', w: 412, h: 915, dpr: 2.625, orientation: 'portraitPrimary', safe: { top: 24, right: 0, bottom: 0, left: 0 } },
  { name: 'phone-844x390-dpr3-landscape', w: 844, h: 390, dpr: 3, orientation: 'landscapePrimary', safe: { top: 0, right: 47, bottom: 21, left: 47 } },
  { name: 'phone-915x412-dpr2.625-landscape', w: 915, h: 412, dpr: 2.625, orientation: 'landscapePrimary', safe: { top: 0, right: 0, bottom: 0, left: 0 } },
  { name: 'phone-375x667-dpr2-portrait', w: 375, h: 667, dpr: 2, orientation: 'portraitPrimary', safe: { top: 20, right: 0, bottom: 0, left: 0 } },
  { name: 'tablet-768x1024-dpr2-portrait', w: 768, h: 1024, dpr: 2, orientation: 'portraitPrimary', safe: { top: 24, right: 0, bottom: 20, left: 0 } },
];

function parseArgs(argv) {
  const o = { out: join(ROOT, 'qa', 'mobile'), port: 8797, sample: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') o.out = resolve(argv[++i]);
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--sample') o.sample = true;
    // --config <file> is read by loadConfig() itself
    else if (a === '--config') i += 1;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

/** Share of the canvas's art pixels drawn as uniform blocks (whole scales only), at the best block phase. */
function blockCrispness(img, left, top, scale, w, h) {
  let best = { share: 0, dx: 0, dy: 0 };
  for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
    const share = blockShare(img, left + dx, top + dy, scale, w - 1, h - 1);
    if (share > best.share) best = { share, dx, dy };
  }
  return best;
}

/** Share of the frame's pixels that are exactly palette colours (nearest-neighbour scaling adds none). */
function paletteShare(img, left, top, w, h, palette) {
  let ok = 0;
  let n = 0;
  for (let y = top; y < top + h; y += 2) for (let x = left; x < left + w; x += 2) {
    const i = (y * img.w + x) * 4;
    if (palette.has((img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2])) ok += 1;
    n += 1;
  }
  return n ? ok / n : 0;
}

function blockShare(img, left, top, scale, w, h) {
  let ok = 0;
  let n = 0;
  for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
    const x0 = left + x * scale;
    const y0 = top + y * scale;
    const i0 = (y0 * img.w + x0) * 4;
    let same = true;
    for (let dy = 0; dy < scale && same; dy += 1) for (let dx = 0; dx < scale && same; dx += 1) {
      const i = ((y0 + dy) * img.w + x0 + dx) * 4;
      if (Math.abs(img.data[i] - img.data[i0]) + Math.abs(img.data[i + 1] - img.data[i0 + 1]) + Math.abs(img.data[i + 2] - img.data[i0 + 2]) > 6) same = false;
    }
    if (same) ok += 1;
    n += 1;
  }
  return n ? ok / n : 0;
}

export async function mobileCheck(o) {
  mkdirSync(o.out, { recursive: true });
  const server = await startServer(loadConfig(), { port: o.port });
  const base = `http://127.0.0.1:${o.port}`;
  const { page, close } = await launchChrome({ root: ROOT, width: 1300, height: 1300 });
  const report = { at: new Date().toISOString(), devices: [] };
  try {
    for (const d of DEVICES) {
      await page.send('Emulation.setDeviceMetricsOverride', { width: d.w, height: d.h, deviceScaleFactor: d.dpr, mobile: true, screenOrientation: { type: d.orientation, angle: d.orientation.startsWith('landscape') ? 90 : 0 } });
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      let safe = 'not supported by this Chrome';
      try {
        await page.send('Emulation.setSafeAreaInsetsOverride', { insets: d.safe });
        safe = d.safe;
      } catch {
        /* older Chrome: no safe-area override; insets stay 0 */
      }
      const q = new URLSearchParams({ probe: '1', feed: 'poll' });
      if (o.sample) q.set('sample', '1');
      const loaded = new Promise((res) => {
        const off = page.on((m) => {
          if (m.method === 'Page.loadEventFired') {
            off();
            res();
          }
        });
      });
      await page.send('Page.navigate', { url: `${base}/?${q}` });
      await Promise.race([loaded, sleep(15_000)]);
      if (!(await page.waitFor('window.__theater && window.__theater.feed.everData', 30_000))) throw new Error(`${d.name}: the stage got no data`);
      await sleep(3500);
      const probe = await page.eval('window.__theater.probe()');
      const dom = await page.eval(`(() => {
        const r = document.getElementById('stage').getBoundingClientRect();
        const de = document.documentElement;
        return { inner: [innerWidth, innerHeight], dpr: devicePixelRatio, client: [de.clientWidth, de.clientHeight], scroll: [de.scrollWidth, de.scrollHeight, document.body.scrollWidth, document.body.scrollHeight],
          canvas: { left: r.left, top: r.top, width: r.width, height: r.height, devW: document.getElementById('stage').width, devH: document.getElementById('stage').height },
          scrolled: (() => { window.scrollTo(0, 400); const y = window.scrollY; window.scrollTo(0, 0); return y; })() };
      })()`);
      const state = await (await fetch(`${base}/api/state${o.sample ? '?sample=1' : ''}`)).json();
      const png = await page.screenshot();
      const file = join(o.out, `${d.name}.png`);
      writeFileSync(file, png);
      const img = decodePNG(png);
      const { w: lw, h: lh } = { w: probe.output[0] / 2, h: probe.output[1] / 2 };
      const fit = probe.fit;
      const left = Math.round(dom.canvas.left * d.dpr) + (fit.ox || 0);
      const top = Math.round(dom.canvas.top * d.dpr) + (fit.oy || 0);
      // crispness over the part of the art inside the box (a fractional ratio may crop a few margin pixels)
      const cut = Math.ceil(Math.max(0, -(fit.ox || 0), -(fit.oy || 0)) / fit.scale) + 1;
      const crisp = fit.exact ? blockCrispness(img, left + cut * fit.scale, top + cut * fit.scale, fit.scale, lw - 2 * cut, lh - 2 * cut) : null;
      const pal = paletteShare(img, Math.round(dom.canvas.left * d.dpr), Math.round(dom.canvas.top * d.dpr), dom.canvas.devW, dom.canvas.devH, PALETTE_RGB);
      // close-ups at device resolution: the controller band and the first lanes
      const ctrlH = Math.round((probe.big ? 60 : 54) * fit.scale);
      const c1 = crop(img, left, top, Math.min(img.w - left, Math.round(lw * fit.scale)), Math.min(img.h - top, ctrlH));
      writeFileSync(join(o.out, `${d.name}-controller.png`), encodePNG(c1.w, c1.h, c1.data));
      const laneTop = top + Math.round((probe.aspect === '9:16' ? 110 : probe.big ? 60 : 50) * fit.scale);
      const c2 = crop(img, left, laneTop, Math.min(img.w - left, Math.round(Math.min(lw, 540) * fit.scale)), Math.min(img.h - laneTop, Math.round(160 * fit.scale)));
      writeFileSync(join(o.out, `${d.name}-lanes.png`), encodePNG(c2.w, c2.h, c2.data));
      const pr = state.project || {};
      const want = {
        jobs: Number.isInteger(pr.done) && Number.isInteger(pr.total) && pr.total > 0 ? `${pr.done}/${pr.total}` : '--/--',
        features: pr.features ? `${pr.features.done}/${pr.features.total}` : '--/--',
        batch: (() => {
          const n = Number.isInteger(pr.batch) ? pr.batch : state.queue?.batch?.n;
          return Number.isInteger(n) && n > 0 ? String(n) : '-';
        })(),
      };
      const avail = { w: d.w - (typeof safe === 'object' ? safe.left + safe.right : 0), h: d.h - (typeof safe === 'object' ? safe.top + safe.bottom : 0) };
      const ts = probe.ts || 1;
      const row = {
        device: d.name,
        css: [d.w, d.h],
        dpr: d.dpr,
        safe,
        aspect: probe.aspect,
        scale: Number(fit.scale.toFixed(4)),
        wholeScale: fit.exact,
        canvasDevice: [dom.canvas.devW, dom.canvas.devH],
        canvasCss: [Number(dom.canvas.width.toFixed(2)), Number(dom.canvas.height.toFixed(2))],
        canvasAt: [Number(dom.canvas.left.toFixed(2)), Number(dom.canvas.top.toFixed(2))],
        widthUsed: Number((dom.canvas.width / avail.w).toFixed(3)),
        heightUsed: Number((dom.canvas.height / avail.h).toFixed(3)),
        labelCapCss: Number(((7 * ts * fit.scale) / d.dpr).toFixed(2)),
        digitsCss: Number(((7 * (probe.big ? 2 : 1) * fit.scale) / d.dpr).toFixed(2)),
        big: probe.big,
        deviceBox: { box: [fit.boxW, fit.boxH], art: [fit.devW, fit.devH], at: [fit.ox, fit.oy], quantum: fit.quantum },
        noScroll: dom.scroll[0] <= dom.client[0] && dom.scroll[1] <= dom.client[1] && dom.scrolled === 0,
        inside: dom.canvas.left >= 0 && dom.canvas.top >= 0 && dom.canvas.left + dom.canvas.width <= d.w + 0.01 && dom.canvas.top + dom.canvas.height <= d.h + 0.01,
        // centred to within half a layout quantum (whole device pixels the browser can place exactly)
        centred: Math.abs(dom.canvas.left - ((typeof safe === 'object' ? safe.left : 0) + (avail.w - dom.canvas.width) / 2)) <= 1 + fit.quantum / d.dpr / 2 && Math.abs(dom.canvas.top - ((typeof safe === 'object' ? safe.top : 0) + (avail.h - dom.canvas.height) / 2)) <= 1 + fit.quantum / d.dpr / 2,
        crispBlocks: crisp === null ? null : Number(crisp.share.toFixed(4)),
        blockPhase: crisp === null ? null : [crisp.dx, crisp.dy],
        paletteOnly: Number(pal.toFixed(4)),
        controller: probe.controller,
        controllerMatchesState: probe.controller ? probe.controller.jobs === want.jobs && probe.controller.features === want.features && probe.controller.batch === want.batch && probe.controller.agents === Math.min(99, probe.agents.length) : false,
        stateAgents: state.agents.length,
        stageAgents: probe.agents.length,
        file,
      };
      report.devices.push(row);
      console.log(`${d.name}: ${row.aspect} scale ${row.scale}${row.wholeScale ? '' : ' (fractional)'} width ${Math.round(row.widthUsed * 100)}% labels ${row.labelCapCss} css px, noScroll ${row.noScroll}, centred ${row.centred}, crisp ${row.crispBlocks} phase ${JSON.stringify(row.blockPhase)} palette ${row.paletteOnly}, controller ${JSON.stringify(row.controller)} matches ${row.controllerMatchesState}`);
    }
  } finally {
    await close();
    await server.stop();
    try {
      rmSync(join(ROOT, '.qa-profiles'), { recursive: true, force: true });
    } catch {
      /* Chrome may hold the profile a moment longer */
    }
  }
  writeFileSync(join(o.out, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
  return report;
}

if (import.meta.main) {
  try {
    await mobileCheck(parseArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(e?.message || e);
    process.exitCode = 1;
  }
}
