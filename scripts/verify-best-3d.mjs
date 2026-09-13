import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';

const ARTIFACT_DIR = '/Users/Danny/.gemini/antigravity-ide/brain/17338ac7-1732-4700-9dc2-17d3d0437a25';
const SCRATCH = `${ARTIFACT_DIR}/scratch`;
mkdirSync(SCRATCH, { recursive: true });
const BASE = process.env.E2E_URL ?? 'http://localhost:5173';
const key = readFileSync('.sm-key.txt', 'utf8').trim();

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.evaluate(k => localStorage.setItem('gmap_key', k), key);

console.log('[best-3d] Navigating to Russian Hill SF (?lat=37.79344&lon=-122.42127&debug)...');
await page.goto(`${BASE}/?lat=37.79344&lon=-122.42127&debug`, { waitUntil: 'load' });
await page.waitForSelector('sr-loader[hidden]', { state: 'attached', timeout: 60000 });
await page.waitForFunction(() => !document.querySelector('sr-relocate')?.busy, null, { timeout: 60000 });
await page.waitForTimeout(1000);

await page.locator('sr-intro button.play').click();
await page.waitForFunction(() => !!window.__game?.player, null, { timeout: 30000 });
await page.keyboard.press('Space');
await page.waitForTimeout(1000);

// Wait for colliders to be generated from structure grid
console.log('[best-3d] Waiting for tiles and colliders to load...');
await page.waitForFunction(() => (window.__tiles?.tiles?.length ?? 0) > 30, null, { timeout: 60000 });
await page.waitForTimeout(4000);

// Switch to 'best-3d'
console.log('[best-3d] Switching view mode to Best 3D...');
await page.evaluate(() => {
  window.__setViewMode('best-3d');
});
await page.waitForTimeout(1000);

const diag = await page.evaluate(() => {
  const r = window.__renderer;
  const b = window.__buildingMeshView;
  const t = window.__tiles;
  const btn = document.getElementById('view-mode-text');
  return {
    viewModeLabel: btn?.textContent,
    cameraLayersMask: r?.camera?.layers?.mask,
    buildingMeshVisible: b?.group?.visible,
    buildingTextureStyle: b?.getTextureStyle?.(),
    tilesVisible: t?.group?.visible,
    tilesCount: t?.tiles?.length,
  };
});

console.log('[best-3d] Diagnostics in Best 3D mode:', diag);

if (diag.viewModeLabel !== 'VIEW: BEST 3D') {
  throw new Error(`Expected label "VIEW: BEST 3D", got "${diag.viewModeLabel}"`);
}
if (diag.tilesVisible !== false) {
  throw new Error(`Expected tilesVisible to be false in Best 3D, got ${diag.tilesVisible}`);
}
if (diag.buildingMeshVisible !== true) {
  throw new Error(`Expected buildingMeshVisible to be true in Best 3D, got ${diag.buildingMeshVisible}`);
}
if (diag.cameraLayersMask !== 1) {
  throw new Error(`Expected cameraLayersMask to be 1 (layer 0 only), got ${diag.cameraLayersMask}`);
}

const shotRussianHill = `${SCRATCH}/best3d_01_russian_hill.png`;
await page.screenshot({ path: shotRussianHill });
console.log(`[best-3d] Saved screenshot: ${shotRussianHill}`);

// Test driving into building and collision physics
console.log('[best-3d] Driving vehicle forward into urban area...');
await page.keyboard.down('KeyW');
await page.waitForTimeout(2500);
await page.keyboard.up('KeyW');
await page.waitForTimeout(500);

const shotDriving = `${SCRATCH}/best3d_02_russian_hill_driving.png`;
await page.screenshot({ path: shotDriving });
console.log(`[best-3d] Saved driving screenshot: ${shotDriving}`);

// Teleport to SF Financial District
console.log('[best-3d] Navigating to SF Financial District (?lat=37.79675&lon=-122.40122&debug)...');
await page.goto(`${BASE}/?lat=37.79675&lon=-122.40122&debug`, { waitUntil: 'load' });
await page.waitForSelector('sr-loader[hidden]', { state: 'attached', timeout: 60000 });
await page.waitForFunction(() => !document.querySelector('sr-relocate')?.busy, null, { timeout: 60000 });
await page.locator('sr-intro button.play').click();
await page.waitForFunction(() => !!window.__game?.player, null, { timeout: 30000 });
await page.keyboard.press('Space');
await page.waitForFunction(() => (window.__tiles?.tiles?.length ?? 0) > 30, null, { timeout: 60000 });
await page.waitForTimeout(4000);

await page.evaluate(() => {
  window.__setViewMode('best-3d');
});
await page.waitForTimeout(1500);

const shotFinancial = `${SCRATCH}/best3d_03_sf_financial.png`;
await page.screenshot({ path: shotFinancial });
console.log(`[best-3d] Saved Financial District screenshot: ${shotFinancial}`);

// Teleport to Columbus Ave & Transamerica Pyramid
console.log('[best-3d] Navigating to Columbus & Transamerica (?lat=37.7952&lon=-122.4028&debug)...');
await page.goto(`${BASE}/?lat=37.7952&lon=-122.4028&debug`, { waitUntil: 'load' });
await page.waitForSelector('sr-loader[hidden]', { state: 'attached', timeout: 60000 });
await page.waitForFunction(() => !document.querySelector('sr-relocate')?.busy, null, { timeout: 60000 });
await page.locator('sr-intro button.play').click();
await page.waitForFunction(() => !!window.__game?.player, null, { timeout: 30000 });
await page.keyboard.press('Space');
await page.waitForFunction(() => (window.__tiles?.tiles?.length ?? 0) > 30, null, { timeout: 60000 });
await page.waitForTimeout(4000);

await page.evaluate(() => {
  window.__setViewMode('best-3d');
});
await page.waitForTimeout(1500);

const shotTransamerica = `${SCRATCH}/best3d_04_columbus_transamerica.png`;
await page.screenshot({ path: shotTransamerica });
console.log(`[best-3d] Saved Columbus Transamerica screenshot: ${shotTransamerica}`);

console.log('[best-3d] All verification steps completed successfully!');
await browser.close();
