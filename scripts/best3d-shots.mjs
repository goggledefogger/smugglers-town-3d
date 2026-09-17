// Screenshots of Best 3D and Best 3D + Streets from one street vantage, plus
// a short drive so texture anchoring can be eyeballed frame to frame.
//
//   node scripts/best3d-shots.mjs <outdir>          # SF Financial District
//   LAT=.. LON=.. node scripts/best3d-shots.mjs out
//   TINT=1 tints snapped tile fragments green (diagnostic)
// Needs the dev server (E2E_URL, default :5176) and .sm-key.txt.
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'best3d-shots';
mkdirSync(OUT, { recursive: true });
const BASE = process.env.E2E_URL ?? 'http://localhost:5176';
const LAT = process.env.LAT ?? '37.7929';
const LON = process.env.LON ?? '-122.4030';
// where to stand when the OSM road fetch has not landed (Overpass times out now and then): Market St at Montgomery
const [TX, TZ] = (process.env.TP ?? '15,-5').split(',').map(Number);
const key = readFileSync('.sm-key.txt', 'utf8').trim();

const b = await chromium.launch({ channel: 'chrome', headless: false });
const page = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
page.on('console', m => {
  const t = m.text();
  if (t.includes(key)) return;
  if (m.type() === 'error' || /shader|WebGL|GLSL/i.test(t)) errs.push(t.slice(0, 400));
});

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.evaluate(k => { localStorage.setItem('gmap_key', k); localStorage.setItem('smugglers_audio_muted', 'true'); }, key);
// Overpass times out now and then and the app asks once per load: reload until the road mask lands
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

// park the bots and put the car on a clear road cell
const landed = await page.evaluate(([fx, fz]) => {
  for (const v of window.__game.vehicles) if (!v.isPlayer) v.brain = null;
  const s = window.__tiles;
  const { cell, half, n } = s.grid;
  const road = s.roadGrid?.mask, st = s.structureGrid;
  let best = null, bestD = Infinity;
  if (road) for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
    if (road[j * n + i] !== 1) continue;
    let near = 0;
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) if (st[(j + dj) * n + i + di]) near++;
    if (near < 3) continue; // want buildings around, not a plaza
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
  // face the nearest building box so the chase and hood cameras look at a facade
  const boxes = window.__buildingMeshView.lastColliders;
  let nb = null, nd = Infinity;
  for (const b of boxes) {
    if (b.max.y - b.min.y < 8) continue;
    const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
    const d = Math.hypot(cx - tx, cz - tz);
    if (d < nd) { nd = d; nb = [cx, cz]; }
  }
  if (nb) {
    const V = body.pos.constructor;
    body.quat.setFromAxisAngle(new V(0, 1, 0), Math.atan2(-(nb[0] - tx), -(nb[1] - tz)));
  }
  return { tx: Math.round(tx), tz: Math.round(tz), onRoad: !!best, boxDist: Math.round(nd) };
}, [TX, TZ]);
console.log('teleport', JSON.stringify(landed));
await page.waitForTimeout(10000);

const shot = async name => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name); };
const mode = async m => { await page.evaluate(m => window.__setViewMode(m), m); await page.evaluate(t => { if (window.__clutterFilter) window.__clutterFilter.debugTint = t; }, !!process.env.TINT); await page.waitForTimeout(1500); };

const heading = async yaw => {
  await page.evaluate(y => {
    const body = window.__game.player.body;
    const V = body.pos.constructor;
    body.quat.setFromAxisAngle(new V(0, 1, 0), y);
    body.vel.set(0, 0, 0);
  }, yaw);
  await page.waitForTimeout(500);
};
await page.keyboard.press('KeyC'); await page.keyboard.press('KeyC'); // hood cam
await page.waitForTimeout(300);
for (const m of ['photoreal', 'best-3d', 'painted-3d', 'painted-metro', 'vector-city']) {
  await mode(m);
  for (let k = 0; k < 4; k++) {
    await heading(k * Math.PI / 2);
    await shot(`${m}-h${k}`);
  }
}
await page.keyboard.press('KeyC'); // back to chase
// rooftop overview: drop the car from high up, the chase camera follows from above
for (const m of ['photoreal', 'best-3d', 'painted-3d', 'painted-metro', 'vector-city']) {
  await mode(m);
  await page.evaluate(([x, z]) => {
    const body = window.__game.player.body;
    body.pos.set(x, 140, z); body.vel.set(0, 0, 0); body.prevPos?.copy(body.pos);
  }, [TX, TZ]);
  await page.waitForTimeout(700);
  await shot(`${m}-aerial`);
  if (m === 'best-3d') {
    await page.evaluate(() => { window.__buildingMeshView.visible = false; });
    await page.waitForTimeout(100);
    await shot(`${m}-aerial-noboxes`);
    await page.evaluate(() => { window.__buildingMeshView.visible = true; });
  }
  await page.waitForTimeout(4000);
}
await mode('best-3d');
const diag = await page.evaluate(() => ({
  label: document.getElementById('view-mode-text')?.textContent,
  snap: window.__clutterFilter?.snap,
  clutter: window.__clutterFilter?.mode,
  boxes: window.__buildingMeshView?.group?.visible,
  tiles: window.__tiles?.group?.visible,
  layers: window.__renderer?.camera?.layers?.mask
}));
console.log('best-3d', JSON.stringify(diag));
const frames = async (label, ms) => {
  await page.evaluate(() => {
    window.__fs = []; window.__fsOn = true;
    let last = performance.now();
    const tick = now => { window.__fs.push(now - last); last = now; if (window.__fsOn) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(ms);
  await page.keyboard.up('KeyW');
  const st = await page.evaluate(() => {
    window.__fsOn = false;
    const a = window.__fs.slice(5).sort((x, y) => x - y);
    const q = p => a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(1);
    return { n: a.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: a[a.length - 1].toFixed(1), over25: a.filter(v => v > 25).length };
  });
  console.log('frames', label, JSON.stringify(st));
};
await heading(0);
await page.keyboard.down('KeyW');
await page.waitForTimeout(1200);
await shot('drive-a');
await page.waitForTimeout(500);
await shot('drive-b');
await page.keyboard.up('KeyW');
await page.waitForTimeout(1500);
await shot('drive-stopped');
await heading(Math.PI);
await frames('best-3d', 4000);
await mode('painted-3d');
await page.waitForTimeout(6000);
await heading(0);
await frames('painted-3d', 4000);
await mode('photoreal');
await heading(0);
await frames('photoreal', 4000);

console.log('errors', errs.length, errs.slice(0, 8));
await b.close();
