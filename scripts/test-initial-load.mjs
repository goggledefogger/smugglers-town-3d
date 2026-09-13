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

console.log('[test-initial-load] Navigating to Russian Hill SF...');
await page.goto(`${BASE}/?lat=37.79344&lon=-122.42127&debug`, { waitUntil: 'load' });

await page.waitForSelector('sr-loader[hidden]', { state: 'attached', timeout: 60000 });
await page.waitForFunction(() => !document.querySelector('sr-relocate')?.busy, null, { timeout: 60000 });
await page.waitForTimeout(1000);

await page.locator('sr-intro button.play').click();
await page.waitForFunction(() => !!window.__game?.player, null, { timeout: 30000 });
await page.waitForFunction(() => (window.__tiles?.colliders()?.length ?? 0) > 5, null, { timeout: 60000 });
await page.keyboard.press('Space');
await page.waitForTimeout(6000);

const diag = await page.evaluate(() => {
  const r = window.__renderer;
  const b = window.__buildingMeshView;
  const t = window.__tiles;
  return {
    cameraLayersMask: r?.camera?.layers?.mask,
    cameraPosition: r?.camera?.position,
    buildingMeshVisible: b?.group?.visible,
    tilesVisible: t?.group?.visible,
    tilesCount: t?.tiles?.length,
    clutterMode: window.__clutterFilter?.mode,
  };
});
console.log('[test-initial-load] Diagnostics on INITIAL LOAD:', diag);

await page.screenshot({ path: `${SCRATCH}/test_initial_load_after_fix.png` });
console.log('[test-initial-load] Screenshot saved to scratch/test_initial_load_after_fix.png');

await browser.close();
