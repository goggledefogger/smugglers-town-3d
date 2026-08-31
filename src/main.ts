/**
 * Composition root: builds the renderer, game, UI, and services; runs the
 * frame loop; wires events between layers.
 *
 * Frame data flow:
 *   input → Game.update (fixed-step sim) → views sync → renderer.render
 *         → store snapshot → Lit HUD re-render
 */
import { Group } from 'three';
import { config } from './app/config.ts';
import { Game } from './app/Game.ts';
import { type GameEventMap, EventBus } from './app/events.ts';
import { createStore, type HudSnapshot } from './app/store.ts';
import { GameRenderer } from './render/Renderer.ts';
import { TerrainMesh } from './render/TerrainMesh.ts';
import { VehicleView } from './render/VehicleView.ts';
import { PropScatter } from './render/PropScatter.ts';
import { Pickups } from './render/Pickups.ts';
import { CameraRig } from './render/CameraRig.ts';
import { Minimap } from './render/Minimap.ts';
import { Heightfield } from './core/heightfield.ts';
import { generateDesertHeightfieldData, createDesertTerrain } from './core/terrain/ProceduralTerrain.ts';
import { KeyboardState } from './ui/controls.ts';
import { relocate } from './services/relocate.ts';
import { SpeedGauge } from './ui/hud/SpeedGauge.ts';
import { ScorePanel } from './ui/hud/ScorePanel.ts';
import { ObjectiveBar } from './ui/hud/ObjectiveBar.ts';
import { HealthBar } from './ui/hud/HealthBar.ts';
import { DirArrow } from './ui/hud/DirArrow.ts';
import { Banner } from './ui/hud/Banner.ts';
import { IntroScreen } from './ui/screens/IntroScreen.ts';
import { EndScreen } from './ui/screens/EndScreen.ts';
import { LoaderOverlay } from './ui/screens/LoaderOverlay.ts';
import { RelocateBar } from './ui/screens/RelocateBar.ts';

const app = document.getElementById('app')!;

// ---- DOM shell ----
app.innerHTML = `
  <canvas id="c"></canvas>
  <div id="hud">
    <div class="hud-corner hud-tl"><sr-health></sr-health></div>
    <div class="hud-corner hud-tr"><sr-score></sr-score></div>
    <div class="hud-corner hud-bl"><sr-objective></sr-objective></div>
    <div class="hud-corner hud-br"><sr-speed></sr-speed><canvas id="minimap" width="170" height="170"></canvas></div>
    <sr-dirarrow id="dirarrow"></sr-dirarrow>
    <sr-banner id="banner"></sr-banner>
  </div>
  <sr-relocate id="relocate"></sr-relocate>
  <sr-loader id="loader" hidden></sr-loader>
  <sr-end id="end" hidden></sr-end>
  <sr-intro id="intro"></sr-intro>
`;

const canvas = document.getElementById('c') as HTMLCanvasElement;
const minimapCanvas = document.getElementById('minimap') as HTMLCanvasElement;
const loaderEl = document.querySelector('sr-loader') as LoaderOverlay;
const introEl = document.querySelector('sr-intro') as IntroScreen;
const endEl = document.querySelector('sr-end') as EndScreen;
const bannerEl = document.querySelector('sr-banner') as Banner;
const relocateBarEl = document.querySelector('sr-relocate') as RelocateBar;

// ---- stores, events, game ----
const events = new EventBus<GameEventMap>();
const initialHud: HudSnapshot = {
  phase: 'intro', speed: 0, damage: 0, vehicleName: '', scores: { 0: 0, 1: 0 },
  carrierName: null, carrierIsPlayer: false, carrierIsAlly: false,
  objective: 'FIND CONTRABAND', distanceToTarget: 0, targetIsDelivery: false,
  targetBearingRad: 0, locationLabel: 'Procedural Desert', winner: null, teamPips: []
};
const store = createStore<HudSnapshot>(initialHud);

// procedural desert: instant, no network
const desertData = generateDesertHeightfieldData(Math.floor(Math.random() * 1000));
const desertHf = new Heightfield(config.world.mapHalf * 2, 256, desertData);
const desertTerrain = createDesertTerrain(desertHf);

const game = new Game(desertTerrain, { events, store });
game.reset(desertTerrain);

// ---- renderer + views ----
const renderer = new GameRenderer({ canvas });
const terrainMesh = new TerrainMesh();
renderer.scene.add(terrainMesh.build(desertTerrain, renderer.maxAnisotropy));
const propScatter = new PropScatter(renderer.scene);
propScatter.scatter(desertHf, config.world.mapHalf, false);
const pickups = new Pickups(renderer.scene);
const cameraRig = new CameraRig(renderer.camera, () => game.terrainProvider.heightfield);
const minimap = new Minimap(minimapCanvas, config.world.mapHalf);
const vehicleViews: VehicleView[] = [];
let tilesGroup: Group | null = null;

