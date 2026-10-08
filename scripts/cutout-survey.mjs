// Cutout 3D survey at Portland (Pioneer Courthouse Square) then San Francisco, one browser
// at a time: for each place, load ?view=cutout-3d&cutoutDebug=1, wait for the first stencil
// landing plus 10 s, shoot the wall overlay (driving view + aerial), print __cutoutStats, the
// landing count and the traced wall segments per source byte; Portland also counts walls and
// car colliders within 40 m of the square. Then, overlay off, hold W for 30 s on a straight road
// recording frame times and per-landing main-thread cost; then reload with &cutoutTexel=2
// and repeat the drive.
//
//   node scripts/cutout-survey.mjs outdir        # both places, DPR 2, 1280x800, vsync on
//   PLACES=pdx node scripts/cutout-survey.mjs outdir      # pdx, sf or pdx,sf
//   SECS=30 DPR=2 E2E_URL=http://localhost:5179 SM_KEY_FILE=path node scripts/cutout-survey.mjs outdir
// Screenshots: <outdir>/cutout-v4-<place>-overlay.png and -overlay-aerial.png.
// Needs the dev server and .sm-key.txt (or SM_KEY_FILE). The wall segments are not on window,
// so an init script listens to the stencil worker's replies and keeps the last traced list
// (6 floats per segment: ax, az, bx, bz, cap, source; source 1 = Overture, 2 = classifier gap).
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'cutout-survey';
mkdirSync(OUT, { recursive: true });
const BASE = process.env.E2E_URL ?? 'http://localhost:5179';
const SECS = Number(process.env.SECS ?? 30);
const key = readFileSync(process.env.SM_KEY_FILE ?? '.sm-key.txt', 'utf8').trim();
const ALL = {
  pdx: { lat: 45.5188, lon: -122.6780, square: [45.51895, -122.67935] },
  sf: { lat: 37.7929, lon: -122.4030 }
};
const PLACES = (process.env.PLACES ?? 'pdx,sf').split(',');

const b = await chromium.launch({ channel: 'chrome', headless: false });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: Number(process.env.DPR ?? 2) });
await ctx.addInitScript(() => {
  const W = window.Worker;
  window.Worker = class extends W {
    constructor(...a) {
      super(...a);
      this.addEventListener('message', e => { const s = e.data?.build?.segments; if (s) window.__segs = s; });
    }
  };
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
page.on('console', m => { const t = m.text(); if (!t.includes(key) && m.type() === 'error') errs.push(t.slice(0, 300)); });

const load = async (place, query) => {
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.evaluate(k => { localStorage.setItem('gmap_key', k); localStorage.setItem('smugglers_audio_muted', 'true'); }, key);
  await page.goto(`${BASE}/?lat=${place.lat}&lon=${place.lon}&view=cutout-3d${query}`, { waitUntil: 'load' });
  await page.waitForSelector('sr-loader[hidden]', { state: 'attached', timeout: 180000 });
  await page.locator('sr-intro button.play').click();
  await page.waitForFunction(() => !!window.__tiles && !!window.__game?.player, null, { timeout: 60000 });
  await page.waitForFunction(() => (window.__cutoutLandings?.().length ?? 0) >= 1, null, { timeout: 180000 });
  await page.waitForTimeout(10000);
};

// the straight-road start from drive-perf: longest clear run of road to the north near the centre
const startOnRoad = async () => {
  const osm = await page.waitForFunction(() => !!window.__tiles?.roadGrid?.mask, null, { timeout: 60000 }).then(() => true, () => false);
  return page.evaluate(osm => {
    const body = window.__game.player.body;
    const s = window.__tiles;
    let best = { x: body.pos.x, z: body.pos.z, runM: 'no road mask' };
    if (osm) {
      const { cell, half, n } = s.grid;
      const road = s.roadGrid.mask, st = s.structureGrid;
      const clear = (i, j) => road[j * n + i] === 1 && !st[j * n + i - 1] && !st[j * n + i] && !st[j * n + i + 1];
      let bestScore = -Infinity;
      for (let j = 2; j < n - 2; j++) for (let i = 2; i < n - 2; i++) {
        if (!clear(i, j)) continue;
        let run = 0;
        while (j - run > 0 && clear(i, j - run)) run++;
        const cx = (i + 0.5) * cell - half, cz = (j + 0.5) * cell - half;
        const score = Math.min(run, 120) * 10 - Math.hypot(cx, cz) * 0.5;
        if (score > bestScore) { bestScore = score; best = { x: cx, z: cz, runM: run * cell }; }
      }
    }
    for (const v of window.__game.vehicles) if (!v.isPlayer) v.brain = null;
    body.pos.set(best.x, 60, best.z); body.vel.set(0, 0, 0); body.prevPos?.copy(body.pos);
    body.quat.set(0, 0, 0, 1); body.prevQuat?.copy(body.quat);
    return best;
  }, osm);
};

// 30 s holding W (drive-perf's frame recorder), plus the landings that arrived meanwhile
const drive = async label => {
  await page.evaluate(() => window.__cutoutDebug?.(false));
  const start = await startOnRoad();
  await page.waitForTimeout(6000);
  const r = await page.evaluate(async secs => {
    const body = window.__game.player.body;
    const x0 = body.pos.x, z0 = body.pos.z, l0 = window.__cutoutLandings().length;
    const fs = []; let last = performance.now(), on = true;
    const tick = now => { fs.push(now - last); last = now; if (on) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const kd = new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true });
    window.dispatchEvent(kd); document.dispatchEvent(kd);
    await new Promise(r => setTimeout(r, secs * 1000));
    const ku = new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true });
    window.dispatchEvent(ku); document.dispatchEvent(ku);
    on = false;
    const a = fs.slice(5).sort((x, y) => x - y);
    const q = p => +a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(1);
    const ms = window.__cutoutLandings().slice(l0).map(l => l.ms).sort((x, y) => x - y);
    const m = p => ms.length ? +ms[Math.min(ms.length - 1, Math.floor(ms.length * p))].toFixed(2) : null;
    return { frames: a.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +a[a.length - 1].toFixed(0), over40: a.filter(v => v > 40).length,
      dist: Math.round(Math.hypot(body.pos.x - x0, body.pos.z - z0)),
      landings: ms.length, landMin: m(0), landMedian: m(0.5), landMax: ms.length ? +ms[ms.length - 1].toFixed(2) : null };
  }, SECS);
  console.log('drive', label, JSON.stringify({ start, ...r }));
};

