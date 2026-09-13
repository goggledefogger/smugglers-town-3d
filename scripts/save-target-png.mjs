import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';

const ARTIFACT_DIR = '/Users/Danny/.gemini/antigravity-ide/brain/17338ac7-1732-4700-9dc2-17d3d0437a25';
const SCRATCH = `${ARTIFACT_DIR}/scratch`;
const BASE = process.env.E2E_URL ?? 'http://localhost:5173';
const key = readFileSync('.sm-key.txt', 'utf8').trim();

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

try {
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.evaluate(k => localStorage.setItem('gmap_key', k), key);
  await page.goto(`${BASE}/?lat=37.79344&lon=-122.42127&debug`, { waitUntil: 'load' });
  await page.waitForSelector('sr-loader[hidden]', { state: 'attached', timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('sr-relocate')?.busy, null, { timeout: 60000 });
  await page.locator('sr-intro button.play').click();
  await page.waitForFunction(() => (window.__tiles?.colliders()?.length ?? 0) > 10, null, { timeout: 60000 });
  await page.waitForTimeout(3000);

  // Switch to projected-3d-tiles and ensure clutterFilter is off for offscreen buffer
  await page.evaluate(() => {
    window.__setViewMode('projected-3d-tiles');
    if (window.__clutterFilter) window.__clutterFilter.mode = 'off';
  });
  await page.waitForTimeout(2000);

  // Extract tilesTarget buffer as base64 PNG
  const dataUrl = await page.evaluate(() => {
    const renderer = window.__renderer;
    const gl = renderer.renderer.getContext();
    const target = renderer.tilesTarget;
    if (!target) return null;

    const w = target.width;
    const h = target.height;
    const pixels = new Uint8Array(w * h * 4);

    renderer.renderer.setRenderTarget(target);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    renderer.renderer.setRenderTarget(null);

    // Create 2D canvas and copy with vertical flip (WebGL is bottom-to-top)
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    const imgData = ctx.createImageData(w, h);

    for (let y = 0; y < h; y++) {
      const srcRow = (h - 1 - y) * w * 4;
      const dstRow = y * w * 4;
      for (let x = 0; x < w * 4; x++) {
        imgData.data[dstRow + x] = pixels[srcRow + x];
      }
    }
    ctx.putImageData(imgData, 0, 0);
    return c.toDataURL('image/png');
  });

  if (dataUrl) {
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
    writeFileSync(`${SCRATCH}/tiles_target_buffer.png`, base64Data, 'base64');
    console.log('[capture] Successfully saved tiles_target_buffer.png!');
  } else {
    console.error('[capture] Failed: target is null');
  }
} catch (err) {
  console.error('[capture] Error:', err);
} finally {
  await browser.close();
}
