// True Surface live check: drives a real place with the mode off, then on, and
// prints what the wheels see, capture timings and frame-time percentiles.
//
//   node scripts/surface-drive.mjs [outdir]            # Pioneer Square, Portland
//   LAT=.. LON=.. E2E_URL=http://localhost:5287 node scripts/surface-drive.mjs shots
//
// Each second of the 20 s log: the base (10 m) ground and the True Surface
// under the car, and over a 12 m line ahead of it at 0.25 m steps the height
// range and the RMS of the second difference (bumpiness) of each. Where the
// base is flat and the surface is not, the wheels are reading kerbs and humps.
// Needs the dev server and .sm-key.txt (see clutter-shots.mjs).
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'surface-shots';
mkdirSync(OUT, { recursive: true });
const BASE = process.env.E2E_URL ?? 'http://localhost:5173';
const LAT = process.env.LAT ?? '45.5188';
const LON = process.env.LON ?? '-122.6780';
const key = readFileSync('.sm-key.txt', 'utf8').trim();

const b = await chromium.launch({ channel: 'chrome', headless: false });
const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
page.on('console', m => { if (/surface/i.test(m.text())) console.log('[game]', m.text().slice(0, 200)); });

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.evaluate(k => localStorage.setItem('gmap_key', k), key);
await page.goto(`${BASE}/?debug&lat=${LAT}&lon=${LON}`, { waitUntil: 'load' });
await page.waitForSelector('sr-loader[hidden]', { state: 'attached', timeout: 180000 });
await page.waitForFunction(() => !!window.__tiles && !!window.__game?.player, null, { timeout: 60000 });
await page.waitForTimeout(8000);

// onto the nearest open OSM road cell, heading along +x (as clutter-shots does)
const teleport = () => page.evaluate(() => {
  const s = window.__tiles;
  const { cell, half, n } = s.grid;
  const road = s.roadGrid?.mask, st = s.structureGrid;
  let best = null, bestD = Infinity;
  if (road) for (let j = 2; j < n - 2; j++) for (let i = 2; i < n - 2; i++) {
    if (road[j * n + i] !== 1) continue;
    let clear = true;
    for (let dj = -2; dj <= 2 && clear; dj++) for (let di = -2; di <= 2; di++) if (st[(j + dj) * n + i + di]) { clear = false; break; }
    if (!clear) continue;
    const cx = (i + 0.5) * cell - half, cz = (j + 0.5) * cell - half;
    const d = Math.hypot(cx, cz);
    if (d < bestD) { bestD = d; best = [cx, cz]; }
  }
  const [tx, tz] = best ?? [0, 0];
  const body = window.__game.player.body;
  body.pos.set(tx, window.__game.terrainProvider.heightfield.sample(tx, tz) + 3, tz);
  body.vel.set(0, 0, 0); body.snapPrev();
  return { tx: Math.round(tx), tz: Math.round(tz), onRoad: !!best };
});

// the longest straight run of open road cells (no structure within a cell), for a clean 20 s line
const placeOnRun = () => page.evaluate(() => {
  const s = window.__tiles;
  const { cell, half, n } = s.grid;
  const road = s.roadGrid?.mask, st = s.structureGrid;
  if (!road) return null;
  const open = (i, j) => road[j * n + i] === 1 && !st[j * n + i] && !st[j * n + i + 1] && !st[j * n + i - 1] && !st[(j + 1) * n + i] && !st[(j - 1) * n + i];
  let best = { len: 0 };
  const lim = Math.floor(Number(globalThis.__runLimM ?? 450) / cell);
  for (const axis of ['x', 'z']) for (let a = n / 2 - lim; a < n / 2 + lim; a++) {
    let run = 0;
    for (let b = n / 2 - lim; b < n / 2 + lim; b++) {
      const [i, j] = axis === 'x' ? [b, a] : [a, b];
      const wx = (i + 0.5) * cell - half, wz = (j + 0.5) * cell - half;
      if (open(i, j) && s.hasTileNear(wx, wz, 0)) { run++; if (run > best.len) best = { len: run, axis, i, j }; } else run = 0;
    }
  }
  const back = best.len - 1;
  const [i0, j0] = best.axis === 'x' ? [best.i - back, best.j] : [best.i, best.j - back];
  const x = (i0 + 0.5) * cell - half, z = (j0 + 0.5) * cell - half;
  const body = window.__game.player.body;
  body.pos.set(x, window.__game.terrainProvider.heightfield.sample(x, z) + 1.5, z);
  body.vel.set(0, 0, 0); body.angVel.set(0, 0, 0);
  // forward is -z in body space: -pi/2 about y heads +x, pi heads +z
  body.quat.setFromAxisAngle(new body.pos.constructor(0, 1, 0), best.axis === 'x' ? -Math.PI / 2 : Math.PI);
  body.snapPrev();
  return { x: Math.round(x), z: Math.round(z), axis: best.axis, lengthM: best.len * cell };
});

