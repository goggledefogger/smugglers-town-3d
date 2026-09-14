// For every collider box within reach of the car: bounds, and where the tile
// vertices around it sit (snapped per face, above the top, out of reach).
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const BASE = process.env.E2E_URL ?? 'http://localhost:5176';
const LAT = process.env.LAT ?? '37.7929';
const LON = process.env.LON ?? '-122.4030';
const [TX, TZ] = (process.env.TP ?? '15,-5').split(',').map(Number);
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
await page.evaluate(([x, z]) => {
  for (const v of window.__game.vehicles) if (!v.isPlayer) v.brain = null;
  const body = window.__game.player.body;
  body.pos.set(x, 40, z); body.vel.set(0, 0, 0); body.prevPos?.copy(body.pos);
}, [TX, TZ]);
await page.waitForTimeout(8000);

const out = await page.evaluate(([px, pz]) => {
  const boxes = window.__buildingMeshView.lastColliders;
  const grid = window.__tiles.grid;
  const f = window.__clutterFilter;
  const idData = f.uSnapIds.value.image.data, n = f.uSnapIds.value.image.width;
  // RG texels: id + 1 in .r, OSM road flag in .g
  const ids = new Float32Array(n * n);
  for (let c = 0; c < n * n; c++) ids[c] = idData[c * 2];
  const hf = window.__game.terrainProvider?.heightfield;
  const near = [];
  boxes.forEach((bx, k) => {
    const dx = Math.max(bx.min.x - px, 0, px - bx.max.x), dz = Math.max(bx.min.z - pz, 0, pz - bx.max.z);
    const d = Math.hypot(dx, dz);
    if (d < 30) near.push({ k, d: Math.round(d), x0: Math.round(bx.min.x), x1: Math.round(bx.max.x), z0: Math.round(bx.min.z), z1: Math.round(bx.max.z), y0: Math.round(bx.min.y), y1: Math.round(bx.max.y), snapped: { W: 0, E: 0, S: 0, N: 0, T: 0 }, aboveTop: 0, tooFarOut: 0, maxVertY: -1e9 });
  });
  const byK = new Map(near.map(r => [r.k, r]));
  const v = new (window.__game.player.body.pos.constructor)();
  const snapV = (x, y, z) => {
    const ci = Math.floor((x + grid.half) / grid.cell), cj = Math.floor((z + grid.half) / grid.cell);
    const rise = hf ? y - hf.sample(x, z) : 99;
    const road = window.__tiles.roadGrid?.mask;
    if (rise < 2.5 && road && road[cj * n + ci] === 1) return { bestK: -1, face: '' };
    const tolOut = grid.cell * 2.5, tolIn = grid.cell * 1.5;
    let best = 1e9, bestK = -1, face = '';
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const i = Math.min(n - 1, Math.max(0, ci + ox)), j = Math.min(n - 1, Math.max(0, cj + oy));
      const sid = ids[j * n + i] - 1;
      if (sid < 0) continue;
      const bx = boxes[sid];
      const dW = bx.min.x - x, dE = x - bx.max.x, dS = bx.min.z - z, dN = z - bx.max.z, dT = y - bx.max.y;
      const inX = x > bx.min.x - tolOut && x < bx.max.x + tolOut, inZ = z > bx.min.z - tolOut && z < bx.max.z + tolOut, inY = y > bx.min.y && y < bx.max.y + 1;
      const pen = Math.min(bx.max.x - bx.min.x, bx.max.z - bx.min.z) < 6 ? grid.cell : 0;
      for (const [ok, dd, fc] of [[inZ && inY, dW, 'W'], [inZ && inY, dE, 'E'], [inX && inY, dS, 'S'], [inX && inY, dN, 'N'], [inX && inZ && dT > -4 && dT < 4, dT, 'T']]) {
        if (ok && dd > -tolIn && dd < tolOut && Math.abs(dd) + pen < best) { best = Math.abs(dd) + pen; bestK = sid; face = fc; }
      }
    }
    return { bestK, face };
  };
  window.__tiles.group.traverse(o => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    o.updateWorldMatrix(true, false);
    for (let k = 0; k < pos.count; k += 2) {
      v.fromBufferAttribute(pos, k).applyMatrix4(o.matrixWorld);
      if (Math.hypot(v.x - px, v.z - pz) > 45) continue;
      const r = snapV(v.x, v.y, v.z);
      if (r.bestK >= 0 && byK.has(r.bestK)) { byK.get(r.bestK).snapped[r.face]++; continue; }
      // not snapped: which nearby box is it hugging (within 14 m horizontally)
      for (const rec of near) {
        const bx = boxes[rec.k];
        const dx = Math.max(bx.min.x - v.x, 0, v.x - bx.max.x), dz = Math.max(bx.min.z - v.z, 0, v.z - bx.max.z);
        if (Math.hypot(dx, dz) > 14) continue;
        const rise = hf ? v.y - hf.sample(v.x, v.z) : 99;
        if (rise < 2.5) continue;
        rec.maxVertY = Math.max(rec.maxVertY, Math.round(v.y));
        if (v.y > bx.max.y + 1) { rec.aboveTop++; continue; }
        rec.tooFarOut++;
        // is the box even a candidate from this vertex's 3x3 cells?
        const ci = Math.floor((v.x + grid.half) / grid.cell), cj = Math.floor((v.z + grid.half) / grid.cell);
        let seen = false;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) if (ids[(cj + oy) * n + ci + ox] - 1 === rec.k) seen = true;
        rec.why = rec.why ?? { notCandidate: 0, candidateButLost: 0 };
        if (!seen) rec.why.notCandidate++; else rec.why.candidateButLost++;
      }
    }
  });
  return { car: { x: px, z: pz, ground: hf ? Math.round(hf.sample(px, pz)) : null }, near: near.sort((a, b) => a.d - b.d) };
}, [TX, TZ]);
console.log(JSON.stringify(out, null, 1));
await b.close();
