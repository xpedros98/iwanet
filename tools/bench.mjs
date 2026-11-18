// Performance budget check (Step 10). Runs against a running app, in Chrome:
//
//   npm run build            (for the bundle sizes; optional)
//   npm run dev              (or npm start)
//   npm run bench -- --user demo --pass test [options]
//
// Options:
//   --url http://localhost:5173   app address (npm start serves on :3001)
//   --uncapped                    no vsync (thousands of frames per second): checks
//                                 that the flight still takes 20 s and ends at the
//                                 same spot. Only that: Chrome does not draw every
//                                 uncapped frame, so its frame times mean nothing.
//   --weak-gpu                    software GPU (SwiftShader): a stand-in for a weak
//                                 GPU, to see what the adaptive pixel ratio is for
//   --dpr 2                       pixel ratio for the flight (default: 2)
//   --hide haze,background        layers to switch off during the flight (cost breakdown)
//   --reduced-motion              as with the system setting on: expects 0 frames at rest
//   --headed                      show the browser window
//   --chrome <path>               Chrome executable (or set CHROME_PATH)
//
// It logs in on the login page (network throttled to broadband), times login →
// first galaxy frame, reads the /api/galaxy transfer size, then plays the /bench
// flight and compares everything with the budgets of the plan. Exit code 1 if any
// budget is missed. It only reads: no user is created or changed.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? def : (process.argv[i + 1] ?? def);
};
const flag = (name) => process.argv.includes(`--${name}`);
const url = arg('url', 'http://localhost:5173').replace(/\/$/, '');
const user = arg('user');
const pass = arg('pass');
const dpr = Number(arg('dpr', '2'));
const uncapped = flag('uncapped');
const chrome = arg('chrome', process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe');
if (!user || !pass) {
  console.error('usage: npm run bench -- --user <name> --pass <password> [--url ...] [--uncapped] [--dpr 2] [--headed]');
  process.exit(2);
}

const rows = []; // [metric, value, budget, ok]
const check = (metric, value, budget, ok) => rows.push([metric, value, budget, ok === undefined ? '' : ok ? 'ok' : 'MISSED']);
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

// ---- 1. Bundle sizes (from the last build) ----------------------------------
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'client/dist');
if (fs.existsSync(path.join(dist, 'index.html'))) {
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  const entry = new Set([...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]));
  let login = 0, galaxy = 0, three = false;
  for (const f of fs.readdirSync(path.join(dist, 'assets'))) {
    if (!f.endsWith('.js') || f.startsWith('Bench-')) continue; // the bench chunk is never loaded by users
    const src = fs.readFileSync(path.join(dist, 'assets', f));
    const gz = zlib.gzipSync(src).length;
    if (entry.has(f)) {
      login += gz;
      if (src.includes('WebGLRenderer')) three = true;
    } else galaxy += gz;
  }
  check('Login page JavaScript (gzip)', kb(login) + (three ? ' (contains three.js!)' : ''), '≤ 100 KB, no three.js', login <= 100 * 1024 && !three);
  check('Galaxy JavaScript (gzip)', kb(galaxy), '≤ 400 KB', galaxy <= 400 * 1024);
} else {
  check('Bundle sizes', 'skipped: run "npm run build" first', '', undefined);
}

