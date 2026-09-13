import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const key = readFileSync('.sm-key.txt', 'utf8').trim();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://localhost:5173/');
await page.evaluate(k => localStorage.setItem('gmap_key', k), key);
await page.goto('http://localhost:5173/?lat=37.79344&lon=-122.42127&debug');
await page.waitForSelector('sr-loader[hidden]', { state: 'attached', timeout: 60000 });
await page.waitForFunction(() => !document.querySelector('sr-relocate')?.busy);
await page.locator('sr-intro button.play').click();
await page.waitForFunction(() => !!window.__game?.player);
await page.keyboard.press('Space');
await page.waitForTimeout(6000);

const dump = async (lbl) => {
  return await page.evaluate((label) => {
    const r = window.__renderer;
    const b = window.__buildingMeshView;
    const t = window.__tiles;
    const g = window.__groundStreamer;
    const c = window.__clutterFilter;
    const tm = window.__terrainMesh;
    return {
      label,
      cameraLayersMask: r?.camera?.layers?.mask,
      buildingMeshVisible: b?.group?.visible,
      tilesVisible: t?.group?.visible,
      tilesLayer: t?.group?.layers?.mask,
      tilesChildrenCount: t?.group?.children?.length,
      tilesCount: t?.tiles?.length,
      clutterMode: c?.mode,
      groundStreamerVisible: g?.group?.visible,
      groundStreamerUnderTiles: g?.underTiles,
      terrainMeshMode: tm?.mode,
      terrainMeshVisible: tm?.group?.visible,
    };
  }, lbl);
};

const before = await dump('INITIAL');
console.log('BEFORE:', JSON.stringify(before, null, 2));

// Cycle 7 times
for (let i = 0; i < 7; i++) {
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(300);
}
await page.waitForTimeout(1000);
const after = await dump('AFTER_CYCLE');
console.log('AFTER:', JSON.stringify(after, null, 2));

await browser.close();
