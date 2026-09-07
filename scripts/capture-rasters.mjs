/**
 * TEMP measurement rig: captures live tile rasters from a running session at
 * a target city so connectivity can be measured offline against the real
 * pipeline code (see scripts/analyze-roads.mjs).
 *
 * Usage: node scripts/capture-rasters.mjs <name> <lat> <lon>
 * Needs the dev server on :5173 and .sm-key.txt with a Maps key.
 */
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const key = readFileSync('.sm-key.txt', 'utf8').trim();
const [name, lat, lon] = process.argv.slice(2);
const OUT = `/tmp/roads-captures/${name}.json`;
mkdirSync('/tmp/roads-captures', { recursive: true });

const b = await chromium.launch({ channel: 'chrome', headless: true });
const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
const BASE = process.env.CAPTURE_URL ?? 'http://localhost:5199';
await page.goto(`${BASE}/?debug`, { waitUntil: 'load' });
await page.evaluate(k => localStorage.setItem('gmap_key', k), key);
await page.goto(`${BASE}/?debug&lat=${lat}&lon=${lon}`, { waitUntil: 'load' });

// wait for the world to settle: tiles loaded, colliders built at least once
await page.waitForFunction(() => {
  const cap = window.__capture;
  return !!cap?.ready;
}, null, { timeout: 180000 });
// let a couple of collider rebuilds pass so refined rasters are in
await page.waitForTimeout(8000);

const dump = await page.evaluate(() => window.__capture?.dump());
const origin = await page.evaluate(() => {
  const g = window.__game;
  const c = g?.terrainProvider?.center;
  return c ? { lat: c.lat, lon: c.lon } : { lat: parseFloat(new URLSearchParams(location.search).get('lat')), lon: parseFloat(new URLSearchParams(location.search).get('lon')) };
});

if (!dump) {
  console.error('capture failed: no dump', errs[0] ?? '');
  await b.close();
  process.exit(1);
}
writeFileSync(OUT, JSON.stringify({ ...dump, origin }));
const rasterCount = dump.rasters.filter(Boolean).length;
console.log(`captured ${name}: ${rasterCount} rasters, grid ${dump.grid.n}x${dump.grid.n} cell ${dump.grid.cell}`);
if (errs.length) console.log('page errors:', errs.slice(0, 3));
await b.close();
