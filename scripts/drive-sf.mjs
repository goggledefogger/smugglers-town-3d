// Live verification for the road-mask fix: drives the player car at SF
// Russian Hill and measures whether it actually gets anywhere. Baseline
// behaviour there is invisible walls a block from spawn — sustained
// displacement across the map means the street network is drivable.
//
// Usage: node scripts/drive-sf.mjs [lat lon]
// Needs the worktree dev server on :5199 and .sm-key.txt
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const LAT = process.argv[2] ?? '37.79344';
const LON = process.argv[3] ?? '-122.42127';
const BASE = process.env.CAPTURE_URL ?? 'http://localhost:5199';

const key = readFileSync('.sm-key.txt', 'utf8').trim();
const b = await chromium.launch({ channel: 'chrome', headless: true });
const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
page.on('console', m => {
  const t = m.text();
  if (/osm-roads|road mask|overpass/.test(t)) console.log('[game]', t.slice(0, 160));
});

await page.goto(`${BASE}/?debug`, { waitUntil: 'load' });
await page.evaluate(k => localStorage.setItem('gmap_key', k), key);
await page.goto(`${BASE}/?debug&lat=${LAT}&lon=${LON}`, { waitUntil: 'load' });

await page.waitForFunction(() => window.__capture?.ready, null, { timeout: 180000 });
console.log('world ready, spawning…');

const state = () => page.evaluate(() => {
  const p = window.__game?.player;
  if (!p) return null;
  const v = p.body;
  return {
    x: Number(v.pos.x.toFixed(1)), y: Number(v.pos.y.toFixed(1)), z: Number(v.pos.z.toFixed(1)),
    speed: Number(Math.hypot(v.vel.x, v.vel.z).toFixed(1))
  };
});

// wait for the player to exist
await page.waitForFunction(() => !!window.__game?.player, null, { timeout: 30000 });
let s0 = await state();
console.log('spawn:', JSON.stringify(s0));

// hold W and steer gently with the wheel to follow streets; sample 2/s
await page.evaluate(() => {
  const d = (type, code, key) => window.dispatchEvent(new KeyboardEvent(type, { code, key, bubbles: true }));
  d('keydown', 'KeyW', 'w');
});
const samples = [];
const start = Date.now();
for (let t = 0; t < 45; t++) {
  await page.waitForTimeout(1000);
  const s = await state();
  if (s) samples.push({ t: ((Date.now() - start) / 1000).toFixed(0), ...s });
}
await page.evaluate(() => {
  const d = (type, code, key) => window.dispatchEvent(new KeyboardEvent(type, { code, key, bubbles: true }));
  d('keyup', 'KeyW', 'w');
});

console.log('samples:');
for (const s of samples.filter((_, i) => i % 3 === 0)) console.log(' ', JSON.stringify(s));
const last = samples[samples.length - 1] ?? s0;
const disp = Math.hypot(last.x - s0.x, last.z - s0.z);
const maxSpeed = Math.max(...samples.map(s => s.speed), 0);
const moved = samples.filter(s => s.speed > 3).length;
console.log(`displacement: ${disp.toFixed(0)} m, max speed ${maxSpeed.toFixed(0)} m/s, seconds moving >3 m/s: ${moved}/${samples.length}`);
if (errs.length) console.log('page errors:', errs.slice(0, 3));
await b.close();
process.exit(0);
