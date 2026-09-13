import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

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

  const diag = await page.evaluate(() => {
    const tiles = window.__tiles;
    const renderer = window.__renderer;
    const meshes = [];
    tiles.group.traverse(o => {
      if (o.isMesh) {
        meshes.push({
          type: o.type,
          visible: o.visible,
          layersMask: o.layers.mask,
          matType: o.material?.type,
          hasMap: !!o.material?.map,
          toneMapped: o.material?.toneMapped,
          transparent: o.material?.transparent,
          opacity: o.material?.opacity,
          roughness: o.material?.roughness,
          metalness: o.material?.metalness,
        });
      }
    });

    // Check lights
    const lights = [];
    renderer.scene.traverse(o => {
      if (o.isLight) {
        lights.push({
          type: o.type,
          layersMask: o.layers.mask,
          intensity: o.intensity,
          visible: o.visible
        });
      }
    });

    return {
      totalMeshes: meshes.length,
      sampleMesh: meshes[0],
      sampleMesh2: meshes[Math.floor(meshes.length / 2)],
      lights,
      sceneBg: renderer.scene.background?.constructor?.name,
      sceneEnv: renderer.scene.environment?.constructor?.name,
      cameraLayers: renderer.camera.layers.mask
    };
  });

  console.log('[diagnose]', JSON.stringify(diag, null, 2));
} catch (e) {
  console.error('[diagnose error]', e);
} finally {
  await browser.close();
}