for (const name of PLACES) {
  const place = ALL[name];
  console.log(`\n== ${name}`);
  await load(place, '&cutoutDebug=1');
  const snap = await page.evaluate(() => {
    const segs = window.__segs, bySource = {};
    if (segs) for (let o = 0; o + 6 <= segs.length; o += 6) bySource[segs[o + 5]] = (bySource[segs[o + 5]] ?? 0) + 1;
    return { stats: window.__cutoutStats?.(), landings: window.__cutoutLandings().length, segments: segs ? segs.length / 6 : null, bySource };
  });
  console.log('stats', JSON.stringify(snap.stats));
  // the height field's work in this build: is the 8 m growth bound short (grownTruncated), how much canopy was refused
  const st = snap.stats ?? {};
  console.log('height field', JSON.stringify({
    droppedByField: st.droppedByField, grown: st.grown, grownTruncated: st.grownTruncated, rough: st.rough, heights: st.heights
  }));
  console.log('landings', snap.landings, 'segments', snap.segments, 'by source byte', JSON.stringify(snap.bySource));

  // Pioneer Courthouse Square: world x = east, z = south, metres from the load point (llToWorld in
  // src/core/geo/projection.ts, equirectangular, origin = the lat/lon in the URL)
  if (place.square) {
    const sq = await page.evaluate(([lat, lon]) => {
      // the world origin is the terrain's own centre (the geocoded URL point), not assumed
      const { lat: lat0, lon: lon0 } = window.__game.terrainProvider.center;
      const R = 6378137, rad = Math.PI / 180;
      const cx = R * (lon - lon0) * rad * Math.cos(lat0 * rad), cz = -R * (lat - lat0) * rad;
      const R40 = 40, segs = window.__segs, near = { total: 0, within150: 0, nearestM: Infinity };
      const dSeg = (ax, az, bx, bz) => {
        const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cz - az) * dz) / (dx * dx + dz * dz || 1)));
        return Math.hypot(ax + t * dx - cx, az + t * dz - cz);
      };
      if (segs) for (let o = 0; o + 6 <= segs.length; o += 6) {
        const d = dSeg(segs[o], segs[o + 1], segs[o + 2], segs[o + 3]);
        if (d <= R40) { near.total++; near[segs[o + 5]] = (near[segs[o + 5]] ?? 0) + 1; }
        if (d <= 150) near.within150++;
        near.nearestM = Math.min(near.nearestM, Math.round(d));
      }
      // what the cars hit: unique boxes in the physics spatial hash, by wall / kind
      const boxes = new Set();
      for (const list of window.__game.colliderCells.values()) for (const bx of list) boxes.add(bx);
      const car = { total: 0, walls: 0 };
      for (const bx of boxes) {
        const dx = Math.max(bx.min.x - cx, 0, cx - bx.max.x), dz = Math.max(bx.min.z - cz, 0, cz - bx.max.z);
        if (Math.hypot(dx, dz) > R40) continue;
        if (bx.wall && dSeg(bx.wall.ax, bx.wall.az, bx.wall.bx, bx.wall.bz) > R40) continue;
        car.total++;
        if (bx.wall) car.walls++; else car[bx.kind ?? 'other'] = (car[bx.kind ?? 'other'] ?? 0) + 1;
      }
      return { origin: [lat0, lon0], centre: [Math.round(cx), Math.round(cz)], segmentsWithin40m: near, carColliders40m: car, carCollidersAll: boxes.size };
    }, place.square);
    console.log('pioneer square', JSON.stringify(sq));
  }

  // two overlay shots: the default driving view, then the aerial (car lifted to 140 m, as mode-survey does)
  const start = await startOnRoad();
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${OUT}/cutout-v4-${name}-overlay.png` });
  await page.evaluate(([x, z]) => {
    const body = window.__game.player.body;
    body.pos.set(x, 140, z); body.vel.set(0, 0, 0); body.prevPos?.copy(body.pos);
  }, [start.x, start.z]);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/cutout-v4-${name}-overlay-aerial.png` });

  if (process.env.SKIP_DRIVE) continue;
  await drive(`${name} default texel`);
  await load(place, '&cutoutTexel=2');
  await drive(`${name} texel=2`);
}
console.log('errors', errs.length, errs.slice(0, 5));
await b.close();
process.exit(0);