function rebuildViews(): void {
  for (const v of vehicleViews) {
    renderer.scene.remove(v.group);
    v.dispose();
  }
  vehicleViews.length = 0;
  for (const actor of game.vehicles) {
    const view = new VehicleView(actor);
    vehicleViews.push(view);
    renderer.scene.add(view.group);
  }
}
rebuildViews();

// ---- keyboard + hotkeys ----
const keyboard = new KeyboardState();

window.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName ?? '')) return;
  if (e.code === 'KeyR') resetPlayer();
  if (e.code === 'KeyC') cameraRig.cycleMode();
  if (e.code.startsWith('Digit')) {
    const n = Number(e.code.slice(5));
    if (n >= 1 && n <= 5) switchVehicle(n - 1);
  }
});

function resetPlayer(): void {
  const p = game.player?.body;
  if (!p) return;
  const x = (Math.random() - 0.5) * 60;
  const z = (Math.random() - 0.5) * 60;
  p.pos.set(x, game.terrainProvider.heightfield.sample(x, z) + 3, z);
  p.vel.set(0, 0, 0);
  p.angVel.set(0, 0, 0);
  p.quat.identity();
}

function switchVehicle(n: number): void {
  game.switchPlayerVehicle(n);
  rebuildViews();
}

// ---- events → UI ----
events.on('contraband:pickup', () => bannerEl.show('CONTRABAND ACQUIRED', 1200));
events.on('contraband:stolen', ({ attackerId, victimId }) => {
  const isPlayerVictim = game.player && victimId === game.player.body.id;
  const isPlayerAttacker = game.player && attackerId === game.player.body.id;
  if (isPlayerVictim || isPlayerAttacker) bannerEl.show('CONTRABAND STOLEN!', 800);
});
events.on('contraband:delivered', ({ team }) => {
  bannerEl.show(`DELIVERED! ${team === 0 ? 'YOUR CREW' : 'RIVALS'}`, 1500);
});
events.on('match:win', ({ team }) => {
  bannerEl.show(team === 0 ? 'YOUR CREW WINS!' : 'RIVALS WIN!', 4000);
  setTimeout(() => {
    endEl.hidden = false;
    endEl.winner = team;
    endEl.scores = { ...game.state.scores };
  }, 1500);
});
events.on('relocate:status', ({ message }) => {
  loaderEl.message = message;
});
events.on('location:changed', ({ label }) => {
  bannerEl.show(`RELOCATED: ${label}`, 2500);
});

// ---- screens wiring ----
introEl.onStart = () => {
  introEl.remove();
};

endEl.onRematch = () => {
  endEl.hidden = true;
  endEl.winner = null;
  game.reset(desertTerrain);
  rebuildViews();
  propScatter.scatter(game.terrainProvider.heightfield, config.world.mapHalf, game.terrainProvider.isReal);
};

// ---- relocate flow ----
relocateBarEl.onSearch = async (q, key) => {
  if (!key) {
    relocateBarEl.status = 'Paste a Google Maps API key first (Maps JavaScript + Elevation).';
    return;
  }
  relocateBarEl.busy = true;
  relocateBarEl.status = '';
  loaderEl.hidden = false;
  try {
    const { terrain, colliders, tilesGroup: newTiles } = await relocate(q, key, (msg) => {
      loaderEl.message = msg;
    });
    if (tilesGroup) renderer.scene.remove(tilesGroup);
    tilesGroup = newTiles;
    if (tilesGroup) renderer.scene.add(tilesGroup);
    const oldMesh = terrainMesh.mesh;
    if (oldMesh) renderer.scene.remove(oldMesh);
    renderer.scene.add(terrainMesh.build(terrain, renderer.maxAnisotropy));
    propScatter.scatter(terrain.heightfield, config.world.mapHalf, terrain.isReal);
    game.reset(terrain);
    game.setBuildingColliders(colliders);
    rebuildViews();
    events.emit('location:changed', { label: terrain.label, isReal: terrain.isReal });
  } catch (err) {
    relocateBarEl.status = err instanceof Error ? err.message : String(err);
  } finally {
    loaderEl.hidden = true;
    relocateBarEl.busy = false;
  }
};

// ---- HUD binding ----
(document.querySelector('sr-health') as HealthBar).bind(store);
(document.querySelector('sr-score') as ScorePanel).bind(store);
(document.querySelector('sr-objective') as ObjectiveBar).bind(store);
(document.querySelector('sr-speed') as SpeedGauge).bind(store);
(document.querySelector('sr-dirarrow') as DirArrow).bind(store);

// ---- frame loop ----
let last = performance.now();
let simTime = 0;

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, config.loop.maxFrameDt);
  last = now;
  const playing = !introEl.isConnected && endEl.hidden;
  if (playing) {
    game.update(dt, keyboard.toVehicleInput());
    simTime += dt;
    for (const v of vehicleViews) v.sync();
    pickups.sync(game.state, simTime, dt);
    cameraRig.update(dt, game.player?.body ?? null);
    minimap.draw(game.state, game.vehicles, game.state.carrier);
  }
  renderer.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
