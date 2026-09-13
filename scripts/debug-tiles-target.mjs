import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const BASE = process.env.E2E_URL ?? 'http://localhost:5173';
const key = readFileSync('.sm-key.txt', 'utf8').trim();

console.log('[debug] Launching Chrome...');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

try {
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.evaluate(k => localStorage.setItem('gmap_key', k), key);

  console.log('[debug] Navigating to Russian Hill...');
  await page.goto(`${BASE}/?lat=37.79344&lon=-122.42127&debug`, { waitUntil: 'load' });
  await page.waitForSelector('sr-loader[hidden]', { state: 'attached', timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('sr-relocate')?.busy, null, { timeout: 60000 });
  await page.locator('sr-intro button.play').click();
  await page.waitForFunction(() => (window.__tiles?.colliders()?.length ?? 0) > 10, null, { timeout: 60000 });
  await page.waitForTimeout(3000);

  // Switch to projected-3d-tiles
  await page.evaluate(() => window.__setViewMode('projected-3d-tiles'));
  await page.waitForTimeout(2000);

  // Inspect renderer and tilesTarget
  const debugInfo = await page.evaluate(() => {
    const renderer = window.__renderer;
    const buildingView = window.__buildingMeshView;
    const tiles = window.__tiles;

    // Check layer of tiles
    let tileMeshCount = 0;
    let tileLayerCount = 0;
    tiles?.group?.traverse(o => {
      if (o.isMesh) {
        tileMeshCount++;
        if (o.layers.isEnabled(1)) tileLayerCount++;
      }
    });

    // Check building mesh
    let buildingCount = buildingView?.buildingMesh?.count ?? 0;

    // Read entire tilesTarget buffer
    const gl = renderer?.renderer?.getContext();
    const target = renderer?.tilesTarget;
    let nonZeroCount = 0;
    let nonZeroAlphaCount = 0;
    let sampleNonZero = [];
    if (gl && target) {
      renderer.renderer.setRenderTarget(target);
      const w = target.width;
      const h = target.height;
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      renderer.renderer.setRenderTarget(null);
      for (let i = 0; i < w * h; i++) {
        const r = buf[i * 4];
        const g = buf[i * 4 + 1];
        const b = buf[i * 4 + 2];
        const a = buf[i * 4 + 3];
        if (a > 0) {
          nonZeroAlphaCount++;
          if (sampleNonZero.length < 5) {
            sampleNonZero.push({ x: i % w, y: Math.floor(i / w), r, g, b, a });
          }
        }
        if (r > 0 || g > 0 || b > 0) nonZeroCount++;
      }
    }

    return {
      tileMeshCount,
      tileLayerCount,
      buildingCount,
      tilesTargetDimensions: target ? { width: target.width, height: target.height } : null,
      nonZeroAlphaCount,
      nonZeroCount,
      sampleNonZero,
      resolutionUniform: buildingView?.uResolution?.value ? { x: buildingView.uResolution.value.x, y: buildingView.uResolution.value.y } : null,
      textureStyleUniform: buildingView?.uTextureStyle?.value,
    };
  });

  console.log('[debug] Debug info:', JSON.stringify(debugInfo, null, 2));

} catch (err) {
  console.error('[debug] Error:', err);
} finally {
  await browser.close();
}