/** Hold about `target` m/s with W taps, for `ms`. */
const cruise = async (target, ms) => {
  for (let t = 0; t < ms; t += 100) {
    const v = await page.evaluate(() => { const b = window.__game.player.body; return Math.hypot(b.vel.x, b.vel.z); });
    if (v < target) await page.keyboard.down('KeyW'); else await page.keyboard.up('KeyW');
    await page.waitForTimeout(100);
  }
  await page.keyboard.up('KeyW');
};

const frameStats = async (label, ms) => {
  await page.evaluate(() => {
    window.__fs = []; window.__fsOn = true;
    let last = performance.now();
    window.__long = [];
    const tick = now => {
      const d = now - last; window.__fs.push(d); last = now;
      if (d > 50) { const c = window.__surface?.().capture; window.__long.push({ at: Math.round(now), ms: Math.round(d), caps: c?.timings.captures ?? 0, proc: c?.field.processing ?? false }); }
      if (window.__fsOn) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // weave so the car keeps moving instead of pinning itself to a wall
  await page.keyboard.down('KeyW');
  for (let t = 0; t < ms; t += 2500) {
    const k = (t / 2500) % 2 ? 'KeyA' : 'KeyD';
    await page.keyboard.down(k); await page.waitForTimeout(400); await page.keyboard.up(k);
    await page.waitForTimeout(2100);
  }
  await page.keyboard.up('KeyW');
  const r = await page.evaluate(() => {
    window.__fsOn = false;
    window.__fsRaw = window.__fs.slice(5);
    const a = window.__fs.slice(5).sort((x, y) => x - y);
    const q = p => a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(1);
    return { frames: a.length, p50: q(0.5), p99: q(0.99), max: a[a.length - 1].toFixed(1), over25: a.filter(x => x > 25).length, long: window.__long.slice(0, 8) };
  });
  console.log(`frames[${label}]`, JSON.stringify(r));
  return page.evaluate(() => window.__fsRaw);
};

// on: U, then wait for the first capture to land
console.log('teleport', JSON.stringify(await teleport()));
await page.keyboard.press('KeyU');
await page.waitForFunction(() => window.__surface?.().field?.hasCapture, null, { timeout: 20000 });
console.log('first capture', JSON.stringify(await page.evaluate(() => window.__surface().capture.timings)));

// timings for every capture during the drive
await page.evaluate(() => {
  window.__caps = []; let seen = 0, lastP = -1;
  const poll = () => {
    const c = window.__surface?.().capture;
    if (c) {
      const t = c.timings;
      if (t.captures !== seen) { seen = t.captures; window.__caps.push({ render: t.renderMs }); }
      if (t.processMs !== lastP && window.__caps.length) { lastP = t.processMs; Object.assign(window.__caps[window.__caps.length - 1], { readback: t.readbackMs, process: t.processMs }); }
    }
    if (window.__capsOn !== false) requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
});

// 20 s of logging, once a second, while driving
const profile = () => page.evaluate(() => {
  const { field } = window.__surface();
  const body = window.__game.player.body;
  const base = window.__game.terrainProvider.heightfield;
  const f = body.forward(new body.pos.constructor());
  const len = Math.hypot(f.x, f.z) || 1, ux = f.x / len, uz = f.z / len;
  const line = s => { const v = []; for (let i = 0; i <= 48; i++) v.push(s.sample(body.pos.x + ux * i * 0.25, body.pos.z + uz * i * 0.25)); return v; };
  const stats = v => {
    let lo = Infinity, hi = -Infinity, s2 = 0;
    for (const x of v) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
    for (let i = 1; i < v.length - 1; i++) s2 += (v[i - 1] - 2 * v[i] + v[i + 1]) ** 2;
    return { range: +(hi - lo).toFixed(3), bump: +Math.sqrt(s2 / (v.length - 2)).toFixed(4) };
  };
  return {
    x: Math.round(body.pos.x), z: Math.round(body.pos.z),
    speed: +Math.hypot(body.vel.x, body.vel.z).toFixed(1),
    base: +base.sample(body.pos.x, body.pos.z).toFixed(3),
    surf: +field.sample(body.pos.x, body.pos.z).toFixed(3),
    delta: +field.deltaAt(body.pos.x, body.pos.z).toFixed(3),
    wheelsY: +body.groundY.toFixed(3),
    baseLine: stats(line(base)), surfLine: stats(line(field))
  };
});
console.log('straight run', JSON.stringify(await placeOnRun()));
await page.waitForTimeout(2500); // settle and let a recapture land under the new spot
const logs = [];
const SPEED = Number(process.env.SPEED ?? 12);
for (let t = 0; t < 20; t++) {
  if (t > 0 && t % 6 === 0) await placeOnRun(); // back to the start before the run's end wall
  await cruise(SPEED, 1000);
  const p = await profile();
  logs.push(p);
  console.log(`t=${t + 1}s`, JSON.stringify(p));
}

// the corner preview, with the F8 HUD already on via ?debug
await page.waitForTimeout(300);
const prev = page.locator('canvas[title^="True Surface"]');
if (await prev.count()) await prev.screenshot({ path: `${OUT}/true-surface-preview.png` });
await page.screenshot({ path: `${OUT}/true-surface-hud.png` });

// frame times, interleaved so a busy machine's load swings hit both modes alike:
// 3 rounds of 10 s off then 10 s on, from the same spot (30 s each in total)
const all = { off: [], on: [] };
const block = async mode => {
  console.log('teleport', JSON.stringify(await teleport()));
  await page.waitForTimeout(1500);
  const r = await frameStats(`surface ${mode}, 10 s`, 10000);
  all[mode].push(...r);
};
await page.keyboard.press('KeyU'); // off
for (let round = 0; round < 3; round++) {
  await block('off');
  await page.keyboard.press('KeyU');
  await block('on');
  await page.keyboard.press('KeyU');
}
await page.keyboard.press('KeyU'); // on again for the GPU probe
await page.waitForFunction(() => window.__surface?.().field?.hasCapture, null, { timeout: 20000 });
for (const m of ['off', 'on']) {
  const a = all[m].sort((x, y) => x - y);
  const q = p => a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(1);
  console.log(`frames[${m}, 30 s total]`, JSON.stringify({ frames: a.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: a.at(-1).toFixed(1), over25: a.filter(x => x > 25).length }));
}

// GPU-inclusive capture cost: finish, capture, finish (sync only for this measurement)
const gpu = await page.evaluate(() => {
  const { capture } = window.__surface();
  const gl = capture.renderer.getContext();
  const group = window.__tiles.group, body = window.__game.player.body;
  const out = [];
  for (let i = 0; i < 12; i++) {
    gl.finish();
    const t0 = performance.now();
    capture.inFlight = true; // keep update() from racing this probe
    const save = capture.readback; capture.readback = () => {};
    capture.capture(group, body.pos.x, body.pos.z);
    gl.finish();
    out.push(performance.now() - t0);
    capture.readback = save; capture.inFlight = false;
  }
  out.sort((a, b) => a - b);
  return { median: +out[6].toFixed(2), max: +out[11].toFixed(2) };
});
console.log('capture render incl. GPU (finish-bracketed) ms', JSON.stringify(gpu));
const caps = await page.evaluate(() => { window.__capsOn = false; return window.__caps; });
const col = k => caps.map(c => c[k]).filter(v => typeof v === 'number').sort((a, b) => a - b);
const pct = (a, p) => a.length ? +a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(2) : null;
for (const k of ['render', 'readback', 'process']) {
  const a = col(k);
  console.log(`capture ${k} ms`, JSON.stringify({ n: a.length, p50: pct(a, 0.5), p99: pct(a, 0.99), max: a.at(-1)?.toFixed(2) }));
}
const flatBaseBumpy = logs.filter(l => l.baseLine.range < 0.3 && l.surfLine.range > l.baseLine.range + 0.05).length;
console.log(`seconds where base line was flat (<0.3 m) but the surface line varied more: ${flatBaseBumpy}/${logs.length}`);
if (errs.length) console.log('page errors:', errs.slice(0, 3));
await b.close();
process.exit(0);
