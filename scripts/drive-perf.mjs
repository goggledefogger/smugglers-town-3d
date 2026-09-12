// Sustained-streaming frame stats: drive the Las Vegas Strip north for 30 s
// at Retina scale and report frame times, distance covered and tiles loaded.
// A straight, wide road through dense tiles, so the car keeps moving and the
// streamer keeps working; if `dist` stops growing the car got stuck and the
// numbers mean nothing.
//
//   node scripts/drive-perf.mjs            # DPR 2, 30 s
//   DPR=1 SECS=20 node scripts/drive-perf.mjs
//   UNCAP=1 ...   vsync off: frame time = work done, for A/B comparisons
//   GPU=4 ...     render at 4x pixel ratio so the GPU is the bottleneck
// Needs the dev server on :5173 and .sm-key.txt.
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const BASE = process.env.E2E_URL ?? 'http://localhost:5173';
const SECS = Number(process.env.SECS ?? 30);
const key = readFileSync('.sm-key.txt', 'utf8').trim();
// UNCAP=1 turns off vsync so a frame time is the work it took, not the refresh interval
const b = await chromium.launch({ channel: 'chrome', headless: false,
  args: process.env.UNCAP ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : [] });
const page = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: Number(process.env.DPR ?? 2) });
await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.evaluate(k => localStorage.setItem('gmap_key', k), key);
// the Strip in front of Planet Hollywood, heading north past Bellagio and Caesars
await page.goto(`${BASE}/?lat=${process.env.LAT ?? '36.1075'}&lon=${process.env.LON ?? '-115.1727'}`, { waitUntil: 'load' });
await page.waitForSelector('sr-loader[hidden]', { state: 'attached', timeout: 180000 });
await page.locator('sr-intro button.play').click();
await page.waitForFunction(() => !!window.__tiles && !!window.__game?.player, null, { timeout: 60000 });
// start on the road cell nearest the centre with the longest run of road (no
// structure alongside) to the north: a straight the car can hold W on. Needs
// the OSM mask, and Overpass can take minutes, so after 20 s fall back to the
// answer it gave for the default location (or START=x,z)
const osm = await page.waitForFunction(() => !!window.__tiles?.roadGrid?.mask, null, { timeout: 20000 }).then(() => true, () => false);
await page.waitForTimeout(3000);
const start = await page.evaluate(([osm, fallback]) => {
  const s = window.__tiles;
  if (!osm) {
    const body = window.__game.player.body;
    body.pos.set(fallback[0], 60, fallback[1]); body.vel.set(0, 0, 0); body.prevPos?.copy(body.pos);
    body.quat.set(0, 0, 0, 1); body.prevQuat?.copy(body.quat);
    return { x: fallback[0], z: fallback[1], runM: 'fallback' };
  }
  const { cell, half, n } = s.grid;
  const road = s.roadGrid.mask, st = s.structureGrid;
  const clear = (i, j) => road[j * n + i] === 1 && !st[j * n + i - 1] && !st[j * n + i] && !st[j * n + i + 1];
  let best = null, bestScore = -Infinity;
  for (let j = 2; j < n - 2; j++) for (let i = 2; i < n - 2; i++) {
    if (!clear(i, j)) continue;
    let run = 0;
    while (j - run > 0 && clear(i, j - run)) run++;
    const cx = (i + 0.5) * cell - half, cz = (j + 0.5) * cell - half;
    const score = Math.min(run, 120) * 10 - Math.hypot(cx, cz) * 0.5;
    if (score > bestScore) { bestScore = score; best = { x: cx, z: cz, runM: run * cell }; }
  }
  const body = window.__game.player.body;
  body.pos.set(best.x, 60, best.z); body.vel.set(0, 0, 0); body.prevPos?.copy(body.pos);
  body.quat.set(0, 0, 0, 1); body.prevQuat?.copy(body.quat);
  return best;
}, [osm, (process.env.START ?? '785,-5').split(',').map(Number)]);
console.log('start', JSON.stringify(start));
// GPU=n renders at n× pixel ratio (and pins it against the adaptive scaler) so
// the frame is GPU-bound and its time is the GPU's, for shader-cost A/Bs
if (process.env.GPU) {
  await page.evaluate(async ratio => {
    const scene = window.__tiles.group.parent;
    let mesh = null; scene.traverse(o => { if (!mesh && o.isMesh) mesh = o; });
    const r = await new Promise(res => { mesh.onBeforeRender = renderer => { mesh.onBeforeRender = () => {}; res(renderer); }; });
    r.setPixelRatio(ratio);
    r.setPixelRatio = () => {};
  }, Number(process.env.GPU));
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(6000);
// PROGS=1 lists every shader program that appears during the drive: a program
// created mid-drive is one that links on its first draw, a 30-40 ms stall
if (process.env.PROGS) {
  await page.evaluate(async () => {
    const scene = window.__tiles.group.parent;
    let mesh = null; scene.traverse(o => { if (!mesh && o.isMesh) mesh = o; });
    const r = await new Promise(res => { mesh.onBeforeRender = renderer => { mesh.onBeforeRender = () => {}; res(renderer); }; });
    window.__progs = []; const seen = new Set(r.info.programs.map(p => p.id));
    const t0 = performance.now();
    setInterval(() => { for (const p of r.info.programs) if (!seen.has(p.id)) { seen.add(p.id); window.__progs.push(`${((performance.now() - t0) / 1000).toFixed(1)}s ${p.name} ${p.cacheKey.slice(0, 60)}`); } }, 250);
  });
}
const stats = await page.evaluate(async secs => {
  const body = window.__game.player.body;
  const z0 = body.pos.z, tiles0 = window.__tiles.tileCount;
  const fs = []; let last = performance.now(), on = true;
  const tick = now => { fs.push(now - last); last = now; if (on) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const kd = new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true });
  window.dispatchEvent(kd); document.dispatchEvent(kd);
  const marks = [];
  for (let t = 0; t < secs; t++) { await new Promise(r => setTimeout(r, 1000)); marks.push(Math.round(z0 - body.pos.z)); }
  const ku = new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true });
  window.dispatchEvent(ku); document.dispatchEvent(ku);
  on = false;
  const a = fs.slice(5).sort((x, y) => x - y);
  const q = p => +a[Math.floor(a.length * p)].toFixed(1);
  const mean = +(fs.reduce((s, v) => s + v, 0) / fs.length).toFixed(2);
  const at120 = +(fs.filter(x => x < 12).length / fs.length * 100).toFixed(0);
  return { p50: q(0.5), p90: q(0.9), p99: q(0.99), mean, at120pct: at120, max: +a[a.length - 1].toFixed(0), over25: a.filter(x => x > 25).length,
    dist: Math.round(z0 - body.pos.z), tilesLoaded: window.__tiles.tileCount - tiles0, tiles: window.__tiles.tileCount, marks: marks.join(',') };
}, SECS);
console.log(JSON.stringify(stats));
if (process.env.PROGS) console.log((await page.evaluate(() => window.__progs)).join('\n'));
await b.close();
process.exit(0);
