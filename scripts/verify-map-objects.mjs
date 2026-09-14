import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

// Run only after the mode is ready: node scripts/verify-map-objects.mjs
// MAP_OBJECTS_REAL=1 adds live SF; MAP_OBJECTS_KEY overrides .sm-key.txt
const base = new URL(process.env.E2E_URL ?? 'http://localhost:5173/');
const artifacts = resolve(process.env.MAP_OBJECTS_ARTIFACT_DIR ?? '.playwright-mcp/map-objects');
const real = process.env.MAP_OBJECTS_REAL === '1';
const modes = [
  'VIEW: REAL 3D', 'VIEW: MAP + OBJECTS', 'VIEW: MASKED 3D TILES',
  'VIEW: BEST 3D', 'VIEW: PROJECTED (3D TILES)', 'VIEW: PROJECTED (2D MAPS)',
  'VIEW: TEXTURED 3D', 'VIEW: TEXTURED (PLANAR)', 'VIEW: ARCADE 3D',
];
let key = '';
let browser;
const redact = value => {
  let text = String(value);
  for (const secret of [key, encodeURIComponent(key)]) {
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  return text;
};

async function waitMode(page, label) {
  await page.waitForFunction(expected => {
    const p = window.__mapObjectsProbe;
    return document.getElementById('view-mode-text')?.textContent === expected
      && p.frames.slice(-5).length === 5
      && p.frames.slice(-5).every(f => f.label === expected);
  }, label);
}

async function waitGameplay(page) {
  await page.waitForFunction(() => window.__game.matchPhase === 'playing' && window.__game.player.body.onGround
    && !document.getElementById('hud').classList.contains('cinematic')
    && getComputedStyle(document.querySelector('sr-banner').shadowRoot.querySelector('.banner')).opacity === '0');
}

async function checkMap(page, isReal) {
  await waitMode(page, modes[1]);
  const state = await page.evaluate(() => {
    const r = window.__renderer;
    const b = window.__buildingMeshView;
    return {
      visible: b.visible, style: b.getTextureStyle(), mode: b.getMode(),
      layers: r.camera.layers.mask, tiles: window.__tiles?.group.visible ?? null,
      lights: [r.sun.intensity, r.ambient.intensity, r.hemi.intensity, r.renderer.toneMappingExposure],
      violations: window.__mapObjectsProbe.violations,
    };
  });
  assert.equal(state.visible, true, 'collision buildings must be visible');
  assert.equal(state.style, 'map-objects', 'dedicated building texture style');
  assert.equal(state.mode, 'textured');
  assert.equal(state.layers & 1, 1, 'game layer remains enabled');
  assert.equal(state.layers & 2, 0, 'tile camera layer is disabled');
  assert.equal(state.tiles, isReal ? false : null, 'live tile group must be hidden');
  assert.deepEqual(state.lights, isReal ? [1, 0.35, 0.35, 1] : [1.4, 0.6, 0.5, 1.05]);
  assert.deepEqual(state.violations, [], 'no transient map-objects render violations');
}

async function checkLayout(page) {
  const layout = await page.evaluate(() => {
    const rect = element => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    return {
      width: innerWidth, height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      elements: [window.__renderer.renderer.domElement, document.getElementById('view-mode-btn'),
        ...document.querySelectorAll('#hud .hud-corner')].map(rect),
    };
  });
  assert.ok(layout.scrollWidth <= layout.width, 'no horizontal overflow');
  assert.ok(layout.scrollHeight <= layout.height, 'no vertical overflow');
  assert.equal(layout.elements.length, 6, 'canvas, mode button and four HUD corners exist');
  for (const r of layout.elements) {
    assert.ok(r.width > 0 && r.height > 0 && r.x >= -1 && r.y >= -1
      && r.right <= layout.width + 1 && r.bottom <= layout.height + 1,
    `gameplay element outside viewport: ${JSON.stringify(r)}`);
  }
}

async function runCase(name, viewport, isReal) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1,
    isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(redact(error.stack ?? error.message)));
  page.on('console', message => {
    const text = message.text();
    if (message.type() === 'error' || /shader.*(error|fail)|WebGL.*(INVALID|CONTEXT_LOST|error)|context lost/i.test(text)) {
      errors.push(redact(text));
    }
  });
  try {
    await context.addInitScript(({ apiKey, origin }) => {
      if (location.origin !== origin) return;
      localStorage.clear();
      if (apiKey) localStorage.setItem('gmap_key', apiKey);
      let seed = 0x6d6170;
      Math.random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
      };
      window.__mapObjectsContextLost = false;
      document.addEventListener('webglcontextlost', () => { window.__mapObjectsContextLost = true; }, true);
    }, { apiKey: isReal ? key : '', origin: base.origin });
    const url = new URL(base);
    url.search = url.hash = '';
    await page.goto(url.href, { waitUntil: 'load' });
    assert.match(await page.title(), /^Smugglers Town 3D/, 'E2E_URL must serve this app');
    await page.waitForFunction(() => window.__game?.terrainProvider.isReal === false
      && !!window.__buildingMeshView && !!window.__renderer);
    await page.locator('sr-intro button.play').click();
    await page.waitForFunction(() => !!window.__game?.player && !document.querySelector('sr-intro'));
    await page.keyboard.press('Space');
    await waitGameplay(page);

    await page.evaluate(() => {
      const app = window.__renderer;
      const renderer = app.renderer;
      const probe = window.__mapObjectsProbe = { frames: [], violations: [], total: 0, active: null };
      const render = renderer.render;
      const target = renderer.setRenderTarget;
      const appRender = app.render;
      renderer.render = function (...args) {
        if (probe.active) probe.active.renders++;
        return render.apply(this, args);
      };
      renderer.setRenderTarget = function (...args) {
        if (probe.active) probe.active.targets++;
        return target.apply(this, args);
      };
      app.render = function (...args) {
        const frame = { label: document.getElementById('view-mode-text').textContent,
          renders: 0, targets: 0, layersBefore: this.camera.layers.mask,
          tilesBefore: window.__tiles?.group.visible ?? null };
        probe.active = frame;
        try { return appRender.apply(this, args); }
        finally {
          frame.layersAfter = this.camera.layers.mask;
          frame.tilesAfter = window.__tiles?.group.visible ?? null;
          probe.active = null;
          if (frame.label === 'VIEW: MAP + OBJECTS'
            && (frame.renders !== 1 || frame.targets !== 0 || frame.layersBefore !== frame.layersAfter
              || frame.tilesBefore !== frame.tilesAfter)) probe.violations.push(frame);
          probe.frames.push(frame);
          if (probe.frames.length > 100) probe.frames.shift();
          probe.total++;
        }
      };

      // Snapshot once; compare both identities and buffer contents without serializing terrain
      const checks = [];
      const watch = (object, key) => {
        const value = object[key];
        checks.push(() => object[key] === value);
        if (ArrayBuffer.isView(value) || Array.isArray(value)) {
          const copy = value.slice();
          checks.push(() => value.length === copy.length && copy.every((v, i) => v === value[i]));
        }
      };
      watch(window.__game, 'buildingColliders');
      for (const c of window.__game.buildingColliders) {
        for (const field of ['min', 'max', 'kind']) watch(c, field);
        for (const p of [c.min, c.max]) for (const axis of ['x', 'y', 'z']) watch(p, axis);
      }
      watch(window.__terrainMesh, 'mesh');
      for (const root of [window.__buildingMeshView.group, window.__terrainMesh.mesh]) {
        root.traverse(o => {
          watch(o, 'children');
          if (!o.geometry) return;
          watch(o, 'geometry');
          watch(o, 'count');
          for (const [owner, field] of [[o, 'instanceMatrix'], [o.geometry, 'index'],
            ...Object.keys(o.geometry.attributes).map(k => [o.geometry.attributes, k])]) {
            watch(owner, field);
            if (owner[field]) watch(owner[field], 'array');
          }
        });
      }
      probe.unchanged = () => checks.every(check => check());
    });

    assert.ok(await page.evaluate(() => window.__game.buildingColliders.length > 0
      && window.__buildingMeshView.group.children.length > 0), 'nonempty geometry/collider baseline');
    await waitMode(page, modes[0]);
    await page.locator('#view-mode-btn').click();
    await checkMap(page, false);
    assert.ok(await page.evaluate(() => window.__mapObjectsProbe.unchanged()),
      'entering map-objects must preserve geometry and colliders');
    if (isReal) {
      await page.evaluate(() => { window.__mapObjectsOldWorld = window.__game.terrainProvider; });
      const query = page.locator('sr-relocate #q');
      if (!await query.isVisible()) await page.locator('sr-relocate .toggle').click();
      await query.fill('37.79344, -122.42127');
      await query.press('Enter');
      await page.waitForFunction(() => !document.querySelector('sr-relocate').busy, null, { timeout: 120000 });
      assert.ok(await page.evaluate(() => window.__game.terrainProvider !== window.__mapObjectsOldWorld
        && window.__game.terrainProvider.isReal), 'relocation must adopt real terrain');
      await page.waitForFunction(() => window.__tiles?.tiles?.length > 0
        && !!window.__terrainMesh.sourceTexture
        && window.__game.buildingColliders.some(c => c.kind !== 'prop'), null, { timeout: 120000 });
      if (await page.locator('#skip-btn').isVisible()) await page.locator('#skip-btn').click();
      await waitGameplay(page);
      await page.locator('#view-mode-btn').focus();
      await page.screenshot({ path: resolve(artifacts, `${name}-relocated-map-objects.png`) });
      try { await checkMap(page, true); }
      catch (error) { errors.push(`In-session relocation: ${redact(error.message)}`); }
    }
    await checkLayout(page);
    await page.screenshot({ path: resolve(artifacts, `${name}-map-objects.png`) });

    // One complete cycle; both hotkeys enter the new mode across the two viewports
    for (let i = 2; i <= modes.length + 1; i++) {
      await page.keyboard.press(i === modes.length + 1 ? (viewport.width < 500 ? 'KeyV' : 'KeyG')
        : i % 2 ? 'KeyG' : 'KeyV');
      await waitMode(page, modes[i % modes.length]);
      // Streaming legitimately rebuilds city geometry; use the desert for invariance
      if (!isReal) assert.ok(await page.evaluate(() => window.__mapObjectsProbe.unchanged()),
        `mode switch changed geometry/colliders at ${modes[i % modes.length]}`);
      if (i === 3) {
        const frames = await page.evaluate(() => window.__mapObjectsProbe.frames.slice(-5));
        assert.ok(frames.every(f => f.renders === 2 && f.targets >= 2),
          'Best 3D positive control must detect the offscreen pass and target bindings');
        if (isReal) await page.screenshot({ path: resolve(artifacts, `${name}-best-3d.png`) });
      }
    }
    await checkMap(page, isReal);
    await checkLayout(page);
    await page.screenshot({ path: resolve(artifacts, `${name}-map-objects-after-best.png`) });

    const contract = await page.evaluate(() => {
      const r = window.__renderer;
      const mask = r.camera.layers.mask;
      try {
        r.setProjecting3dTiles(false);
        r.render();
        return window.__mapObjectsProbe.frames.at(-1);
      } finally { r.camera.layers.mask = mask; }
    });
    assert.equal(contract.renders, 1, 'explicit setProjecting3dTiles(false): one render');
    assert.equal(contract.targets, 0, 'explicit setProjecting3dTiles(false): no target binding');

    if (!isReal) await checkShader(page);
    const start = await page.evaluate(() => {
      const { x, z } = window.__game.player.body.pos;
      return { x, z, frame: window.__mapObjectsProbe.total };
    });
    await page.keyboard.down('KeyW');
    try {
      await page.waitForFunction(p => {
        const pos = window.__game.player.body.pos;
        return Math.hypot(pos.x - p.x, pos.z - p.z) > 2 && window.__mapObjectsProbe.total > p.frame + 5;
      }, start);
    } finally { await page.keyboard.up('KeyW'); }
    await checkMap(page, isReal);
    await page.screenshot({ path: resolve(artifacts, `${name}-map-objects-driving.png`) });
    const gpu = await page.evaluate(() => {
      const gl = window.__renderer.renderer.getContext();
      return { lost: window.__mapObjectsContextLost || gl.isContextLost(), error: gl.getError(),
        badPrograms: window.__renderer.renderer.info.programs.filter(p => p.diagnostics?.runnable === false).length };
    });
    assert.deepEqual(gpu, { lost: false, error: 0, badPrograms: 0 }, 'healthy WebGL context and shaders');
    assert.equal(errors.length, 0, 'no JavaScript, console, WebGL shader, or relocation errors');
    console.log(`[map-objects] PASS ${name}: input cycle, render passes, lighting, gameplay, layout${isReal ? '' : ', geometry/colliders, shader controls'}`);
  } catch (error) {
    await page.screenshot({ path: resolve(artifacts, `${name}-failure.png`) }).catch(() => {});
    console.error(`[map-objects] FAIL ${name}: ${redact(error.stack ?? error)}`);
    if (errors.length) console.error(redact(errors.join('\n')));
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

async function checkShader(page) {
  const pixels = await page.evaluate(() => {
    const app = window.__renderer;
    const renderer = app.renderer;
    const live = window.__buildingMeshView;
    const fixture = new live.constructor();
    const scene = new app.scene.constructor();
    const camera = app.camera.clone();
    const vector = app.camera.position.constructor;
    const textures = [];
    const texture = rgb => {
      // Three.js Texture.clone() shares its Source, so assigning image mutates every clone
      // Independent satellite/tile controls need separate DataTexture sources
      const t = new fixture.dummyTex.constructor(new Uint8Array([...rgb, 255]), 1, 1);
      t.colorSpace = renderer.outputColorSpace;
      t.needsUpdate = true;
      textures.push(t);
      return t;
    };
    const red = texture([230, 35, 20]);
    const blue = texture([20, 45, 230]);
    const green = texture([15, 245, 30]);
    const magenta = texture([245, 15, 230]);
    fixture.update([{ min: new vector(-10, 0, -10), max: new vector(10, 16, 10) }]);
    fixture.setMode(live.getMode());
    fixture.setTextureStyle(live.getTextureStyle());
    fixture.visible = true;
    const lights = [app.sun.clone(), app.ambient.clone(), app.hemi.clone()];
    const exposure = renderer.toneMappingExposure;
    scene.add(fixture.group, ...lights);
    camera.position.set(35, 32, 45);
    camera.lookAt(0, 8, 0);
    camera.updateMatrixWorld(true);
    const canvas = renderer.domElement;
    const gl = renderer.getContext();
    const sample = point => {
      const p = point.project(camera);
      const bytes = new Uint8Array(4);
      gl.readPixels(Math.floor((p.x + 1) * canvas.width / 2), Math.floor((p.y + 1) * canvas.height / 2),
        1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      return Array.from(bytes).slice(0, 3);
    };
    const draw = () => {
      renderer.render(scene, camera);
      return { roof: sample(new vector(0, 16, 0)), wall: sample(new vector(0, 10.75, 10)),
        window: sample(new vector(1.5, 10.75, 10)) };
    };
    try {
      fixture.setTexture(red, 100);
      fixture.setTilesTexture(green, app.getResolution());
      const first = draw();
      fixture.setTexture(blue, 100);
      const satelliteChanged = draw();
      fixture.setTilesTexture(magenta, app.getResolution());
      const tilesChanged = draw();
      renderer.toneMappingExposure = 0.2;
      const exposureChanged = draw();
      renderer.toneMappingExposure = exposure;
      for (const light of lights) light.intensity *= 0.1;
      const lightingChanged = draw();
      for (const light of lights) light.intensity *= 10;
      fixture.setTexture(null, 100);
      const fallback = draw();
      fixture.setMode('arcade');
      const untextured = draw();
      fixture.visible = false;
      const absent = draw();
      return { first, satelliteChanged, tilesChanged, exposureChanged, lightingChanged, fallback, untextured, absent };
    } finally {
      renderer.toneMappingExposure = exposure;
      fixture.dispose();
      fixture.boxGeo.dispose();
      fixture.buildingMat.dispose();
      fixture.deckMat.dispose();
      fixture.dummyTex.dispose();
      for (const t of textures) t.dispose();
      app.render();
    }
  });
  const distance = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0);
  assert.ok(distance(pixels.first.roof, pixels.satelliteChanged.roof) > 60,
    'roof pixels must respond to satellite data, not just a style flag');
  assert.ok(distance(pixels.first.roof, [230, 35, 20]) <= 3, 'unlit roof matches source sRGB pixels');
  assert.deepEqual(pixels.first.wall, pixels.satelliteChanged.wall, 'satellite swap cannot tint masonry');
  assert.deepEqual(pixels.first.window, pixels.satelliteChanged.window, 'satellite swap cannot tint windows');
  assert.ok(pixels.first.wall.reduce((a, b) => a + b) - pixels.first.window.reduce((a, b) => a + b) > 15,
    'window aperture is darker than adjacent masonry');
  for (const changed of [pixels.lightingChanged, pixels.exposureChanged]) {
    assert.deepEqual(changed.roof, pixels.satelliteChanged.roof, 'satellite roof ignores lighting and exposure');
    assert.ok(distance(changed.wall, pixels.satelliteChanged.wall) > 20, 'lit wall responds as a control');
  }
  assert.deepEqual(pixels.fallback.roof, pixels.untextured.roof, 'null satellite uses the untextured roof');
  assert.ok(distance(pixels.fallback.roof, pixels.satelliteChanged.roof) > 60, 'null satellite cannot retain stale imagery');
  assert.ok(Math.max(...pixels.fallback.roof) > 15, 'null satellite roof fallback is not black');
  for (const face of ['roof', 'wall', 'window']) {
    assert.ok(Math.max(...pixels.first[face]) > 15, `${face} is not black`);
    assert.ok(distance(pixels.first[face], pixels.absent[face]) > 20,
      `${face} sample must hit rendered building, with absent-geometry negative control`);
    assert.deepEqual(pixels.satelliteChanged[face], pixels.tilesChanged[face],
      `${face} must ignore tile projection texture after Best 3D`);
  }
  console.log(`[map-objects] Pixels: roof=${pixels.first.roof}; swapped=${pixels.satelliteChanged.roof}; `
    + `wall=${pixels.first.wall}; window=${pixels.first.window}; fallback=${pixels.fallback.roof}; `
    + `dim-wall=${pixels.lightingChanged.wall}; low-exposure-wall=${pixels.exposureChanged.wall}`);
}

try {
  mkdirSync(artifacts, { recursive: true });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  await runCase('desktop-desert', { width: 1280, height: 800 }, false);
  await runCase('mobile-desert', { width: 390, height: 844 }, false);
  if (real) {
    key = (process.env.MAP_OBJECTS_KEY ?? process.env.GOOGLE_MAPS_API_KEY
      ?? readFileSync(new URL('../.sm-key.txt', import.meta.url), 'utf8')).trim();
    assert.ok(key, 'MAP_OBJECTS_REAL=1 requires MAP_OBJECTS_KEY, GOOGLE_MAPS_API_KEY, or .sm-key.txt');
    await runCase('desktop-sf', { width: 1280, height: 800 }, true);
  }
  else console.log('[map-objects] SKIP real city (enable with MAP_OBJECTS_REAL=1)');
  console.log(`[map-objects] Screenshots: ${artifacts}`);
} catch (error) {
  console.error(`[map-objects] FAIL ${redact(error.stack ?? error)}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
