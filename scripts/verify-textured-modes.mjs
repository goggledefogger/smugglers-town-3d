import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';

const OUT = '/Users/Danny/.gemini/antigravity-ide/brain/17338ac7-1732-4700-9dc2-17d3d0437a25/scratch';
mkdirSync(OUT, { recursive: true });
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

  // 1. Initial Mode: REAL 3D
  const initialMode = await page.$eval('#view-mode-text', el => el.textContent?.trim());
  console.log(`[playwright] Mode 1: ${initialMode}`);
  // Set clutter to OFF to test raw 3D tiles
  await page.keyboard.press('KeyF'); // cycles clutter to OFF
  await page.waitForTimeout(500);
  const clutterText = await page.$eval('#clutter-text', el => el.textContent?.trim());
  console.log(`[playwright] Clutter: ${clutterText}`);
  await page.screenshot({ path: `${OUT}/01_real_3d.png` });

  // 2. Cycle to GAME 3D (ARCADE)
  console.log('[playwright] Pressing KeyV to switch to Game 3D Arcade...');
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(1000);
  const mode2 = await page.$eval('#view-mode-text', el => el.textContent?.trim());
  console.log(`[playwright] Mode 2: ${mode2}`);
  await page.screenshot({ path: `${OUT}/02_game_3d_arcade.png` });

  // 3. Cycle to TEXTURED (PLANAR)
  console.log('[playwright] Pressing KeyV to switch to Textured Planar...');
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(1000);
  const mode3 = await page.$eval('#view-mode-text', el => el.textContent?.trim());
  console.log(`[playwright] Mode 3: ${mode3}`);
  await page.screenshot({ path: `${OUT}/03_textured_planar.png` });

  // Drive forward a little bit
  console.log('[playwright] Driving forward with KeyW for 2s in Planar mode...');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2000);
  await page.keyboard.up('KeyW');
  await page.screenshot({ path: `${OUT}/03_textured_planar_driving.png` });

  // 4. Cycle to TEXTURED (HYBRID)
  console.log('[playwright] Pressing KeyV to switch to Textured Hybrid...');
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(1000);
  const mode4 = await page.$eval('#view-mode-text', el => el.textContent?.trim());
  console.log(`[playwright] Mode 4: ${mode4}`);
  await page.screenshot({ path: `${OUT}/04_textured_hybrid.png` });

  // 5. Cycle back to REAL 3D
  console.log('[playwright] Pressing KeyV to return to Real 3D...');
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(1000);
  const modeFinal = await page.$eval('#view-mode-text', el => el.textContent?.trim());
  console.log(`[playwright] Mode Final: ${modeFinal}`);

  console.log('\n--- VERIFICATION SUMMARY ---');
  console.log(`Initial: ${initialMode}`);
  console.log(`Mode 2:  ${mode2}`);
  console.log(`Mode 3:  ${mode3}`);
  console.log(`Mode 4:  ${mode4}`);
  console.log(`Final:   ${modeFinal}`);
  console.log(`Total console errors: ${consoleErrors.length}`);

  if (consoleErrors.length > 0) {
    console.error('Errors found:', consoleErrors);
    process.exit(1);
  }

  console.log('All browser verification checks passed successfully!');
} finally {
  await browser.close();
}
