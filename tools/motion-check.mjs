// Motion check: opens the real main page in Chrome (headed by default, like a viewer's browser) and
// measures for 10 s whether the stage keeps moving: sampled frame hashes, loop frame gaps, and the
// motion settings in force. Runs once with the OS setting as it is, once with reduced motion emulated.
//   node tools/motion-check.mjs [--headless] [--out qa/motion-check.json]
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { startServer } from '../server.mjs';
import { launchChrome, sleep } from './cdp.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const headless = args.includes('--headless');
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args[outIdx + 1] : join(ROOT, 'qa', 'motion-check.json');
const PORT = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 8799;

const server = await startServer(loadConfig(), { port: PORT });
const { page, close } = await launchChrome({ root: ROOT, width: 1300, height: 820, headless });
const result = { headless, runs: {} };
try {
  const run = async (name, path, reduce) => {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : '' }] });
    await page.goto(`http://127.0.0.1:${PORT}${path}`, { width: 1300, height: 820 });
    await page.waitFor('window.__theater && window.__theater.feed.everData');
    await sleep(1500);
    const os = await page.eval("matchMedia('(prefers-reduced-motion: reduce)').matches");
    const m = await page.eval('window.__theater.motionProbe(10, 250)', { timeout: 30_000 });
    result.runs[name] = { reducedMotionMediaQuery: os, ...m };
    console.log(name, JSON.stringify(result.runs[name]));
  };
  // what the viewer's machine says (no emulation), live and sample
  await page.send('Emulation.setEmulatedMedia', { features: [] });
  await page.goto(`http://127.0.0.1:${PORT}/`, { width: 1300, height: 820 });
  await page.waitFor('window.__theater && window.__theater.feed.everData');
  result.osReducedMotion = await page.eval("matchMedia('(prefers-reduced-motion: reduce)').matches");
  console.log('OS prefers-reduced-motion:', result.osReducedMotion);
  await run('live', '/', false);
  await run('live-reduced-motion', '/', true);
  await run('sample-reduced-motion', '/?sample=1', true);
  await run('live-calm-forced', '/?calm=1', false);
} finally {
  await close();
  await server.stop();
  writeFileSync(out, JSON.stringify(result, null, 1));
  console.log('wrote', out);
}