// ---- 2. Browser -------------------------------------------------------------
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: !flag('headed'),
  args: [
    '--ignore-gpu-blocklist',
    '--enable-gpu',
    ...(uncapped ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : []),
    ...(flag('weak-gpu') ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []),
  ],
});
let failed = false;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: dpr });
  if (flag('reduced-motion')) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  page.on('pageerror', (e) => console.error('page error:', e.message));

  // Broadband: 20 Mbit/s down, 5 up, 20 ms round trip.
  const cdp = await page.createCDPSession();
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 20,
    downloadThroughput: (20e6 / 8),
    uploadThroughput: (5e6 / 8),
  });

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('input[name=username]');
  await new Promise((r) => setTimeout(r, 2500)); // the login page prefetches the galaxy code in idle time
  await page.type('input[name=username]', user);
  await page.type('input[name=password]', pass);
  await page.evaluate(() => {
    performance.mark('login-click');
    document.querySelector('form').requestSubmit();
  });
  await page.waitForFunction(() => performance.getEntriesByName('galaxy-first-frame').length > 0, { timeout: 20000 });
  const { loginMs, galaxyBytes } = await page.evaluate(() => ({
    loginMs: performance.getEntriesByName('galaxy-first-frame')[0].startTime - performance.getEntriesByName('login-click')[0].startTime,
    galaxyBytes: performance.getEntriesByType('resource').find((e) => e.name.includes('/api/galaxy'))?.encodedBodySize ?? -1,
  }));
  check('Login click → first galaxy frame (broadband)', `${Math.round(loginMs)} ms (+0.9 s fade-in)`, '≤ 1,500 ms', loginMs <= 1500);
  check('/api/galaxy response (gzip)', galaxyBytes >= 0 ? kb(galaxyBytes) : 'not found', '≤ 100 KB', galaxyBytes >= 0 && galaxyBytes <= 100 * 1024);

  // ---- 3. The benchmark flight (no throttling: it measures rendering) -------
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.goto(`${url}/bench?dpr=${dpr}${arg('hide') ? `&hide=${arg('hide')}` : ''}`, { waitUntil: 'load' });
  console.log(`flying the benchmark path (about 30 s)${uncapped ? ', uncapped' : ''}...`);
  await page.mouse.move(640, 790); // out of the way: no hover highlight
  await page.waitForFunction(() => window.__benchResult, { timeout: 90000, polling: 500 });
  const r = await page.evaluate(() => window.__benchResult);

  console.log(`\n${r.stars} stars, ${r.links} friendships · canvas ${r.canvas} (ratio ${r.pixelRatio}) · ${r.gpu}`);
  // The refresh is estimated from the fastest frames. When EVERY frame is slower
  // than the screen (weak GPU) that estimate is too low: never budget above 16.7 ms.
  const interval = Math.min(1000 / 60, 1000 / r.refreshHz);
  console.log(uncapped ? 'vsync off\n' : `screen ~${r.refreshHz < 50 ? '60? (every frame was slower than the screen)' : r.refreshHz} Hz\n`);
  check('Flight duration', `${r.flightSeconds} s`, '20 s at any frame rate', Math.abs(r.flightSeconds - 20) < 0.1);
  check('Frame rate during the flight', `${r.fps} fps (${r.frames} frames)`, '', undefined);
  if (!uncapped) {
    check('Frame interval, 95th percentile', `${r.frameMs.p95} ms (median ${r.frameMs.median}, worst ${r.frameMs.worst})`, `≤ ${interval.toFixed(1)} ms (one refresh)`, r.frameMs.p95 <= interval + 0.5);
    check('Frames over 33 ms', String(r.over33), '0', r.over33 === 0);
    check('JavaScript per frame, p95', `${r.jsMs.p95} ms`, '', undefined);
    check('GPU per frame, p95', r.gpuMs ? `${r.gpuMs.p95} ms (median ${r.gpuMs.median})` : 'not exposed', '', undefined);
    // The real cost of a frame, whatever the screen: it must fit a 144 Hz refresh.
    if (r.gpuMs) {
      const cost = r.jsMs.p95 + r.gpuMs.p95;
      check('Frame cost, JS + GPU (p95)', `${cost.toFixed(2)} ms`, '≤ 6.9 ms (144 Hz, desktop GPU)', cost <= 1000 / 144);
    }
    check('Long tasks (> 50 ms) during the flight', r.longTasks ? `${r.longTasks.count}` : 'not exposed', '0', r.longTasks ? r.longTasks.count === 0 : undefined);
  }
  check('Draw calls per frame', String(r.drawCalls), '≤ 6', r.drawCalls <= 6);
  check('JS heap growth during the flight', r.heapGrowthMB === null ? 'not exposed' : `${r.heapGrowthMB} MB`, '', undefined);
  if (flag('reduced-motion')) check('Frames per second at rest (reduced motion)', String(r.idleFps), '0', r.idleFps === 0);
  else check('Frames per second at rest', String(r.idleFps), '≤ 20', r.idleFps <= 21);
  check('End camera position', r.endCamera.join(', '), 'same on every run and screen', undefined);
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await browser.close();
}

// ---- 4. Report ------------------------------------------------------------
const w = [0, 1, 2].map((c) => Math.max(...rows.map((r) => r[c].length)));
for (const r of rows) console.log(`${r[0].padEnd(w[0])}  ${r[1].padEnd(w[1])}  ${r[2].padEnd(w[2])}  ${r[3]}`);
const missed = rows.filter((r) => r[3] === 'MISSED').length;
console.log(failed ? '\nbenchmark failed (see the error above)' : missed ? `\n${missed} budget(s) missed` : '\nall budgets met');
process.exit(failed || missed ? 1 : 0);
