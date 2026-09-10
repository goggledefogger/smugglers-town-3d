// Attribute long frames: drive for 25 s under a CDP CPU profile (200 µs
// sampling) and print, for every frame over 40 ms, the inclusive time per
// function inside that frame. p95 never shows a hitch; this does.
//
//   node scripts/hitch-profile.mjs              # Empire State, swept (default) mode
//   MODE=hidden LAT=.. LON=.. node scripts/hitch-profile.mjs
// Needs the dev server on :5173 and .sm-key.txt. Starting the profiler itself
// costs one ~150 ms (program) stall in the first frames; ignore that one.
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
const BASE = 'http://localhost:5173';
const LAT = process.env.LAT ?? '40.7484', LON = process.env.LON ?? '-73.9857';
const key = readFileSync('.sm-key.txt', 'utf8').trim();
const b = await chromium.launch({ channel: 'chrome', headless: false });
const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.evaluate(k => localStorage.setItem('gmap_key', k), key);
await page.goto(`${BASE}/?lat=${LAT}&lon=${LON}`, { waitUntil: 'load' });
await page.waitForSelector('sr-loader[hidden]', { state: 'attached', timeout: 180000 });
await page.locator('sr-intro button.play').click();
await page.waitForFunction(() => !!window.__tiles && !!window.__game?.player, null, { timeout: 60000 });
await page.waitForTimeout(8000);
if (process.env.MODE === 'hidden') { await page.keyboard.press('KeyF'); await page.waitForTimeout(500); }
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');
await page.evaluate(() => { window.__fs = []; window.__fsOn = true; let last = performance.now(); const tick = now => { window.__fs.push([now, now - last]); last = now; if (window.__fsOn) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
await page.keyboard.down('KeyW');
await page.waitForTimeout(25000);
await page.keyboard.up('KeyW');
const frames = await page.evaluate(() => { window.__fsOn = false; return window.__fs; });
const { profile } = await cdp.send('Profiler.stop');
await b.close();
// map samples to time
const nodes = new Map(profile.nodes.map(n => [n.id, n]));
const parent = new Map(); for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
let t = profile.startTime; const samples = [];
for (let i = 0; i < profile.samples.length; i++) { t += profile.timeDeltas[i]; samples.push({ t: t / 1000, id: profile.samples[i] }); }
// hitches: frames > 40 ms (browser clock is performance.now-relative; profile uses monotonic µs; align by offset from first sample vs first frame)
const off = samples[0].t - frames[0][0];
const hitches = frames.filter(f => f[1] > 40).slice(0, 6);
console.log('frames', frames.length, 'hitches>40ms', frames.filter(f => f[1] > 40).map(f => f[1].toFixed(0)).join(','));
for (const [end, dt] of hitches) {
  const s0 = end - dt + off, s1 = end + off;
  const incl = new Map();
  let n = 0;
  for (const s of samples) { if (s.t < s0 || s.t > s1) continue; n++; let id = s.id; const seen = new Set(); while (id !== undefined) { const nd = nodes.get(id); const name = `${nd.callFrame.functionName || '(anon)'} ${(nd.callFrame.url || '').split('/').pop().split('?')[0]}:${nd.callFrame.lineNumber}`; if (!seen.has(name)) { seen.add(name); incl.set(name, (incl.get(name) || 0) + 1); } id = parent.get(id); } }
  const top = [...incl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${(v * 0.2).toFixed(1)}ms ${k}`);
  console.log(`\n== hitch ${dt.toFixed(0)}ms at ${((end - frames[0][0]) / 1000).toFixed(1)}s, samples ${n}`);
  console.log(top.join('\n'));
}
process.exit(0);
