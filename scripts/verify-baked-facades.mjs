import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as pollInterval } from 'node:timers/promises';
import { chromium } from 'playwright-core';

// E2E_URL, E2E_TIMEOUT_MS, E2E_RESOLUTION, E2E_RELOCATE=1, E2E_HEADED=1, E2E_START_SERVER=1
const base = new URL(process.env.E2E_URL ?? 'http://localhost:5173/');
const output = resolve('.playwright-mcp/baked-facades');
const timeout = Number(process.env.E2E_TIMEOUT_MS ?? 120000);
const scenario = { lat: 37.79068, lon: -122.40404, x: -232, z: -109, ground: 53.2 };
const report = { scenario, checks: [], blockers: [], errors: [], networkFailures: [], shots: [] };
let key = '', browser, page, server;
const redact = value => {
  let text = String(value);
  for (const secret of [key, encodeURIComponent(key)]) {
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  return text.replace(/AIza[\w-]+/g, '[REDACTED]');
};
const check = (name, passed, details) => {
  report.checks.push({ name, passed: Boolean(passed), details });
  if (!passed) report.blockers.push(name);
};
const waitMode = label => page.waitForFunction(expected =>
  document.getElementById('view-mode-text')?.textContent === expected, label);
const savePng = (name, data) => {
  const path = resolve(output, name);
  writeFileSync(path, Buffer.from(data.split(',')[1], 'base64'));
  report.shots.push(path);
};

try {
  assert.ok(Number.isFinite(timeout) && timeout > 0, 'E2E_TIMEOUT_MS must be positive');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Only a local app may receive the API key');
  let response;
  try { response = await fetch(base, { signal: AbortSignal.timeout(10000) }); }
  catch (error) {
    if (process.env.E2E_START_SERVER !== '1') throw new Error('No local app detected; start Vite or opt into E2E_START_SERVER=1', { cause: error });
    server = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', base.hostname,
      '--port', base.port || '5173', '--strictPort'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let serverError = '';
    server.on('error', error => { serverError = redact(error.message); });
    server.stderr.on('data', data => { serverError += redact(data); });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      assert.ok(server.exitCode === null && !serverError, `Temporary Vite failed: ${serverError}`);
      try { response = await fetch(base, { signal: AbortSignal.timeout(1000) }); if (response.ok) break; }
      catch { /* Poll the HTTP readiness signal, not elapsed startup time */ }
      await pollInterval(100);
    }
    assert.ok(response?.ok, 'Temporary Vite did not become ready within 20 seconds');
    report.temporaryServer = true;
  }
  assert.ok(response.ok && (await response.text()).includes('Smugglers Town'), 'Existing local app not detected; no server was started');
  key = readFileSync(new URL('../.sm-key.txt', import.meta.url), 'utf8').trim();
  assert.ok(key, '.sm-key.txt is empty');
  mkdirSync(output, { recursive: true });
  browser = await chromium.launch({ channel: 'chrome', headless: process.env.E2E_HEADED !== '1' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await context.addInitScript(({ origin, key }) => {
    if (location.origin === origin) localStorage.setItem('gmap_key', key);
  }, { origin: base.origin, key });
  page = await context.newPage();
  page.setDefaultTimeout(timeout);
  page.on('pageerror', error => report.errors.push(redact(error.message)));
  page.on('console', message => {
    if (message.type() === 'error') report.errors.push(redact(message.text()));
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      const url = new URL(response.url());
      report.networkFailures.push({ host: url.host, path: redact(url.pathname), status: response.status() });
    }
  });
  const url = new URL(base);
  url.search = new URLSearchParams({ lat: String(scenario.lat), lon: String(scenario.lon), debug: '1' }).toString();
  url.hash = '';
  await page.goto(url.href, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game?.terrainProvider.isReal && window.__tiles?.tileCount > 0
    && window.__facadeBaker && !document.querySelector('sr-relocate')?.busy
    && document.querySelector('sr-loader')?.hidden);
  await page.locator('sr-intro button.play').click();
  await page.waitForFunction(() => !!window.__game?.player && !document.querySelector('sr-intro'));
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__game.matchPhase === 'playing'
    && !document.getElementById('hud').classList.contains('cinematic'));

  report.position = await page.evaluate(({ scenario, resolution }) => {
    const app = window.__renderer, baker = window.__facadeBaker, game = window.__game, tiles = window.__tiles;
    const body = game.player.body;
    const p = window.__bakedProbe = {
      restore: [], frames: [], captures: [], active: null, lock: true,
      camera: app.camera.clone(), total: 0, clearEvents: [],
    };
    p.patch = (owner, field, replacement) => {
      const own = Object.getOwnPropertyDescriptor(owner, field);
      const original = owner[field];
      owner[field] = replacement(original);
      p.restore.push(() => own ? Object.defineProperty(owner, field, own) : delete owner[field]);
    };
    p.gameUpdate = game.update;
    p.patch(game, 'update', () => function () {});
    body.pos.set(scenario.x, scenario.ground + body.cfg.groundClearance, scenario.z);
    body.groundY = scenario.ground;
    body.vel.set(0, 0, 0);
    body.angVel.set(0, 0, 0);
    body.quat.identity();
    body.snapPrev();
    body.onGround = true;
    p.camera.position.set(scenario.x, scenario.ground + 3.5, scenario.z + 7);
    p.camera.lookAt(scenario.x, scenario.ground + 5, scenario.z - 60);
    p.camera.updateMatrixWorld(true);
    p.applyCamera = () => {
      if (!p.lock) return;
      app.camera.position.copy(p.camera.position);
      app.camera.quaternion.copy(p.camera.quaternion);
      app.camera.fov = p.camera.fov;
      app.camera.updateProjectionMatrix();
      app.camera.updateMatrixWorld(true);
    };
    p.patch(app.renderer, 'render', original => function (scene, camera) {
      if (p.active) {
        p.active.renders++;
        if (scene === app.scene) p.active.mainSceneRenders++;
        if (this.getRenderTarget()) p.active.offscreen++;
      }
      return original.call(this, scene, camera);
    });
    p.patch(app, 'render', original => function (...args) {
      p.applyCamera();
      const frame = { renders: 0, mainSceneRenders: 0, offscreen: 0,
        label: document.getElementById('view-mode-text').textContent, at: performance.now() };
      p.active = frame;
      try { return original.apply(this, args); }
      finally {
        p.active = null;
        if (!p.manual) { p.frames.push(frame); p.total++; }
      }
    });
    p.patch(baker, 'update', original => function (camera, now) {
      p.applyCamera();
      const capture = { now, renders: 0, mainSceneRenders: 0, offscreen: 0 };
      p.active = capture;
      try { return original.call(this, camera, now); }
      finally {
        p.active = null;
        if (capture.renders) p.captures.push(capture);
      }
    });
    p.patch(baker, 'clear', original => function (...args) {
      const oldAtlas = this.atlas;
      let disposed = false;
      const onDispose = () => { disposed = true; };
      oldAtlas?.addEventListener('dispose', onDispose);
      try { return original.apply(this, args); }
      finally {
        oldAtlas?.removeEventListener('dispose', onDispose);
        p.clearEvents.push({ hadAtlas: !!oldAtlas, disposed, stats: this.stats,
          atlasCleared: this.atlas === null, mapCleared: this.material.map === null,
          drawCount: this.geometry.drawRange.count, rootCleared: this.root === null });
      }
    });
    if (resolution) tiles.setResolutionMode(resolution);
    p.applyCamera();
    return { body: body.pos.toArray(), prevPos: body.prevPos.toArray(), groundY: body.groundY,
      sampledGround: game.terrainProvider.heightfield.sample(scenario.x, scenario.z),
      camera: app.camera.position.toArray(), lookAt: [scenario.x, scenario.ground + 5, scenario.z - 60],
      origin: { lat: tiles.origin.lat, lon: tiles.origin.lon }, resolution: tiles.activeResolutionMode };
  }, { scenario, resolution: process.env.E2E_RESOLUTION ?? null });
  check('exact SF origin and body position', report.position.origin.lat === scenario.lat
    && report.position.origin.lon === scenario.lon && report.position.body[0] === scenario.x
    && report.position.body[2] === scenario.z && report.position.body.every(Number.isFinite), report.position);

  await page.evaluate(() => window.__setViewMode('photoreal'));
  await waitMode('VIEW: REAL 3D');
  await page.locator('#view-mode-btn').click();
  await waitMode('VIEW: MAP + OBJECTS');
  await page.locator('#view-mode-btn').click();
  await waitMode('VIEW: BAKED FACADES');
  check('button enters baked after Map + Objects', true);
  await page.evaluate(() => { window.__setViewMode('photoreal'); document.activeElement?.blur(); });
  await page.keyboard.press('KeyV');
  await waitMode('VIEW: MAP + OBJECTS');
  await page.keyboard.press('KeyV');
  await waitMode('VIEW: BAKED FACADES');
  check('V twice from Real 3D enters baked', true);

  console.log('[baked-facades] Polling live source/collider readiness at the exact downtown position');
  try {
    await page.waitForFunction(() => {
      const t = window.__tiles, b = window.__facadeBaker, p = window.__bakedProbe;
      const signature = t.tiles.map(tile => tile.group.uuid).join(',') + ':' + [...b.faces.keys()].join(';');
      if (p.liveSignature !== signature) { p.liveSignature = signature; p.liveChangedAt = performance.now(); }
      return b.stats.sourceMeshes > 0 && b.faces.size > 0 && !t.inFlight && !t.collidersDirty
        && performance.now() - p.liveChangedAt >= 2000;
    }, null, { polling: 250, timeout });
    report.liveReadiness = 'source/collider membership stable for 2 seconds, no tile request or dirty colliders';
  } catch {
    report.liveReadiness = 'bounded live convergence timeout; freezing scheduling and draining existing work for diagnosis';
  }
  await page.evaluate(() => {
    const p = window.__bakedProbe, tiles = window.__tiles;
    p.tiles = tiles;
    p.tilesUpdate = tiles.update;
    p.patch(tiles, 'update', () => function () {});
  });
  await page.waitForFunction(() => !window.__tiles.inFlight && !window.__tiles.collidersDirty, null, { polling: 100 });
  await page.waitForFunction(() => {
    const b = window.__facadeBaker, p = window.__bakedProbe;
    const signature = [...b.sources.values()].map(s => s.signature).sort().join(';') + [...b.faces.keys()].sort().join(';');
    if (signature !== p.frozenSignature) { p.frozenSignature = signature; p.frozenChangedAt = performance.now(); }
    const runnable = [...b.residents.values()].some(e => !e.blocked && e.sources.length && e.baked !== e.wanted);
    return !runnable && performance.now() - p.frozenChangedAt >= 1500;
  }, null, { polling: 100 });

  report.live = await page.evaluate(() => {
    const b = window.__facadeBaker, app = window.__renderer, tiles = window.__tiles;
    const camera = app.camera.position;
    const candidates = [...b.faces.values()].map(face => {
      const delta = camera.clone().sub(face.center);
      const distance = Math.hypot(Math.max(0, Math.abs(delta.dot(face.right)) - face.width / 2),
        Math.max(0, Math.abs(delta.y) - face.height / 2), delta.dot(face.normal));
      return { face, distance };
    }).filter(e => e.distance <= 220).map(({ face, distance }) => {
      const c = b.candidates(face);
      return { center: face.center.toArray(), normal: face.normal.toArray(), distance,
        sources: c.sources.length, draws: c.sources.reduce((n, s) => n + s.draws, 0),
        triangles: c.sources.reduce((n, s) => n + s.triangles, 0), blocked: c.blocked };
    }).sort((a, b) => a.distance - b.distance);
    const ground = window.__game.terrainProvider.heightfield;
    return { stats: b.stats, tiles: tiles.tileCount, colliderFaces: b.faces.size,
      settledBodyGround: ground.sample(window.__game.player.body.pos.x, window.__game.player.body.pos.z),
      settledCameraGround: ground.sample(camera.x, camera.z),
      candidates: { nearby: candidates.length, blocked: candidates.filter(e => e.blocked).length,
        withoutSources: candidates.filter(e => !e.sources).length, nearest: candidates.slice(0, 16) },
      overlay: { visible: b.group.visible, meshVisible: b.overlay.visible, vertices: b.geometry.drawRange.count,
        style: window.__buildingMeshView.getTextureStyle(), tilesVisible: tiles.group.visible,
        cameraLayers: app.camera.layers.mask, materialMap: !!b.material.map },
      gpu: { lost: app.renderer.getContext().isContextLost(), error: app.renderer.getContext().getError(),
        badPrograms: app.renderer.info.programs.filter(p => p.diagnostics?.runnable === false).length } };
  });

  const images = await page.evaluate(function captureViews() {
    const p = window.__bakedProbe, b = window.__facadeBaker, app = window.__renderer, r = app.renderer;
    p.captureViews = captureViews;
    const hash = bytes => { let h = 2166136261; for (const v of bytes) h = Math.imul(h ^ v, 16777619); return h >>> 0; };
    p.atlasSnapshot = () => {
      const bytes = b.atlas ? new Uint8Array(b.atlas.width * b.atlas.height * 4) : new Uint8Array();
      if (b.atlas) r.readRenderTargetPixels(b.atlas, 0, 0, b.atlas.width, b.atlas.height, bytes);
      const faces = [...b.residents.values()].map(entry => {
        const pixels = new Uint8Array(256 * 256 * 4);
        for (let y = 0; y < 256 && bytes.length; y++) {
          const start = ((Math.floor(entry.slot / 8) * 256 + y) * 2048 + entry.slot % 8 * 256) * 4;
          pixels.set(bytes.subarray(start, start + 1024), y * 1024);
        }
        return { key: entry.face.key, slot: entry.slot, wanted: entry.wanted, baked: entry.baked,
          pixelHash: hash(pixels), pixels };
      });
      const geo = b.geometry, n = geo.drawRange.count / 6;
      return { bytes, faces, camera: app.camera.position.toArray(), atlas: b.atlas, texture: b.material.map, captures: b.stats.captures,
        sourceSignature: [...b.sources.values()].map(s => s.signature).sort().join(';'),
        colliderSignature: [...b.faces.keys()].sort().join(';'),
        bindings: Array.from({ length: n }, (_, i) => ({
          positions: Array.from(geo.attributes.position.array.slice(i * 12, i * 12 + 12)),
          uv: Array.from(geo.attributes.uv.array.slice(i * 8, i * 8 + 8)),
        })) };
    };
    p.baseline = p.atlasSnapshot();
    const faceStats = p.baseline.faces.map(({ key, slot, baked, pixels }) => {
      let covered = 0, sum = 0, sumSq = 0, edges = 0, pairs = 0;
      const colors = new Set();
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] < 128) continue;
        covered++;
        const l = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
        sum += l; sumSq += l * l;
        colors.add((pixels[i] >> 3) * 1024 + (pixels[i + 1] >> 3) * 32 + (pixels[i + 2] >> 3));
        if ((i / 4) % 256 < 255 && pixels[i + 7] >= 128) {
          pairs++;
          if (Math.abs(l - (pixels[i + 4] + pixels[i + 5] + pixels[i + 6]) / 3) > 8) edges++;
        }
      }
      return { key, slot, completed: baked !== null, coveredPixels: covered,
        coverage: covered / 65536, quantizedColors: colors.size,
        luminanceStdDev: covered ? Math.sqrt(Math.max(0, sumSq / covered - (sum / covered) ** 2)) : 0,
        interiorEdgePixels: edges, interiorNeighborPairs: pairs };
    });
    const atlasCanvas = document.createElement('canvas');
    atlasCanvas.width = atlasCanvas.height = b.atlas?.width ?? 1;
    const ctx = atlasCanvas.getContext('2d');
    const data = ctx.createImageData(atlasCanvas.width, atlasCanvas.height);
    for (let y = 0; y < atlasCanvas.height; y++) {
      const start = y * atlasCanvas.width * 4;
      data.data.set(p.baseline.bytes.subarray(start, start + atlasCanvas.width * 4),
        (atlasCanvas.height - y - 1) * atlasCanvas.width * 4);
    }
    ctx.putImageData(data, 0, 0);
    const gl = r.getContext(), width = r.domElement.width, height = r.domElement.height;
    const read = () => {
      const bytes = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      return bytes;
    };
    const draw = () => { app.render(); return { bytes: read(), png: r.domElement.toDataURL('image/png') }; };
    const visible = b.group.visible;
    p.manual = true;
    try {
      b.group.visible = true;
      const baked = draw();
      b.group.visible = false;
      const neutral = draw(), repeat = draw();
      let changed = 0, noise = 0, absDelta = 0, sum = 0, sumSq = 0, edgePixels = 0, pairs = 0;
      const mask = new Uint8Array(width * height), colors = new Set();
      for (let i = 0; i < mask.length; i++) {
        let max = 0, control = 0;
        for (let c = 0; c < 3; c++) {
          max = Math.max(max, Math.abs(baked.bytes[i * 4 + c] - neutral.bytes[i * 4 + c]));
          control = Math.max(control, Math.abs(repeat.bytes[i * 4 + c] - neutral.bytes[i * 4 + c]));
          absDelta += Math.abs(baked.bytes[i * 4 + c] - neutral.bytes[i * 4 + c]);
        }
        if (control > 3) noise++;
        if (max <= 8) continue;
        mask[i] = 1; changed++;
        const [red, green, blue] = baked.bytes.subarray(i * 4, i * 4 + 3);
        const l = (red + green + blue) / 3;
        sum += l; sumSq += l * l;
        colors.add((red >> 3) * 1024 + (green >> 3) * 32 + (blue >> 3));
      }
      for (let i = 0; i < mask.length - 1; i++) {
        if (!mask[i] || !mask[i + 1] || i % width === width - 1) continue;
        pairs++;
        const delta = [0, 1, 2].reduce((n, c) => n + Math.abs(baked.bytes[i * 4 + c] - baked.bytes[(i + 1) * 4 + c]), 0);
        if (delta / 3 > 8) edgePixels++;
      }
      return { baked: baked.png, neutral: neutral.png, atlas: atlasCanvas.toDataURL('image/png'),
        atlasStats: { width: b.atlas?.width ?? 0, height: b.atlas?.height ?? 0,
          coveredPixels: faceStats.reduce((n, f) => n + f.coveredPixels, 0),
          sampledResidentPixels: faceStats.length * 65536, faces: faceStats },
        screen: { width, height, changedPixels: changed, changedFraction: changed / mask.length,
          fallbackRepeatNoisePixels: noise, meanAbsoluteChannelDelta: absDelta / (mask.length * 3),
          changedQuantizedColors: colors.size,
          changedLuminanceStdDev: changed ? Math.sqrt(Math.max(0, sumSq / changed - (sum / changed) ** 2)) : 0,
          changedInteriorEdgePixels: edgePixels, changedNeighborPairs: pairs,
          camera: app.camera.position.toArray(), quaternion: app.camera.quaternion.toArray() } };
    } finally { b.group.visible = visible; app.render(); p.manual = false; }
  });
  report.atlas = images.atlasStats;
  report.screen = images.screen;
  savePng('exact-height-baked.png', images.baked);
  savePng('exact-height-neutral.png', images.neutral);
  savePng('atlas.png', images.atlas);
  const hudShot = resolve(output, 'exact-height-hud.png');
  await page.screenshot({ path: hudShot, mask: [page.locator('sr-relocate #key')] });
  report.shots.push(hudShot);
  check('atlas has nonuniform photographic detail', report.atlas.faces.some(f => f.coveredPixels > 500
    && f.quantizedColors > 32 && f.luminanceStdDev > 5 && f.interiorEdgePixels > 50),
  { coveredPixels: report.atlas.coveredPixels, completedFaces: report.live.stats.bakedFaces });
  check('baked photographs visibly change the street screen, not just the atlas', report.screen.changedPixels > 1000
    && report.screen.changedFraction > 0.005 && report.screen.changedQuantizedColors > 32
    && report.screen.changedLuminanceStdDev > 5 && report.screen.changedInteriorEdgePixels > 100
    && report.screen.fallbackRepeatNoisePixels === 0, report.screen);

  await page.evaluate(() => {
    const p = window.__bakedProbe;
    p.moveStart = performance.now(); p.moveFrame = p.total;
    p.camera.position.x += 3;
    p.camera.rotation.y += 0.15;
    p.camera.fov += 5;
    p.camera.updateProjectionMatrix();
  });
  await page.waitForFunction(() => window.__facadeBaker.lastSourcesAt > window.__bakedProbe.moveStart + 1000
    && window.__bakedProbe.total > window.__bakedProbe.moveFrame + 20);
  report.movement = await page.evaluate(() => {
    const p = window.__bakedProbe, before = p.baseline, after = p.atlasSnapshot();
    const shared = after.faces.filter(f => before.faces.some(b => b.key === f.key));
    const changed = shared.filter(f => {
      const old = before.faces.find(b => b.key === f.key);
      return old.slot !== f.slot || old.pixelHash !== f.pixelHash || old.baked !== f.baked;
    });
    const bindingsChanged = before.bindings.filter(old => {
      const current = after.bindings.find(b => JSON.stringify(b.positions) === JSON.stringify(old.positions));
      return current && JSON.stringify(current.uv) !== JSON.stringify(old.uv);
    }).length;
    return { from: before.camera, to: p.camera.position.toArray(), sharedFaces: shared.length,
      addedFaces: after.faces.length - shared.length, removedFaces: before.faces.length - shared.length,
      changedSharedFaces: changed.length, bindingsChanged, sourceRefined: before.sourceSignature !== after.sourceSignature,
      collidersRefined: before.colliderSignature !== after.colliderSignature,
      sameAtlasObject: before.atlas === after.atlas, sameTextureObject: before.texture === after.texture,
      capturesBefore: before.captures, capturesAfter: after.captures };
  });
  check('camera movement preserves baked UV bindings and atlas contents', report.movement.sharedFaces > 0
    && report.movement.bindingsChanged === 0 && report.movement.changedSharedFaces === 0
    && report.movement.sameAtlasObject && report.movement.sameTextureObject
    && (report.movement.capturesBefore === report.movement.capturesAfter || report.movement.sourceRefined
      || report.movement.collidersRefined || report.movement.addedFaces > 0), report.movement);
  report.cadence = await page.evaluate(() => {
    const p = window.__bakedProbe;
    const frames = p.frames.filter(f => f.label === 'VIEW: BAKED FACADES');
    const gaps = p.captures.slice(1).map((c, i) => c.now - p.captures[i].now);
    return { frames: frames.length, mainRenderViolations: frames.filter(f => f.renders !== 1
      || f.mainSceneRenders !== 1 || f.offscreen !== 0).length, capturePasses: p.captures.length,
      capturePassViolations: p.captures.filter(c => c.renders !== 1 || c.offscreen !== 1 || c.mainSceneRenders !== 0).length,
      minCaptureIntervalMs: gaps.length ? Math.min(...gaps) : null, captureIntervals: gaps };
  });
  check('one main scene render and separate infrequent atlas captures', report.cadence.frames > 20
    && report.cadence.mainRenderViolations === 0 && report.cadence.capturePassViolations === 0
    && report.cadence.capturePasses > 1 && report.cadence.minCaptureIntervalMs >= 79, report.cadence);
  check('healthy live shaders and GPU', !report.live.gpu.lost && report.live.gpu.error === 0
    && report.live.gpu.badPrograms === 0 && report.live.stats.captureErrors === 0, report.live.gpu);
  check('baked mode displays the overlay and hides raw tile geometry', report.live.overlay.visible
    && report.live.overlay.meshVisible && report.live.overlay.style === 'baked-facades'
    && !report.live.overlay.tilesVisible && report.live.overlay.cameraLayers === 1, report.live.overlay);
  check('requested ground height matches the settled live street', Math.abs(report.live.settledBodyGround - scenario.ground) <= 5,
    { requested: scenario.ground, settled: report.live.settledBodyGround });

  report.groundAdjustedPosition = await page.evaluate(scenario => {
    const p = window.__bakedProbe, game = window.__game, body = game.player.body;
    const ground = game.terrainProvider.heightfield;
    const bodyGround = ground.sample(scenario.x, scenario.z);
    const cameraGround = ground.sample(scenario.x, scenario.z + 7);
    body.pos.set(scenario.x, bodyGround + body.cfg.groundClearance, scenario.z);
    body.groundY = bodyGround;
    body.snapPrev();
    p.camera.position.set(scenario.x, Math.max(cameraGround, bodyGround) + 3.5, scenario.z + 7);
    p.camera.fov = window.__renderer.camera.fov - 5;
    p.camera.lookAt(scenario.x, bodyGround + 5, scenario.z - 60);
    p.adjustedStart = performance.now();
    return { body: body.pos.toArray(), camera: p.camera.position.toArray(), bodyGround, cameraGround,
      explanation: 'Diagnostic only: same origin and x/z, raised to live sampled ground; does not replace exact-height verdict' };
  }, scenario);
  await page.waitForFunction(() => {
    const b = window.__facadeBaker;
    return b.lastSourcesAt > window.__bakedProbe.adjustedStart + 1000
      && ![...b.residents.values()].some(e => !e.blocked && e.sources.length && e.baked !== e.wanted);
  });
  const adjusted = await page.evaluate(() => window.__bakedProbe.captureViews());
  report.groundAdjustedScreen = adjusted.screen;
  savePng('street-baked.png', adjusted.baked);
  savePng('street-neutral.png', adjusted.neutral);
  const streetHud = resolve(output, 'street-hud.png');
  await page.screenshot({ path: streetHud, mask: [page.locator('sr-relocate #key')] });
  report.shots.push(streetHud);
  await page.evaluate(() => window.__setViewMode('photoreal'));
  await waitMode('VIEW: REAL 3D');
  savePng('street-real3d.png', await page.evaluate(() => {
    const p = window.__bakedProbe;
    p.manual = true;
    try { window.__renderer.render(); return window.__renderer.renderer.domElement.toDataURL('image/png'); }
    finally { p.manual = false; }
  }));
  await page.evaluate(() => window.__setViewMode('baked-facades'));
  await waitMode('VIEW: BAKED FACADES');

  report.occlusion = await page.evaluate(() => {
    const p = window.__bakedProbe, b = window.__facadeBaker, camera = p.camera.position;
    const enclosing = window.__game.buildingColliders.filter(box => camera.x >= box.min.x && camera.x <= box.max.x
      && camera.y >= box.min.y && camera.y <= box.max.y && camera.z >= box.min.z && camera.z <= box.max.z);
    const side = b.material.side;
    try {
      b.material.side = 2;
      b.material.needsUpdate = true;
      const doubleSided = p.captureViews().screen;
      return { enclosingColliders: enclosing.map(box => ({ min: box.min.toArray(), max: box.max.toArray() })),
        normalSide: side, doubleSidedChangedPixels: doubleSided.changedPixels,
        explanation: 'Diagnostic material overrides only; never counted as normal baked visibility' };
    } finally { b.material.side = side; b.material.needsUpdate = true; }
  });

  report.nearbyPosition = await page.evaluate(scenario => {
    const p = window.__bakedProbe, game = window.__game, ground = game.terrainProvider.heightfield;
    const boxes = game.buildingColliders;
    const free = (x, z) => {
      const y = ground.sample(x, z) + 3.5;
      return !boxes.some(b => x >= b.min.x - 3 && x <= b.max.x + 3 && z >= b.min.z - 3 && z <= b.max.z + 3
        && y >= b.min.y - 3 && y <= b.max.y + 3);
    };
    let best = null;
    for (let dx = -120; dx <= 120; dx += 4) for (let dz = -120; dz <= 120; dz += 4) {
      const distance = Math.hypot(dx, dz);
      if (distance > 120 || best && distance >= best.distance) continue;
      const x = scenario.x + dx, z = scenario.z + dz;
      if (!free(x, z)) continue;
      for (let yaw = 0; yaw < Math.PI * 2; yaw += Math.PI / 4) {
        if (![10, 20, 40, 60].every(d => free(x + Math.sin(yaw) * d, z - Math.cos(yaw) * d))) continue;
        best = { x, z, yaw, distance };
        break;
      }
    }
    if (!best) return { available: false, explanation: 'No unobstructed local street control within 120 world units' };
    const { x, z, yaw } = best, y = ground.sample(x, z);
    game.player.body.pos.set(x, y + game.player.body.cfg.groundClearance, z);
    game.player.body.groundY = y;
    game.player.body.snapPrev();
    p.camera.position.set(x, y + 3.5, z);
    p.camera.lookAt(x + Math.sin(yaw) * 60, y + 5, z - Math.cos(yaw) * 60);
    p.adjustedStart = performance.now();
    return { available: true, ...best, ground: y, camera: p.camera.position.toArray(),
      explanation: 'Nearest collision-free street corridor within 120 world units; supplemental, not the exact scenario' };
  }, scenario);
  if (report.nearbyPosition.available) {
    await page.waitForFunction(() => {
      const b = window.__facadeBaker;
      return b.lastSourcesAt > window.__bakedProbe.adjustedStart + 1000
        && ![...b.residents.values()].some(e => !e.blocked && e.sources.length && e.baked !== e.wanted);
    });
    const nearby = await page.evaluate(() => window.__bakedProbe.captureViews());
    report.nearbyScreen = nearby.screen;
    savePng('nearby-street-baked.png', nearby.baked);
    savePng('nearby-street-neutral.png', nearby.neutral);
  }
  report.diagnosis = [];
  if (Math.abs(report.live.settledBodyGround - scenario.ground) > 5) {
    report.diagnosis.push(`Requested ground differs from live sampled ground by ${report.live.settledBodyGround - scenario.ground} world units`);
  }
  if (report.occlusion.enclosingColliders.length && report.occlusion.doubleSidedChangedPixels > 1000) {
    report.diagnosis.push('The ground-adjusted camera is inside collision geometry; outward-only overlays are backface-culled there, confirmed by the temporary double-sided control');
  }
  if (!report.live.stats.budgetSkipped && report.live.candidates.nearest.every(face => !face.blocked)) {
    report.diagnosis.push('No selected-face or nearest-face source-budget starvation observed; farther over-budget candidates are reported separately');
  }
  if (report.nearbyScreen?.changedFraction > 0.005 && report.nearbyScreen.changedInteriorEdgePixels > 100) {
    report.diagnosis.push('Normal baked materials visibly render real texture detail at the nearby collision-free control; this does not pass the exact-position test');
  }

  if (process.env.E2E_RELOCATE === '1') {
    await page.evaluate(() => {
      const p = window.__bakedProbe;
      window.__game.update = p.gameUpdate;
      p.tiles.update = p.tilesUpdate;
      p.lock = false;
      p.oldTiles = window.__tiles;
      p.oldTerrain = window.__game.terrainProvider;
    });
    const query = page.locator('sr-relocate #q');
    if (!await query.isVisible()) await page.locator('sr-relocate .toggle').click();
    await query.fill('37.79344, -122.42127');
    await query.press('Enter');
    await page.waitForFunction(() => !document.querySelector('sr-relocate').busy
      && window.__game.terrainProvider !== window.__bakedProbe.oldTerrain && window.__tiles !== window.__bakedProbe.oldTiles);
    await waitMode('VIEW: BAKED FACADES');
    report.relocation = await page.evaluate(() => ({ events: window.__bakedProbe.clearEvents,
      rootReplaced: window.__facadeBaker.root === window.__tiles.group,
      oldRootDetached: window.__bakedProbe.oldTiles.group.parent === null,
      isReal: window.__game.terrainProvider.isReal }));
    check('live relocation retains mode and clears old baked assets', report.relocation.rootReplaced
      && report.relocation.oldRootDetached && report.relocation.isReal && report.relocation.events.some(e => e.hadAtlas
        && e.disposed && e.atlasCleared && e.mapCleared && e.rootCleared && e.drawCount === 0
        && e.stats.faces === 0 && e.stats.sourceMeshes === 0), report.relocation);
  } else report.relocation = 'not requested; enable E2E_RELOCATE=1';
  check('no browser console or JavaScript errors', report.errors.length === 0, report.errors);
} catch (error) {
  report.blockers.push(redact(error.stack ?? error));
} finally {
  try {
    if (page && !page.isClosed()) {
      report.restored = await page.evaluate(() => {
        const p = window.__bakedProbe;
        if (!p) return { probeInstalled: false };
        for (const restore of p.restore.reverse()) restore();
        return { probeInstalled: true, gameUpdate: window.__game.update === p.gameUpdate,
          tilesUpdate: !p.tiles || p.tiles.update === p.tilesUpdate };
      });
    }
  } catch (error) { report.blockers.push(`Restore failed: ${redact(error.message)}`); }
  finally {
    try { await browser?.close(); }
    finally {
      if (server && server.exitCode === null) {
        const exited = new Promise(resolve => server.once('exit', resolve));
        server.kill('SIGTERM');
        await exited;
      }
    }
  }
  if (report.restored?.gameUpdate === false || report.restored?.tilesUpdate === false) report.blockers.push('Update hooks were not restored');
  report.verdict = report.blockers.length ? 'BLOCKED' : 'PASS';
  const text = redact(JSON.stringify(report, null, 2));
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, 'report.json'), text + '\n');
  console.log(redact(JSON.stringify({ verdict: report.verdict, blockers: report.blockers,
    diagnosis: report.diagnosis, position: report.position,
    live: report.live && { ...report.live, candidates: { ...report.live.candidates, nearest: undefined } }, screen: report.screen,
    atlas: report.atlas && { coveredPixels: report.atlas.coveredPixels, sampledResidentPixels: report.atlas.sampledResidentPixels,
      nonemptyFaces: report.atlas.faces.filter(f => f.coveredPixels > 0).length,
      maxQuantizedColors: Math.max(...report.atlas.faces.map(f => f.quantizedColors)),
      interiorEdgePixels: report.atlas.faces.reduce((n, f) => n + f.interiorEdgePixels, 0) },
    movement: report.movement, cadence: report.cadence && { ...report.cadence, captureIntervals: undefined },
    groundAdjustedPosition: report.groundAdjustedPosition, groundAdjustedScreen: report.groundAdjustedScreen,
    occlusion: report.occlusion, nearbyPosition: report.nearbyPosition, nearbyScreen: report.nearbyScreen,
    relocation: report.relocation, restored: report.restored, shots: report.shots,
    report: resolve(output, 'report.json') }, null, 2)));
  if (report.blockers.length) process.exitCode = 1;
}
