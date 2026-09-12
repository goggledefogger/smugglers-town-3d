import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';

const ARTIFACT_DIR = '/Users/Danny/.gemini/antigravity-ide/brain/17338ac7-1732-4700-9dc2-17d3d0437a25';
const SCRATCH = `${ARTIFACT_DIR}/scratch`;
mkdirSync(SCRATCH, { recursive: true });
const BASE = process.env.E2E_URL ?? 'http://localhost:5173';
const LAT = '37.80404'; // Lombard Street SF
const LON = '-122.42037';
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
  await page.goto(`${BASE}/?lat=37.79344&lon=-122.42127&debug`, { waitUntil: 'load' });

  console.log('[playwright] Waiting for loader and relocate to complete...');
  await page.waitForSelector('sr-loader[hidden]', { state: 'attached', timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('sr-relocate')?.busy, null, { timeout: 60000 });
  await page.waitForTimeout(1000);

  console.log('[playwright] Clicking Start Engine button...');
  await page.locator('sr-intro button.play').click();

  console.log('[playwright] Waiting for vehicle spawn and building colliders to stream...');
  await page.waitForFunction(() => !!window.__game?.player, null, { timeout: 30000 });

  // Wait for 3D tiles to load and colliders to be extracted
  await page.waitForFunction(() => (window.__tiles?.colliders()?.length ?? 0) > 10, null, { timeout: 60000 });
  console.log('[playwright] Colliders extracted! Waiting 4s for render stabilization...');
  await page.waitForTimeout(4000);

  // 1. Initial Mode: REAL 3D
  const mode1 = await page.$eval('#view-mode-text', el => el.textContent?.trim());
  console.log(`[playwright] Mode 1: ${mode1}`);
  await page.screenshot({ path: `${SCRATCH}/01_spectrum_real_3d.png` });
  copyFileSync(`${SCRATCH}/01_spectrum_real_3d.png`, `${ARTIFACT_DIR}/01_real_3d.png`);

  // 2. Cycle to MASKED 3D TILES
  console.log('[playwright] Pressing KeyV to switch to Masked 3D Tiles...');
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(1000);
  const mode2 = await page.$eval('#view-mode-text', el => el.textContent?.trim());
  console.log(`[playwright] Mode 2: ${mode2}`);
  await page.screenshot({ path: `${SCRATCH}/02_masked_3d_tiles.png` });
  copyFileSync(`${SCRATCH}/02_masked_3d_tiles.png`, `${ARTIFACT_DIR}/02_masked_3d_tiles.png`);

  // 3. Cycle to PROJECTED 3D (The 6th mode!)
  console.log('[playwright] Pressing KeyV to switch to PROJECTED 3D...');
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(1500);
  const mode3 = await page.$eval('#view-mode-text', el => el.textContent?.trim());
  console.log(`[playwright] Mode 3: ${mode3}`);
  await page.screenshot({ path: `${SCRATCH}/03_projected_3d.png` });
  copyFileSync(`${SCRATCH}/03_projected_3d.png`, `${ARTIFACT_DIR}/03_projected_3d.png`);

  // Drive forward up the street in PROJECTED 3D to inspect building facades and ground contact
  console.log('[playwright] Driving forward in PROJECTED 3D...');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1500);
  await page.keyboard.up('KeyW');
  await page.screenshot({ path: `${SCRATCH}/03_projected_3d_driving.png` });
  copyFileSync(`${SCRATCH}/03_projected_3d_driving.png`, `${ARTIFACT_DIR}/03_projected_3d_driving.png`);

  // 4. Cycle to TEXTURED 3D (Hybrid)
  console.log('[playwright] Pressing KeyV to switch to Textured 3D (Hybrid)...');
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(1000);
  const mode4 = await page.$eval('#view-mode-text', el => el.textContent?.trim());
  console.log(`[playwright] Mode 4: ${mode4}`);
  await page.screenshot({ path: `${SCRATCH}/04_textured_3d_hybrid.png` });
  copyFileSync(`${SCRATCH}/04_textured_3d_hybrid.png`, `${ARTIFACT_DIR}/04_textured_3d_hybrid.png`);

  // 5. Cycle to TEXTURED (PLANAR)
  console.log('[playwright] Pressing KeyV to switch to Textured (Planar)...');
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(1000);
  const mode5 = await page.$eval('#view-mode-text', el => el.textContent?.trim());
  console.log(`[playwright] Mode 5: ${mode5}`);
  await page.screenshot({ path: `${SCRATCH}/05_textured_3d_planar.png` });
  copyFileSync(`${SCRATCH}/05_textured_3d_planar.png`, `${ARTIFACT_DIR}/05_textured_3d_planar.png`);

  // 6. Cycle to ARCADE 3D
  console.log('[playwright] Pressing KeyV to switch to Arcade 3D...');
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(1000);
  const mode6 = await page.$eval('#view-mode-text', el => el.textContent?.trim());
  console.log(`[playwright] Mode 6: ${mode6}`);
  await page.screenshot({ path: `${SCRATCH}/06_arcade_3d.png` });
  copyFileSync(`${SCRATCH}/06_arcade_3d.png`, `${ARTIFACT_DIR}/06_arcade_3d.png`);

  // 7. Cycle back to REAL 3D
  console.log('[playwright] Pressing KeyV to return to Real 3D...');
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(1000);
  const modeFinal = await page.$eval('#view-mode-text', el => el.textContent?.trim());
  console.log(`[playwright] Final Mode: ${modeFinal}`);

  console.log('\n--- 6-MODE SPECTRUM VERIFICATION SUMMARY ---');
  console.log(`Mode 1: ${mode1}`);
  console.log(`Mode 2: ${mode2}`);
  console.log(`Mode 3: ${mode3}`);
  console.log(`Mode 4: ${mode4}`);
  console.log(`Mode 5: ${mode5}`);
  console.log(`Mode 6: ${mode6}`);
  console.log(`Cycle Return: ${modeFinal}`);

  if (consoleErrors.length > 0) {
    console.warn('\nPage logged errors:', consoleErrors);
  } else {
    console.log('\nZero console/page errors detected across all 6 modes!');
  }
} catch (err) {
  console.error('Playwright verification failed:', err);
  process.exit(1);
} finally {
  await browser.close();
}
