import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';

const ARTIFACT_DIR = '/Users/Danny/.gemini/antigravity-ide/brain/17338ac7-1732-4700-9dc2-17d3d0437a25';
const SCRATCH = `${ARTIFACT_DIR}/scratch`;
mkdirSync(SCRATCH, { recursive: true });
const BASE = process.env.E2E_URL ?? 'http://localhost:5173';
const LAT = '37.79344'; // Russian Hill SF
const LON = '-122.42127';
const key = readFileSync('.sm-key.txt', 'utf8').trim();

console.log('[playwright] Launching Chrome...');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

const consoleErrors = [];
page.on('pageerror', e => {
  console.error('[page error]', e);
  consoleErrors.push(String(e));
});
page.on('console', m => {
  if (m.type() === 'error') {
    console.error('[console error]', m.text());
    consoleErrors.push(m.text());
  }
});

try {
  console.log('[playwright] Setting Maps key in localStorage and navigating...');
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.evaluate(k => localStorage.setItem('gmap_key', k), key);

  console.log('[playwright] Navigating to Russian Hill SF (?lat=37.79344&lon=-122.42127&debug)...');
  await page.goto(`${BASE}/?lat=${LAT}&lon=${LON}&debug`, { waitUntil: 'load' });

  console.log('[playwright] Waiting for loader to complete...');
  await page.waitForSelector('sr-loader[hidden]', { state: 'attached', timeout: 60000 });

  console.log('[playwright] Clicking Start Engine button...');
  await page.locator('sr-intro button.play').click();

  // Wait through countdown / cinematic start
  console.log('[playwright] Waiting for vehicle spawn and building colliders to stream...');
  await page.waitForFunction(() => !!window.__game?.player, null, { timeout: 30000 });

  // Wait for 3D tiles to load and colliders to be extracted
  await page.waitForFunction(() => (window.__tiles?.colliders()?.length ?? 0) > 10, null, { timeout: 60000 });
  console.log('[playwright] Colliders extracted! Waiting 4s for render stabilization...');
  await page.waitForTimeout(4000);

  // 1. Initial Mode: REAL 3D (RAW)
  const mode1 = await page.$eval('#view-mode-text', el => el.textContent?.trim());
  console.log(`[playwright] Mode 1: ${mode1}`);
  await page.screenshot({ path: `${SCRATCH}/01_spectrum_real_3d.png` });
  copyFileSync(`${SCRATCH}/01_spectrum_real_3d.png`, `${ARTIFACT_DIR}/01_spectrum_real_3d.png`);

  // 2. Cycle to ARCADE 3D
  console.log('[playwright] Pressing KeyV to switch to Arcade 3D...');
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(1000);
  const mode2 = await page.$eval('#view-mode-text', el => el.textContent?.trim());
  console.log(`[playwright] Mode 2: ${mode2}`);
  await page.screenshot({ path: `${SCRATCH}/02_spectrum_arcade_3d.png` });
  copyFileSync(`${SCRATCH}/02_spectrum_arcade_3d.png`, `${ARTIFACT_DIR}/02_spectrum_arcade_3d.png`);

  // 3. Cycle to TEXTURED 3D
  console.log('[playwright] Pressing KeyV to switch to Textured 3D (Architectural Facades & Satellite Roofs)...');
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(1000);
  const mode3 = await page.$eval('#view-mode-text', el => el.textContent?.trim());
  console.log(`[playwright] Mode 3: ${mode3}`);
  await page.screenshot({ path: `${SCRATCH}/03_spectrum_textured_3d.png` });
  copyFileSync(`${SCRATCH}/03_spectrum_textured_3d.png`, `${ARTIFACT_DIR}/03_spectrum_textured_3d.png`);

  // 4. Cycle to MASKED 3D TILES
  console.log('[playwright] Pressing KeyV to switch to Masked 3D Tiles (Hybrid Photoreal Buildings + Flat Satellite Roads)...');
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(1500);
  const mode4 = await page.$eval('#view-mode-text', el => el.textContent?.trim());
  console.log(`[playwright] Mode 4: ${mode4}`);
  await page.screenshot({ path: `${SCRATCH}/04_spectrum_masked_3d_tiles.png` });
  copyFileSync(`${SCRATCH}/04_spectrum_masked_3d_tiles.png`, `${ARTIFACT_DIR}/04_spectrum_masked_3d_tiles.png`);

  // Switch back to Textured 3D and drive forward up Russian Hill slope to inspect building ground contact
  console.log('[playwright] Switching back to Textured 3D and driving forward to inspect hillside building contact...');
  await page.keyboard.press('KeyV'); // to REAL 3D
  await page.waitForTimeout(500);
  await page.keyboard.press('KeyV'); // to ARCADE 3D
  await page.waitForTimeout(500);
  await page.keyboard.press('KeyV'); // to TEXTURED 3D
  await page.waitForTimeout(500);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2000);
  await page.keyboard.up('KeyW');
  await page.screenshot({ path: `${SCRATCH}/03_spectrum_textured_3d_driving.png` });
  copyFileSync(`${SCRATCH}/03_spectrum_textured_3d_driving.png`, `${ARTIFACT_DIR}/03_spectrum_textured_3d_driving.png`);

  // 5. Cycle back to REAL 3D (from TEXTURED 3D -> MASKED 3D TILES -> REAL 3D)
  console.log('[playwright] Pressing KeyV to cycle through Masked to Real 3D...');
  await page.keyboard.press('KeyV'); // to MASKED 3D TILES
  await page.waitForTimeout(500);
  await page.keyboard.press('KeyV'); // to REAL 3D
  await page.waitForTimeout(1000);
  const mode5 = await page.$eval('#view-mode-text', el => el.textContent?.trim());
  const clutter5 = await page.$eval('#clutter-text', el => el.textContent?.trim()).catch(() => 'none');
  console.log(`[playwright] Mode 5: ${mode5} (${clutter5})`);
  await page.screenshot({ path: `${SCRATCH}/05_spectrum_back_to_real_3d.png` });
  copyFileSync(`${SCRATCH}/05_spectrum_back_to_real_3d.png`, `${ARTIFACT_DIR}/05_spectrum_back_to_real_3d.png`);

  console.log('\n--- VERIFICATION SUMMARY ---');
  console.log(`Step 1 (Raw Photoreal):      ${mode1}`);
  console.log(`Step 2 (Arcade 3D):           ${mode2}`);
  console.log(`Step 3 (Textured 3D Objects): ${mode3}`);
  console.log(`Step 4 (Masked 3D Tiles):     ${mode4}`);
  console.log(`Step 5 (Back to Real 3D):     ${mode5} [${clutter5}]`);

  if (consoleErrors.length > 0) {
    console.warn('\nPage logged errors:', consoleErrors);
  } else {
    console.log('\nZero console/page errors detected!');
  }
} catch (err) {
  console.error('Playwright verification failed:', err);
  process.exit(1);
} finally {
  await browser.close();
}
