// One street vantage, every view mode, one checkout: hood-cam shots at two
// headings plus an aerial, and a 3 s drive frame-time sample per mode.
//
//   E2E_URL=http://localhost:5173 MODES=photoreal,map-objects node scripts/mode-survey.mjs outdir
// Needs the dev server and .sm-key.txt (or SM_KEY_FILE). Frame stats print to stdout;
// survey every branch by pointing E2E_URL at each worktree's server.
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'mode-survey';
mkdirSync(OUT, { recursive: true });
const BASE = process.env.E2E_URL ?? 'http://localhost:5173';
const MODES = (process.env.MODES ?? 'photoreal').split(',');
const LAT = process.env.LAT ?? '37.7929';
const LON = process.env.LON ?? '-122.4030';
const [TX, TZ] = (process.env.TP ?? '15,-5').split(',').map(Number);
const key = readFileSync(process.env.SM_KEY_FILE ?? '.sm-key.txt', 'utf8').trim();

const b = await chromium.launch({ channel: 'chrome', headless: false });
const page = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
page.on('console', m => {
  const t = m.text();
  if (t.includes(key)) return;
  if (m.type() === 'error') errs.push(t.slice(0, 300));
});

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.evaluate(k => { localStorage.setItem('gmap_key', k); localStorage.setItem('smugglers_audio_muted', 'true'); }, key);
for (let attempt = 1; attempt <= 3; attempt++) {
  await page.goto(`${BASE}/?lat=${LAT}&lon=${LON}`, { waitUntil: 'load' });
  await page.waitForSelector('sr-loader[hidden]', { state: 'attached', timeout: 180000 });
  await page.locator('sr-intro button.play').click();
  await page.waitForFunction(() => !!window.__tiles && !!window.__game?.player, null, { timeout: 60000 });
  const roads = await page.waitForFunction(() => !!window.__tiles?.roadGrid, null, { timeout: 60000 }).then(() => true).catch(() => false);
  if (roads) break;
  console.log(`roads did not arrive (attempt ${attempt})`);
}
await page.waitForTimeout(4000);

const landed = await page.evaluate(([fx, fz]) => {
  for (const v of window.__game.vehicles) if (!v.isPlayer) v.brain = null;
  const s = window.__tiles;
  const { cell, half, n } = s.grid;
  const road = s.roadGrid?.mask, st = s.structureGrid;
  let best = null, bestD = Infinity;
  if (road && st) for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
    if (road[j * n + i] !== 1) continue;
    let near = 0;
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) if (st[(j + dj) * n + i + di]) near++;
    if (near < 3) continue;
    let clear = true;
    for (let dj = -1; dj <= 1 && clear; dj++) for (let di = -1; di <= 1; di++) if (st[(j + dj) * n + i + di]) { clear = false; break; }
    if (!clear) continue;
    const cx = (i + 0.5) * cell - half, cz = (j + 0.5) * cell - half;
    const d = Math.hypot(cx - fx, cz - fz);
    if (d < bestD) { bestD = d; best = [cx, cz]; }
  }
  const [tx, tz] = best ?? [fx, fz];
  const body = window.__game.player.body;
  body.pos.set(tx, 40, tz); body.vel.set(0, 0, 0); body.prevPos?.copy(body.pos);
  const boxes = window.__buildingMeshView?.lastColliders ?? [];
  let nb = null, nd = Infinity;
  for (const bx of boxes) {
    if (bx.max.y - bx.min.y < 8) continue;
    const cx = (bx.min.x + bx.max.x) / 2, cz = (bx.min.z + bx.max.z) / 2;
    const d = Math.hypot(cx - tx, cz - tz);
    if (d < nd) { nd = d; nb = [cx, cz]; }
  }
  let yaw = 0;
  if (nb) {
    const V = body.pos.constructor;
    yaw = Math.atan2(-(nb[0] - tx), -(nb[1] - tz));
    body.quat.setFromAxisAngle(new V(0, 1, 0), yaw);
  }
  return { tx: Math.round(tx), tz: Math.round(tz), onRoad: !!best, boxDist: Math.round(nd), yaw };
}, [TX, TZ]);
console.log('teleport', JSON.stringify(landed));
await page.waitForTimeout(8000);

const shot = async name => { await page.screenshot({ path: `${OUT}/${name}.png` }); };
const mode = async m => { await page.evaluate(m => window.__setViewMode(m), m); await page.waitForTimeout(2500); };
const heading = async yaw => {
  await page.evaluate(y => {
    const body = window.__game.player.body;
    const V = body.pos.constructor;
    body.quat.setFromAxisAngle(new V(0, 1, 0), y);
    body.vel.set(0, 0, 0);
  }, yaw);
  await page.waitForTimeout(600);
};
const frames = async ms => {
  await page.evaluate(() => {
    window.__fs = []; window.__fsOn = true;
    let last = performance.now();
    const tick = now => { window.__fs.push(now - last); last = now; if (window.__fsOn) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(ms);
  await page.keyboard.up('KeyW');
  return page.evaluate(() => {
    window.__fsOn = false;
    const a = window.__fs.slice(5).sort((x, y) => x - y);
    const q = p => a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(1);
    return { p50: q(0.5), p99: q(0.99), max: a[a.length - 1].toFixed(1), over25: a.filter(v => v > 25).length };
  });
};

const home = async () => {
  await page.evaluate(([x, z]) => {
    const body = window.__game.player.body;
    body.pos.set(x, 40, z); body.vel.set(0, 0, 0); body.prevPos?.copy(body.pos);
  }, [landed.tx, landed.tz]);
  await page.waitForTimeout(400);
};

await page.keyboard.press('KeyC'); await page.keyboard.press('KeyC');
await page.waitForTimeout(300);
for (const m of MODES) {
  await home();
  await mode(m);
  if (m === 'painted-3d' || m === 'footprint-3d' || m === 'baked-facades') await page.waitForTimeout(12000);
  await heading(landed.yaw); await shot(`${m}-front`);
  await heading(landed.yaw + Math.PI / 2); await shot(`${m}-side`);
}
await page.keyboard.press('KeyC');
for (const m of MODES) {
  await mode(m);
  await page.evaluate(([x, z]) => {
    const body = window.__game.player.body;
    body.pos.set(x, 140, z); body.vel.set(0, 0, 0); body.prevPos?.copy(body.pos);
  }, [landed.tx, landed.tz]);
  await page.waitForTimeout(800);
  await shot(`${m}-aerial`);
  await page.waitForTimeout(3000);
  await home();
  await heading(landed.yaw + Math.PI);
  const st = await frames(3000);
  console.log('frames', m, JSON.stringify(st));
}
console.log('errors', errs.length, errs.slice(0, 5));
await b.close();
