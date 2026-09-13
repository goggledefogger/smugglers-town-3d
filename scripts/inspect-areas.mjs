import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';

const ARTIFACT_DIR = '/Users/Danny/.gemini/antigravity-ide/brain/17338ac7-1732-4700-9dc2-17d3d0437a25';
const SCRATCH = `${ARTIFACT_DIR}/scratch`;
mkdirSync(SCRATCH, { recursive: true });
const BASE = process.env.E2E_URL ?? 'http://localhost:5173';
const key = readFileSync('.sm-key.txt', 'utf8').trim();

const AREAS = [
  {
    id: 'sf_financial_district',
    name: 'Market & Montgomery (SF Financial District - Skyscrapers)',
    url: `${BASE}/?lat=37.7897&lon=-122.4014&debug`,
  },
  {
    id: 'midtown_manhattan',
    name: 'Empire State / 5th Ave (Midtown Manhattan - Skyscraper Canyons)',
    url: `${BASE}/?lat=40.7484&lon=-73.9857&debug`,
  },
  {
    id: 'french_quarter_nola',
    name: 'French Quarter (New Orleans - Low-Rise Historic Grid)',
    url: `${BASE}/?lat=29.9584&lon=-90.0644&debug`,
  },
  {
    id: 'lombard_steep_sf',
    name: 'Lombard Street (SF - Steep Hillside Residential)',
    url: `${BASE}/?lat=37.80404&lon=-122.42037&debug`,
  },
  {
    id: 'pioneer_square_portland',
    name: 'Pioneer Square (Portland - Compact 60m Grid & Trees)',
    url: `${BASE}/?lat=45.5189&lon=-122.6793&debug`,
  },
];

console.log('[inspect] Launching Chrome...');
const browser = await chromium.launch({ channel: 'chrome', headless: true });

try {
  for (const area of AREAS) {
    console.log(`\n======================================================`);
    console.log(`[inspect] Testing Area: ${area.name}`);
    console.log(`======================================================`);

    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const consoleErrors = [];
    page.on('pageerror', e => consoleErrors.push(String(e)));
    page.on('console', m => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });

    // Ensure API key is set
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.evaluate(k => localStorage.setItem('gmap_key', k), key);

    console.log(`[inspect] Navigating to ${area.url}...`);
    await page.goto(area.url, { waitUntil: 'load' });

    console.log('[inspect] Waiting for loader and relocate...');
    await page.waitForSelector('sr-loader[hidden]', { state: 'attached', timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('sr-relocate')?.busy, null, { timeout: 60000 });
    await page.waitForTimeout(1000);

    console.log('[inspect] Starting engine...');
    await page.locator('sr-intro button.play').click();
    await page.waitForFunction(() => !!window.__game?.player, null, { timeout: 30000 });

    console.log('[inspect] Waiting for 3D tiles & building colliders to stream...');
    await page.waitForFunction(() => (window.__tiles?.colliders()?.length ?? 0) > 5, null, { timeout: 60000 });
    await page.waitForTimeout(4000);

    const collidersCount = await page.evaluate(() => window.__tiles?.colliders()?.length ?? 0);
    const activeTiles = await page.evaluate(() => window.__tiles?.tiles?.length ?? 0);
    console.log(`[inspect] Loaded ${collidersCount} colliders and ${activeTiles} active tiles.`);

    // 1. Capture Real 3D
    await page.evaluate(() => window.__setViewMode('photoreal'));
    await page.waitForTimeout(1000);
    const realShot = `${SCRATCH}/area_${area.id}_01_real_3d.png`;
    await page.screenshot({ path: realShot });
    console.log(`[inspect] Captured Real 3D: ${realShot}`);

    // 2. Capture Projected (3D Tiles)
    await page.evaluate(() => window.__setViewMode('projected-3d-tiles'));
    await page.waitForTimeout(1500);
    const proj3dShot = `${SCRATCH}/area_${area.id}_02_projected_3d_tiles.png`;
    await page.screenshot({ path: proj3dShot });
    console.log(`[inspect] Captured Projected (3D Tiles): ${proj3dShot}`);

    // Drive forward slightly to test dynamic camera motion
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1200);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(500);
    const proj3dDriveShot = `${SCRATCH}/area_${area.id}_03_projected_3d_tiles_driving.png`;
    await page.screenshot({ path: proj3dDriveShot });
    console.log(`[inspect] Captured Projected (3D Tiles) driving: ${proj3dDriveShot}`);

    // 3. Capture Projected (2D Maps)
    await page.evaluate(() => window.__setViewMode('projected-2d-maps'));
    await page.waitForTimeout(1000);
    const proj2dShot = `${SCRATCH}/area_${area.id}_04_projected_2d_maps.png`;
    await page.screenshot({ path: proj2dShot });
    console.log(`[inspect] Captured Projected (2D Maps): ${proj2dShot}`);

    if (consoleErrors.length > 0) {
      console.warn(`[inspect] ${area.name} logged errors:`, consoleErrors);
    } else {
      console.log(`[inspect] ${area.name}: 0 errors.`);
    }

    await page.close();
  }

  console.log('\n[inspect] All areas inspected successfully!');
} catch (err) {
  console.error('[inspect] Error during area inspection:', err);
  process.exit(1);
} finally {
  await browser.close();
}
