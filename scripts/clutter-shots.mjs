// Screenshots of every clutter mode from one vantage, plus optional frame stats.
//
// The spawn ring picks the roomiest open ground, which downtown is usually a
// river or a plaza full of trees, so the car is teleported to the nearest OSM
// road cell with no structure cell around it: a real street with the chase
// camera behind the car. Every mode is shot from the same session seconds
// apart, so bots ramming the car or the camera climbing out of a building do
// not make one mode look different from another.
//
//   node scripts/clutter-shots.mjs <outdir>            # Pioneer Square, Portland
//   LAT=36.1147 LON=-115.1728 node scripts/clutter-shots.mjs vegas
//   TP=300,-200 ...    metres east,south of the centre to snap from (default 0,0)
//   DRIVE=1 ...        also hold W for 20 s in hidden and swept and print frame stats
//   DPR=2 ...          Retina-sized backbuffer, for GPU-bound comparisons
// Needs the dev server on :5173 and .sm-key.txt (see the browser-verification notes).
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'clutter-shots';
mkdirSync(OUT, { recursive: true });
const BASE = process.env.E2E_URL ?? 'http://localhost:5173';
const LAT = process.env.LAT ?? '45.5188';
const LON = process.env.LON ?? '-122.6780';
const [TX, TZ] = (process.env.TP ?? '0,0').split(',').map(Number);
const key = readFileSync('.sm-key.txt', 'utf8').trim();

const b = await chromium.launch({ channel: 'chrome', headless: false });
// DPR=2 approximates a Retina laptop (the game caps its own pixel ratio at 1.5)
const page = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: Number(process.env.DPR ?? 1) });
const errs = [];
page.on('pageerror', e => errs.push(String(e).slice(0, 200)));

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.evaluate(k => localStorage.setItem('gmap_key', k), key);
await page.goto(`${BASE}/?lat=${LAT}&lon=${LON}`, { waitUntil: 'load' });
await page.waitForSelector('sr-loader[hidden]', { state: 'attached', timeout: 180000 });
// a deep link relocates into the garage backdrop; START ENGINE spawns the match
await page.locator('sr-intro button.play').click();
await page.waitForFunction(() => !!window.__tiles && !!window.__game?.player, null, { timeout: 60000 });
await page.waitForTimeout(6000);

const landed = await page.evaluate(([x, z]) => {
  const s = window.__tiles;
  const { cell, half, n } = s.grid;
  const road = s.roadGrid?.mask, st = s.structureGrid;
  let best = null, bestD = Infinity;
  if (road) for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
    if (road[j * n + i] !== 1) continue;
    let clear = true;
    for (let dj = -1; dj <= 1 && clear; dj++) for (let di = -1; di <= 1; di++) if (st[(j + dj) * n + i + di]) { clear = false; break; }
    if (!clear) continue;
    const cx = (i + 0.5) * cell - half, cz = (j + 0.5) * cell - half;
    const d = Math.hypot(cx - x, cz - z);
    if (d < bestD) { bestD = d; best = [cx, cz]; }
  }
  const [tx, tz] = best ?? [x, z];
  const body = window.__game.player.body;
  body.pos.set(tx, 40, tz); body.vel.set(0, 0, 0); body.prevPos?.copy(body.pos);
  return { tx: Math.round(tx), tz: Math.round(tz), onRoad: !!best };
}, [TX, TZ]);
console.log('teleport', JSON.stringify(landed));
await page.waitForTimeout(12000);

const shot = async name => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name); };
// F cycles from the default: hidden -> swept -> off -> flatten
for (const m of ['hidden', 'swept', 'off', 'flatten']) {
  await shot(m);
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(800);
}

if (process.env.DRIVE) {
  const drive = async label => {
    await page.evaluate(() => {
      window.__fs = []; window.__fsOn = true;
      let last = performance.now();
      const tick = now => { window.__fs.push(now - last); last = now; if (window.__fsOn) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(20000);
    await page.keyboard.up('KeyW');
    const r = await page.evaluate(() => {
      window.__fsOn = false;
      const raw = window.__fs.slice(5);
      const a = raw.slice().sort((x, y) => x - y);
      const q = p => a[Math.floor(a.length * p)].toFixed(1);
      let t = 0;
      const hitches = [];
      for (const d of raw) { t += d; if (d > 25) hitches.push(`${(t / 1000).toFixed(1)}s:${d.toFixed(0)}ms`); }
      return { p50: q(0.5), p99: q(0.99), max: a[a.length - 1].toFixed(1), over25: a.filter(x => x > 25).length, hitches: hitches.slice(0, 8).join(' ') };
    });
    console.log(`frames[${label}]`, JSON.stringify(r));
  };
  await drive('hidden');
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(500);
  await drive('swept');
}
if (errs.length) console.log('page errors:', errs.slice(0, 3));
await b.close();
process.exit(0);
