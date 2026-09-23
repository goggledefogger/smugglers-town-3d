import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';

const ARTIFACT_DIR = process.env.ARTIFACT_DIR ?? '.sm-artifacts';
const SCRATCH = `${ARTIFACT_DIR}/scratch`;
mkdirSync(SCRATCH, { recursive: true });
const BASE = process.env.E2E_URL ?? 'http://localhost:5173';
const key = readFileSync('.sm-key.txt', 'utf8').trim();

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.evaluate(k => localStorage.setItem('gmap_key', k), key);

console.log('[verify] Navigating to Russian Hill SF (?lat=37.79344&lon=-122.42127&debug)...');
await page.goto(`${BASE}/?lat=37.79344&lon=-122.42127&debug`, { waitUntil: 'load' });

await page.waitForSelector('sr-loader[hidden]', { state: 'attached', timeout: 60000 });
await page.waitForFunction(() => !document.querySelector('sr-relocate')?.busy, null, { timeout: 60000 });
await page.waitForTimeout(1000);

console.log('[verify] Starting engine and skipping cinematic...');
await page.locator('sr-intro button.play').click();
await page.waitForFunction(() => !!window.__game?.player, null, { timeout: 30000 });

// Press Space to skip cinematic countdown so car is in normal driving view
await page.keyboard.press('Space');
await page.waitForTimeout(500);

console.log('[verify] Waiting for 3D tiles to stream in...');
await page.waitForFunction(() => (window.__tiles?.tiles?.length ?? 0) > 50, null, { timeout: 60000 });
await page.waitForTimeout(5000); // Allow tiles to refine and warm shaders

const initialDiag = await page.evaluate(() => {
  const r = window.__renderer;
  const b = window.__buildingMeshView;
  const t = window.__tiles;
  return {
    cameraLayersMask: r?.camera?.layers?.mask,
    buildingMeshVisible: b?.group?.visible,
    tilesVisible: t?.group?.visible,
    tilesCount: t?.tiles?.length,
    clutterMode: window.__clutterFilter?.mode,
  };
});
console.log('[verify] Diagnostics on INITIAL Real 3D:', initialDiag);

const initialShot = `${SCRATCH}/real3d_01_initial_load.png`;
await page.screenshot({ path: initialShot });
console.log(`[verify] Saved initial load screenshot: ${initialShot}`);

// Now cycle through all 7 modes back to Real 3D
console.log('[verify] Cycling through all modes back to Real 3D...');
for (let i = 0; i < 7; i++) {
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(300);
}
await page.waitForTimeout(2000);

const cycleReturnDiag = await page.evaluate(() => {
  const r = window.__renderer;
  const b = window.__buildingMeshView;
  const t = window.__tiles;
  return {
    cameraLayersMask: r?.camera?.layers?.mask,
    buildingMeshVisible: b?.group?.visible,
    tilesVisible: t?.group?.visible,
    tilesCount: t?.tiles?.length,
    clutterMode: window.__clutterFilter?.mode,
  };
});
console.log('[verify] Diagnostics after cycling back to Real 3D:', cycleReturnDiag);

const returnShot = `${SCRATCH}/real3d_02_after_cycle_return.png`;
await page.screenshot({ path: returnShot });
console.log(`[verify] Saved cycle return screenshot: ${returnShot}`);

await browser.close();
