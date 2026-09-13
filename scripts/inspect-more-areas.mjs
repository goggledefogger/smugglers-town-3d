import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';

const ARTIFACT_DIR = '/Users/Danny/.gemini/antigravity-ide/brain/17338ac7-1732-4700-9dc2-17d3d0437a25';
const SCRATCH = `${ARTIFACT_DIR}/scratch`;
mkdirSync(SCRATCH, { recursive: true });
const BASE = process.env.E2E_URL ?? 'http://localhost:5173';
const key = readFileSync('.sm-key.txt', 'utf8').trim();

const MORE_AREAS = [
  {
    id: 'columbus_transamerica_sf',
    name: 'Columbus Ave & Transamerica Pyramid, SF',
    url: `${BASE}/?lat=37.7952&lon=-122.4028&debug`,
  },
  {
    id: 'union_square_sf',
    name: 'Union Square & Powell St, SF',
    url: `${BASE}/?lat=37.7879&lon=-122.4075&debug`,
  },
  {
    id: 'city_of_london_uk',
    name: 'City of London & Leadenhall, UK',
    url: `${BASE}/?lat=51.5145&lon=-0.0803&debug`,
  },
];

console.log('[inspect-more] Launching Chrome...');
const browser = await chromium.launch({ channel: 'chrome', headless: true });

try {
  for (const area of MORE_AREAS) {
    console.log(`\n======================================================`);
    console.log(`[inspect-more] Testing Area: ${area.name}`);
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

    console.log(`[inspect-more] Navigating to ${area.url}...`);
    await page.goto(area.url, { waitUntil: 'load' });

    console.log('[inspect-more] Waiting for loader and relocate...');
    await page.waitForSelector('sr-loader[hidden]', { state: 'attached', timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('sr-relocate')?.busy, null, { timeout: 60000 });
    await page.waitForTimeout(1000);

    console.log('[inspect-more] Starting engine...');
    await page.locator('sr-intro button.play').click();
    await page.waitForFunction(() => !!window.__game?.player, null, { timeout: 30000 });

    console.log('[inspect-more] Waiting for 3D tiles & building colliders to stream...');
    await page.waitForFunction(() => (window.__tiles?.colliders()?.length ?? 0) > 5, null, { timeout: 60000 });
    await page.waitForTimeout(4000);

    const collidersCount = await page.evaluate(() => window.__tiles?.colliders()?.length ?? 0);
    const activeTiles = await page.evaluate(() => window.__tiles?.tiles?.length ?? 0);
    console.log(`[inspect-more] Loaded ${collidersCount} colliders and ${activeTiles} active tiles.`);

    // 1. Capture Real 3D
    await page.evaluate(() => window.__setViewMode('photoreal'));
    await page.waitForTimeout(1000);
    const realShot = `${SCRATCH}/area_${area.id}_01_real_3d.png`;
    await page.screenshot({ path: realShot });
    console.log(`[inspect-more] Captured Real 3D: ${realShot}`);

    // 2. Capture Projected (3D Tiles)
    await page.evaluate(() => window.__setViewMode('projected-3d-tiles'));
    await page.waitForTimeout(1500);
    const proj3dShot = `${SCRATCH}/area_${area.id}_02_projected_3d_tiles.png`;
    await page.screenshot({ path: proj3dShot });
    console.log(`[inspect-more] Captured Projected (3D Tiles): ${proj3dShot}`);

    // Drive forward slightly to test dynamic camera motion
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1500);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(500);
    const proj3dDriveShot = `${SCRATCH}/area_${area.id}_03_projected_3d_tiles_driving.png`;
    await page.screenshot({ path: proj3dDriveShot });
    console.log(`[inspect-more] Captured Projected (3D Tiles) driving: ${proj3dDriveShot}`);

    // 3. Capture Projected (2D Maps)
    await page.evaluate(() => window.__setViewMode('projected-2d-maps'));
    await page.waitForTimeout(1000);
    const proj2dShot = `${SCRATCH}/area_${area.id}_04_projected_2d_maps.png`;
    await page.screenshot({ path: proj2dShot });
    console.log(`[inspect-more] Captured Projected (2D Maps): ${proj2dShot}`);

    if (consoleErrors.length > 0) {
      console.warn(`[inspect-more] ${area.name} logged errors:`, consoleErrors);
    } else {
      console.log(`[inspect-more] ${area.name}: 0 errors.`);
    }

    await page.close();
  }

  console.log('\n[inspect-more] All additional areas inspected successfully!');
} catch (err) {
  console.error('[inspect-more] Error during additional area inspection:', err);
  process.exit(1);
} finally {
  await browser.close();
}
