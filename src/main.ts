/**
 * Composition root: builds the renderer, game, UI, and services; runs the
 * frame loop; wires events between layers.
 *
 * Frame data flow:
 *   input → Game.update (fixed-step sim) → views sync → renderer.render
 *         → store snapshot → Lit HUD re-render
 */
import { config } from './app/config.ts';
import { Game } from './app/Game.ts';
import type { WorldView } from './app/WorldView.ts';
import type { OnlineFlow, RunningMatch } from './net/OnlineFlow.ts';
import { mulberry32 } from './core/rng.ts';
import { type GameEventMap, EventBus } from './app/events.ts';
import { createStore, type HudSnapshot } from './app/store.ts';
import { GameRenderer } from './render/Renderer.ts';
import { TerrainMesh } from './render/TerrainMesh.ts';
import { BuildingMeshView } from './render/BuildingMeshView.ts';
import { TileClutterFilter, type ClutterMode } from './render/TileClutterFilter.ts';
import { VehicleView } from './render/VehicleView.ts';
import { PropScatter } from './render/PropScatter.ts';
import { Pickups } from './render/Pickups.ts';
import { CameraRig } from './render/CameraRig.ts';
import { AudioManager } from './audio/AudioManager.ts';
import { Vector3 } from 'three';

import { Showroom } from './render/Showroom.ts';
import { setVehicleEnvMap } from './render/vehicleMeshes.ts';
import { PMREMGenerator, type Texture, type Material, type Mesh, type PlaneGeometry } from 'three';
import { patchDetailGrain } from './render/DetailGrain.ts';
import { GroundShade } from './render/GroundShade.ts';
import { Heightfield } from './core/heightfield.ts';
import { generateDesertHeightfieldData, createDesertTerrain } from './core/terrain/ProceduralTerrain.ts';
import type { TerrainProvider } from './core/terrain/TerrainProvider.ts';
import type { BuildingCollider } from './core/physics/VehicleBody.ts';
import { InputManager } from './input/InputManager.ts';
import type { UiAction } from './input/types.ts';
import { logger } from './app/log.ts';
import { PROTOCOL_VERSION } from './net/protocol.ts';
import { relocate, relocateTo } from './services/relocate.ts';
import type { TileStreamer } from './services/tiles/Tileset.ts';
import { AmortizedGroundBuilder, type ColliderExperimentMode } from './services/tiles/tileColliders.ts';
import {
  type Resolution3DMode, RESOLUTION_3D_MODES, getResolutionProfile
} from './services/tiles/resolutionProfiles.ts';
import { GroundStreamer } from './services/maps/GroundStreamer.ts';
import { getScenario, findScenarioByCoords, type TestScenario } from './core/geo/testScenarios.ts';
import { worldToLl } from './core/geo/projection.ts';
import { SpeedGauge } from './ui/hud/SpeedGauge.ts';
import { ScorePanel } from './ui/hud/ScorePanel.ts';
import { ObjectiveBar } from './ui/hud/ObjectiveBar.ts';
import { HealthBar } from './ui/hud/HealthBar.ts';
import { DirArrow } from './ui/hud/DirArrow.ts';
import { Minimap } from './ui/hud/Minimap.ts';
import { Banner } from './ui/hud/Banner.ts';
import { IntroScreen } from './ui/screens/IntroScreen.ts';
import { EndScreen } from './ui/screens/EndScreen.ts';
import { LoaderOverlay } from './ui/screens/LoaderOverlay.ts';
import { RelocateBar } from './ui/screens/RelocateBar.ts';
import { SettingsScreen } from './ui/screens/SettingsScreen.ts';
import type { LobbyScreen } from './ui/screens/LobbyScreen.ts';
import { isTypingInField } from './ui/controls.ts';
import { applyThemeToDocument } from './core/theme.ts';

const log = logger('app');
applyThemeToDocument();
const app = document.getElementById('app')!;

// ---- DOM shell ----
app.innerHTML = `
  <canvas id="c"></canvas>
  <div id="hud">
    <div class="hud-corner hud-tl">
      <sr-health></sr-health>
      <button id="view-mode-btn" class="hud-btn" type="button" title="Toggle 3D Visual Mode (Hotkey: V or G)">
        <span>🎮</span> <span id="view-mode-text">VIEW: REAL 3D</span> <span class="mono" style="opacity:0.6;font-size:9px;">[V]</span>
      </button>
      <button id="clutter-btn" class="hud-btn" type="button" hidden title="Street clutter filter: flatten parked cars, kerbs and street furniture into the road, hide everything but buildings, or sweep the street clean while keeping walls and trees (Hotkey: F)">
        <span>🚗</span> <span id="clutter-text">CLUTTER: OFF</span> <span class="mono" style="opacity:0.6;font-size:9px;">[F]</span>
      </button>
      <button id="audio-btn" class="hud-btn active" type="button" title="Toggle audio mute (Hotkey: M)">
        <span id="audio-icon">🔊</span> <span id="audio-text">AUDIO: ON</span> <span class="mono" style="opacity:0.6;font-size:9px;">[M]</span>
      </button>
    </div>
    <div class="hud-corner hud-tr"><sr-score></sr-score></div>
    <div class="hud-corner hud-bl"><sr-objective></sr-objective></div>
    <div class="hud-corner hud-br"><sr-speed></sr-speed><sr-minimap></sr-minimap></div>
    <sr-dirarrow id="dirarrow"></sr-dirarrow>
    <sr-banner id="banner"></sr-banner>
    <button id="skip-btn" type="button">SKIP <kbd>Space</kbd></button>
  </div>
  <sr-relocate id="relocate"></sr-relocate>
  <sr-lobby id="lobby" hidden></sr-lobby>
  <sr-loader id="loader" hidden></sr-loader>
  <sr-end id="end" hidden></sr-end>
  <sr-settings id="settings" hidden></sr-settings>
  <sr-intro id="intro"></sr-intro>
`;

const canvas = document.getElementById('c') as HTMLCanvasElement;
const hudEl = document.getElementById('hud')!;
const loaderEl = document.querySelector('sr-loader') as LoaderOverlay;
const introEl = document.querySelector('sr-intro') as IntroScreen;
const endEl = document.querySelector('sr-end') as EndScreen;
const settingsEl = document.querySelector('sr-settings') as SettingsScreen;
const bannerEl = document.querySelector('sr-banner') as Banner;
const relocateBarEl = document.querySelector('sr-relocate') as RelocateBar;
const dirArrowEl = document.querySelector('sr-dirarrow') as DirArrow;
const viewModeBtn = document.getElementById('view-mode-btn') as HTMLButtonElement | null;
const viewModeText = document.getElementById('view-mode-text') as HTMLSpanElement | null;
const skipBtn = document.getElementById('skip-btn') as HTMLButtonElement | null;

// ---- stores, events, game ----
const events = new EventBus<GameEventMap>();
const audio = new AudioManager(events);
if (typeof window !== 'undefined') (window as any).__audio = audio;
const initialHud: HudSnapshot = {
  phase: 'intro', timeLeftS: config.match.roundS, speed: 0, damage: 0, vehicleName: '', scores: { 0: 0, 1: 0 },
  carrierName: null, carrierIsPlayer: false, carrierIsAlly: false,
  objective: 'FIND CONTRABAND', distanceToTargetM: 0, navGoal: 'collect',
  locationLabel: 'Procedural Desert', winner: null, teamPips: []
};
const store = createStore<HudSnapshot>(initialHud);

// procedural desert: instant, no network
const desertData = generateDesertHeightfieldData(Math.floor(Math.random() * 1000));
const desertHf = new Heightfield(config.world.mapHalf * 2, 256, desertData);
const desertTerrain = createDesertTerrain(desertHf);

let game = new Game(desertTerrain, { events, store });
if (typeof window !== 'undefined') (window as any).__game = game;
/** What the renderer draws: the local game, or a mirrored world while online. */
let world: WorldView = game;
let online: RunningMatch | null = null;
let onlineFlow: OnlineFlow | null = null;

// ---- renderer + views ----
const renderer = new GameRenderer({ canvas });
// the painted sky as reflections for car paint, glass and chrome only (scene
// lighting is untouched): the car mirrors the same sky the scene shows, so it
// reads as parked under it rather than lit in a studio
{
  const pmrem = new PMREMGenerator(renderer.renderer);
  setVehicleEnvMap(pmrem.fromEquirectangular(renderer.scene.background as Texture).texture);
  pmrem.dispose();
}
const terrainMesh = new TerrainMesh();
const groundShade = new GroundShade();
renderer.scene.add(terrainMesh.build(desertTerrain, renderer.maxAnisotropy));
const propScatter = new PropScatter(renderer.scene);
const pickups = new Pickups(renderer.scene, () => renderer.camera, () => world.terrainProvider.heightfield);
const cameraRig = new CameraRig(
  renderer.camera, () => world.terrainProvider.heightfield, (a, b) => world.lineOfSight(a, b)
);
const minimapEl = document.querySelector('sr-minimap') as Minimap;
const showroom = new Showroom(renderer.scene, renderer.camera, () => world.terrainProvider.heightfield);
const vehicleViews: VehicleView[] = [];
let tiles: TileStreamer | null = null;
let groundStreamer: GroundStreamer | null = null;
let colliderRefreshAt = 0;
let colliderGeneration = 0;
let footprintPaintAt = -Infinity;
let groundBuilder: AmortizedGroundBuilder | null = null;
const buildingMeshView = new BuildingMeshView();
renderer.scene.add(buildingMeshView.group);
if (typeof window !== 'undefined') {
  (window as any).__buildingMeshView = buildingMeshView;
  (window as any).__terrainMesh = terrainMesh;
}
export type ViewMode = 'photoreal' | 'masked-tiles' | 'game3d-textured' | 'game3d' | 'game3d-planar' | 'game3d-hybrid';
let viewMode: ViewMode = 'photoreal';
let clutterFilter: TileClutterFilter | null = null;
// the mode survives a relocate: a new filter starts in it
// swept by default: flattens road clutter while keeping kerbside building facades
// and trees over the sharper streamed satellite ground
let clutterMode: ClutterMode = 'off';
/** Modes that discard the tile's own road surface, so satellite ground must stream beneath tiles. */
const REVEALS_GROUND: ReadonlySet<ClutterMode> = new Set(['hidden', 'swept']);
const clutterBtn = document.getElementById('clutter-btn') as HTMLButtonElement | null;
const clutterText = document.getElementById('clutter-text') as HTMLSpanElement | null;
const CLUTTER_LABEL: Record<ClutterMode, string> = { off: 'CLUTTER: OFF', flatten: 'CLUTTER: FLAT', hidden: 'CLUTTER: HIDDEN', swept: 'CLUTTER: SWEPT' };

function updateClutterUi(): void {
  if (!clutterBtn || !clutterText) return;
  clutterBtn.hidden = !clutterFilter;
  clutterBtn.classList.toggle('active', clutterMode !== 'off');
  clutterText.textContent = CLUTTER_LABEL[clutterMode];
}

function cycleClutterMode(): void {
  if (!clutterFilter) return;
  clutterMode = clutterFilter.cycleMode();
  if (groundStreamer) groundStreamer.underTiles = REVEALS_GROUND.has(clutterMode);
  updateClutterUi();
}

clutterBtn?.addEventListener('click', cycleClutterMode);

/** Every tile, now and as they refine: clutter filter patched in, programs and textures warmed. */
function attachTiles(streamer: TileStreamer, terrain: TerrainProvider): void {
  (window as any).__tiles = streamer; // scripts/clutter-shots.mjs teleports onto a road cell through this
  clutterFilter = new TileClutterFilter(
    terrain.heightfield, streamer.structureGrid, streamer.grid.n, terrain.reliefBoost
  );
  if (viewMode === 'masked-tiles') {
    clutterFilter.mode = 'hidden';
    clutterMode = 'hidden';
  } else if (viewMode === 'photoreal') {
    clutterFilter.mode = 'off';
    clutterMode = 'off';
  } else {
    clutterFilter.mode = clutterMode;
  }
  if (groundStreamer) {
    // the tiles shifted the ground datum; patches under them must sit on the same field the car drives on
    groundStreamer.useHeightfield(terrain.heightfield);
    groundStreamer.underTiles = REVEALS_GROUND.has(clutterMode);
  }
  if (currentExperiment !== 'baseline') {
    streamer.setExperimentMode(currentExperiment);
  }
  streamer.setResolutionMode(currentResolution3D);
  streamer.onRoadsLoaded = () => {
    log.info('OSM roads arrived in background, refreshing colliders');
    refreshColliders();
    showToast('OSM Road Mask Loaded: Road Corridors Carved');
  };
  clutterFilter.patch(streamer.group);
  renderer.warm(streamer.group);
  streamer.onTileLoaded = g => {
    clutterFilter?.patch(g);
    renderer.warm(g);
  };
  updateClutterUi();
}

function updateViewModeUi(): void {
  if (!viewModeBtn || !viewModeText) return;
  viewModeBtn.classList.toggle('active', viewMode !== 'photoreal');
  if (viewMode === 'game3d') {
    viewModeText.textContent = 'VIEW: ARCADE 3D';
  } else if (viewMode === 'game3d-textured' || viewMode === 'game3d-hybrid') {
    viewModeText.textContent = 'VIEW: TEXTURED 3D';
  } else if (viewMode === 'game3d-planar') {
    viewModeText.textContent = 'VIEW: TEXTURED (PLANAR)';
  } else if (viewMode === 'masked-tiles') {
    viewModeText.textContent = 'VIEW: MASKED 3D TILES';
  } else {
    viewModeText.textContent = 'VIEW: REAL 3D';
  }
}

function setViewMode(mode: ViewMode): void {
  viewMode = mode;
  const isRawPhotoreal = mode === 'photoreal';
  const isMaskedTiles = mode === 'masked-tiles';
  const hasTiles = isRawPhotoreal || isMaskedTiles;

  if (tiles) tiles.group.visible = hasTiles;
  if (clutterFilter) {
    if (isMaskedTiles) {
      clutterFilter.mode = 'hidden';
      clutterMode = 'hidden';
    } else if (isRawPhotoreal) {
      clutterFilter.mode = 'off';
      clutterMode = 'off';
    }
    updateClutterUi();
  }

  const showGround = hasTiles || mode === 'game3d-textured' || mode === 'game3d-planar' || mode === 'game3d-hybrid';
  if (groundStreamer) {
    groundStreamer.group.visible = showGround;
    if (hasTiles) {
      groundStreamer.underTiles = REVEALS_GROUND.has(clutterMode);
    }
  }

  terrainMesh.setMode(mode === 'game3d' ? 'game3d' : 'photoreal');

  // In arcade and textured modes, buildingMeshView is the primary visible structure geometry.
  // In masked-tiles mode, buildingMeshView provides the solid color-mapped substrate
  // so building walls are never see-through or hollow ("at worst a color-mapped object, not see through").
  // In photoreal (Real 3D) mode, raw 3D tiles are shown alone.
  buildingMeshView.visible = mode !== 'photoreal';

  const satTex = terrainMesh.sourceTexture ?? terrainMesh.texture;
  if (mode === 'game3d') {
    buildingMeshView.setMode('arcade');
  } else if (mode === 'game3d-planar') {
    buildingMeshView.setMode('textured');
    buildingMeshView.setTextureStyle('planar');
    if (satTex) {
      buildingMeshView.setTexture(satTex, config.world.mapHalf * 2);
    }
  } else {
    // Both 'game3d-textured' and 'masked-tiles' use hybrid textured buildings
    buildingMeshView.setMode('textured');
    buildingMeshView.setTextureStyle('hybrid');
    if (satTex) {
      buildingMeshView.setTexture(satTex, config.world.mapHalf * 2);
    }
  }

  renderer.setLightRig(hasTiles && world.terrainProvider.isReal ? 'photo' : 'arcade');
  updateViewModeUi();
}

function toggleViewMode(): void {
  if (viewMode === 'game3d') {
    setViewMode('game3d-textured');
  } else if (viewMode === 'game3d-textured' || viewMode === 'game3d-hybrid' || viewMode === 'game3d-planar') {
    setViewMode('masked-tiles');
  } else if (viewMode === 'masked-tiles') {
    setViewMode('photoreal');
  } else {
    setViewMode('game3d');
  }
}

viewModeBtn?.addEventListener('click', () => {
  toggleViewMode();
});

const audioBtn = document.getElementById('audio-btn') as HTMLButtonElement | null;
const audioIcon = document.getElementById('audio-icon') as HTMLSpanElement | null;
const audioText = document.getElementById('audio-text') as HTMLSpanElement | null;

function updateAudioUi(): void {
  if (!audioBtn || !audioIcon || !audioText) return;
  if (audio.muted) {
    audioIcon.textContent = '🔇';
    audioText.textContent = 'AUDIO: MUTED';
    audioBtn.classList.remove('active');
  } else {
    audioIcon.textContent = '🔊';
    audioText.textContent = 'AUDIO: ON';
    audioBtn.classList.add('active');
  }
}
updateAudioUi();
events.on('audio:change', () => updateAudioUi());

audioBtn?.addEventListener('click', () => {
  audio.toggleMute();
});

window.addEventListener('keydown', (e) => {
  // bare keys only: Cmd/Ctrl/Alt chords are the browser's (Cmd+M minimize,
  // Cmd+H hide), so don't fire game hotkeys on them
  const bareKey = !e.metaKey && !e.ctrlKey && !e.altKey;
  if (e.code === 'KeyM' && bareKey && !e.repeat && !isTypingInField()) {
    audio.toggleMute();
    updateAudioUi();
  }
  if (e.code === 'KeyH' && bareKey && !e.repeat && !isTypingInField()) {
    audio.horn?.start();
  }
  if (game.matchPhase === 'countdown' && bareKey && !isTypingInField() && (e.code === 'Space' || e.code === 'Enter' || e.code === 'Escape')) {
    skipCinematic();
    e.preventDefault();
  }
});

window.addEventListener('keyup', (e) => {
  // unguarded on purpose: a horn started outside a field must stop even when
  // its keyup lands inside one (guarding can strand a blaring horn)
  if (e.code === 'KeyH') {
    audio.horn?.stop();
  }
});

/** Buildings from the streamed tiles plus the scattered props; sync, so a match can spawn clear of them. */
function applyColliders(): void {
  applyTileColliders(tiles?.colliders() ?? []);
}

let colliderJob: Promise<void> | null = null;

/** The streaming loop's rebuild, in the tile worker; tiles that change meanwhile re-dirty for the next one. */
function refreshColliders(): void {
  if (!tiles || colliderJob) return;
  colliderJob = tiles.collidersAsync()
    .then(applyTileColliders)
    .catch(e => log.warn('collider rebuild failed', e))
    .finally(() => { colliderJob = null; });
}

function applyTileColliders(tileBoxes: readonly BuildingCollider[]): void {
  colliderGeneration++;
  const colliders = [...tileBoxes, ...propScatter.colliders];
  clutterFilter?.maskChanged();
  game.setBuildingColliders(colliders);
  buildingMeshView.update(
    colliders,
    tiles?.activeDeckGrid,
    tiles?.activeGrid,
    (x, z) => world.terrainProvider.heightfield.sample(x, z)
  );
  const satTex = terrainMesh.sourceTexture ?? terrainMesh.texture;
  if (satTex) {
    buildingMeshView.setTexture(satTex, config.world.mapHalf * 2);
  }
  // the repaint re-uploads a 3840² satellite texture with mipmaps, a 50-150 ms
  // stall, for ground the tiles mostly cover: once at match start, then rarely
  const now = performance.now();
  if (now - footprintPaintAt > 20000) {
    footprintPaintAt = now;
    terrainMesh.neutralizeBuildingFootprints(colliders, config.world.mapHalf * 2, colliderGeneration);
  }
}

function rebuildViews(): void {
  for (const v of vehicleViews) {
    renderer.scene.remove(v.group);
    v.dispose();
  }
  vehicleViews.length = 0;
  for (const actor of world.vehicles) {
    const view = new VehicleView(
      actor, () => world.terrainProvider.heightfield,
      (x, z) => viewMode === 'photoreal' ? groundShade.shadeAt(x, z) : 1
    );
    vehicleViews.push(view);
    renderer.scene.add(view.group);
  }
}

/** Re-seat props on a terrain and refresh colliders (buildings + props). */
function prepareTerrain(terrain: TerrainProvider, rng: () => number = Math.random): void {
  propScatter.scatter(terrain.heightfield, config.world.mapHalf, terrain.isReal, rng);
  applyColliders();
}

function clearTiles(): void {
  footprintPaintAt = -Infinity;
  game.setSurfaceProvider(undefined);
  groundBuilder = null;
  if (groundStreamer) {
    renderer.scene.remove(groundStreamer.group);
    groundStreamer.dispose();
    groundStreamer = null;
  }
  if (tiles) {
    renderer.scene.remove(tiles.group);
    tiles.dispose();
    tiles = null;
  }
  if (clutterFilter) {
    clutterFilter.dispose();
    clutterFilter = null;
    updateClutterUi();
  }
  buildingMeshView.clear();
}

/** A streamed satellite patch landed: let the cars read its shadows. */
function onGroundPatch(m: Mesh): void {
  const img = (m.material as Material & { map?: { image?: CanvasImageSource } }).map?.image;
  const size = (m.geometry as PlaneGeometry).parameters.width;
  if (img && size) groundShade.setPatch(img, m.position.x, m.position.z, size);
}

function swapTerrainMesh(terrain: TerrainProvider): void {
  const old = terrainMesh.mesh;
  if (old) renderer.scene.remove(old);
  const mesh = terrainMesh.build(terrain, renderer.maxAnisotropy);
  groundShade.setBase(terrain.satelliteCanvas, config.world.mapHalf * 2);
  terrainMesh.setMode(viewMode);
  const satTex = terrainMesh.sourceTexture ?? terrainMesh.texture;
  if (satTex) {
    buildingMeshView.setTexture(satTex, config.world.mapHalf * 2);
  }
  renderer.setLightRig(viewMode === 'photoreal' && terrain.isReal ? 'photo' : 'arcade');
  renderer.scene.add(mesh);
  minimapEl.setTerrain(terrain.heightfield, config.world.mapHalf);
}

/** New terrain or rematch: props, colliders, then spawn everything clear of them. */
function startMatch(terrain: TerrainProvider): void {
  prepareTerrain(terrain);
  game.setSurfaceProvider(tiles ? (x, z, cy, gy) => tiles!.surfaceElevation(x, z, cy, gy) : undefined);
  game.reset(terrain);
  rebuildViews();
  hudEl.classList.add('cinematic');
  cameraRig.intro(config.match.countdownS, vehicleViews.find(v => v.actor.isPlayer)?.pose ?? null);
}

// one boot line per session: a bug report with no breadcrumbs is a guess, and
// the protocol version is what tells two mismatched builds apart
log.info('boot', {
  protocol: PROTOCOL_VERSION,
  ua: navigator.userAgent.slice(0, 90),
  view: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`,
  gpu: renderer.gpu
});

// boot into the garage: terrain only, no match until the player picks a ride
prepareTerrain(desertTerrain);
minimapEl.setTerrain(desertTerrain.heightfield, config.world.mapHalf);
hudEl.hidden = true;
const hasPendingLocation = typeof window !== 'undefined' && (
  window.location.search.includes('scenario=') ||
  window.location.search.includes('lat=')
);
relocateBarEl.hidden = hasPendingLocation;
relocateBarEl.featured = !hasPendingLocation;
if (hasPendingLocation) {
  relocateBarEl.busy = true;
}
pickups.setVisible(false);

// ---- input ----
// One InputManager owns the keyboard and gamepad sources and merges them.
// Driving input is polled each frame; UI actions and hotkeys are edge-triggered
// and drained into whatever screen is active (or the gameplay hotkeys).
const input = new InputManager();
introEl.inputManager = input;
if (input.gamepad) {
  input.gamepad.onActivity = () => {
    audio.resume();
    if (introEl.isConnected) introEl.requestUpdate();
  };
}

/** The active UI screen's handler, or null while in gameplay. Set by screens. */
let uiHandler: ((action: UiAction) => boolean) | null = null;

/** Drop the player on a nearby spot clear of buildings. */
function resetPlayer(): void {
  const p = game.player?.body;
  if (!p || online) return;
  let x = p.pos.x, z = p.pos.z;
  for (let tries = 0; tries < 10; tries++) {
    x = p.pos.x + (Math.random() - 0.5) * 60;
    z = p.pos.z + (Math.random() - 0.5) * 60;
    if (!game.blockedWithin(x, z, 4)) break;
  }
  p.pos.set(x, game.terrainProvider.heightfield.sample(x, z) + 3, z);
  p.vel.set(0, 0, 0);
  p.angVel.set(0, 0, 0);
  p.quat.identity();
  p.snapPrev();
}

// ---- events → UI ----
const actorOf = (id: number) => world.vehicles.find(a => a.body.id === id);
events.on('contraband:pickup', ({ vehicleId }) => {
  const a = actorOf(vehicleId);
  if (!a) return;
  bannerEl.show(a.isPlayer ? 'CONTRABAND ACQUIRED' : a.team === 0 ? 'YOUR CREW HAS IT' : 'RIVALS HAVE IT', 1200);
});
events.on('contraband:stolen', ({ attackerId, victimId }) => {
  const attacker = actorOf(attackerId);
  const victim = actorOf(victimId);
  if (!attacker || !victim) return;
  const text = attacker.isPlayer ? 'YOU STOLE IT!'
    : victim.isPlayer ? 'STOLEN FROM YOU!'
      : attacker.team === 0 ? 'YOUR CREW STOLE IT' : 'RIVALS STOLE IT';
  bannerEl.show(text, attacker.isPlayer || victim.isPlayer ? 1000 : 700);
});
events.on('vehicle:wrecked', ({ vehicleId }) => {
  if (actorOf(vehicleId)?.isPlayer) bannerEl.show('WRECKED!', 1500);
});
events.on('contraband:dropped', ({ vehicleId }) => {
  bannerEl.show(actorOf(vehicleId)?.isPlayer ? 'WRECKED! CONTRABAND DROPPED' : 'CONTRABAND IS LOOSE!', 1500);
});
events.on('contraband:delivered', ({ team }) => {
  bannerEl.show(`DELIVERED! ${team === 0 ? 'YOUR CREW' : 'RIVALS'}`, 1500);
});
function skipCinematic(): void {
  if (game.matchPhase !== 'countdown') return;
  game.skipCountdown();
  cameraRig.skipIntro(vehicleViews.find(v => v.actor.isPlayer)?.pose ?? null);
  hudEl.classList.remove('cinematic');
}
skipBtn?.addEventListener('click', skipCinematic);

events.on('match:countdown', ({ n }) => {
  if (n <= 3) {
    bannerEl.show(n > 0 ? String(n) : 'GO!', n > 0 ? 900 : 800);
    if (n <= 2) {
      hudEl.classList.remove('cinematic');
    }
  } else if (n === 6) {
    const raw = world.terrainProvider.label || 'SMUGGLERS TOWN';
    const label = raw.length > 42 ? raw.slice(0, 40) + '…' : raw;
    bannerEl.show(label.toUpperCase(), 1800);
  } else if (n === 4) {
    bannerEl.show('GET READY', 900);
  }
});
events.on('match:finalMinute', () => bannerEl.show('FINAL MINUTE', 1500));
events.on('match:suddenDeath', () => bannerEl.show('SUDDEN DEATH: NEXT DELIVERY WINS', 2500));
events.on('match:win', ({ team }) => {
  bannerEl.show(team === 0 ? 'YOUR CREW WINS!' : 'RIVALS WIN!', 4000);
  setTimeout(() => {
    endEl.hidden = false;
    endEl.winner = team;
    endEl.scores = { ...world.state.scores };
    uiHandler = (a) => endEl.handleUiAction(a);
  }, 1500);
});
events.on('location:changed', ({ label }) => {
  bannerEl.show(`RELOCATED: ${label}`, 2500);
  // the garage shows where the next match plays; the banner alone is hidden
  // behind the intro panel (z 25 < 40)
  if (introEl.isConnected) introEl.locationLabel = label;
});

// ---- screens wiring ----
introEl.onSelect = (type) => showroom.setType(type);
// the intro owns UI actions while it is on screen; the frame loop drains
// InputManager actions into whatever uiHandler is set
uiHandler = (a) => introEl.handleUiAction(a);

introEl.onStart = (type) => {
  showroom.dispose();
  log.info('match start', { mode: 'single', vehicle: type, terrain: game.terrainProvider.label });
  game.playerType = type;
  startMatch(game.terrainProvider);
  introEl.remove();
  uiHandler = null;  // gameplay: no screen, driving input takes over
  hudEl.hidden = false;
  relocateBarEl.hidden = false;
  relocateBarEl.featured = false;
  relocateBarEl.open = false;
  pickups.setVisible(true);
};

introEl.onOnline = (type) => {
  void openOnline(type);
};

// settings/controls screen: opened from the garage or in-game pause, owns UI actions while open
settingsEl.inputManager = input;
settingsEl.bindAudio(audio, events);

function openSettings(): void {
  settingsEl.hidden = false;
  uiHandler = (a) => settingsEl.handleUiAction(a);
}

introEl.onControls = () => {
  openSettings();
};
settingsEl.addEventListener('settings-close', () => {
  if (introEl.isConnected) {
    uiHandler = (a) => introEl.handleUiAction(a);
  } else {
    uiHandler = null;
  }
});
settingsEl.addEventListener('resolution-change', (e: Event) => {
  const mode = (e as CustomEvent).detail.mode as Resolution3DMode;
  applyResolutionProfile(mode);
});

/** The lobby and its network code load on first use, so single player never pays for Firebase. */
async function openOnline(type: number): Promise<void> {
  if (!onlineFlow) {
    await import('./ui/screens/LobbyScreen.ts');
    const { OnlineFlow } = await import('./net/OnlineFlow.ts');
    onlineFlow = new OnlineFlow({
      events,
      store,
      lobbyEl: document.querySelector('sr-lobby') as LobbyScreen,
      // owns the tile lifecycle: a match's world replaces whatever was loaded,
      // so nothing downstream clears tiles this just streamed
      makeTerrain: async (seed, map, apiKey) => {
        clearTiles();
        if (map.kind === 'desert') {
          return createDesertTerrain(
            new Heightfield(config.world.mapHalf * 2, 256, generateDesertHeightfieldData(seed % 1000))
          );
        }
        if (!apiKey) throw new Error('no-maps-key');
        relocateBarEl.busy = true;
        loaderEl.hidden = false;
        try {
          const { terrain: loaded, tiles: newTiles, groundStreamer: newGround } = await relocateTo(
            map, apiKey, msg => { loaderEl.message = msg; }, renderer.maxAnisotropy, currentResolution3D
          );
          clearTiles();
          tiles = newTiles;
          groundStreamer = newGround ?? null;
          if (groundStreamer) {
            groundStreamer.onPatch = m => { patchDetailGrain(m.material as Material); renderer.warm(m); onGroundPatch(m); };
            groundStreamer.onPatchEvicted = (x, z) => groundShade.removePatch(x, z);
            groundStreamer.onCoverageChanged = (cells, n, cell) => terrainMesh.setPatchCoverage(cells, n, cell);
            groundStreamer.group.visible = viewMode !== 'game3d';
            renderer.scene.add(groundStreamer.group);
          }
          if (tiles) {
            tiles.group.visible = viewMode === 'photoreal' || viewMode === 'masked-tiles';
            renderer.scene.add(tiles.group);
          }
          // one ground for everything, cut from the tiles — same as single player
          const terrain: TerrainProvider = tiles ? { ...loaded, heightfield: tiles.groundHeightfield() } : loaded;
          if (tiles) attachTiles(tiles, terrain);
          return terrain;
        } finally {
          loaderEl.hidden = true;
          relocateBarEl.busy = false;
        }
      },
      makeHostGame: (seed, terrain, seats) => {
        game = new Game(terrain, { events, store, seed });
        game.setSurfaceProvider(tiles ? (x, z, cy, gy) => tiles!.surfaceElevation(x, z, cy, gy) : undefined);
        prepareTerrain(terrain, mulberry32(seed));
        game.reset(terrain, seats);
        return game;
      },
      onMatch: (match, terrain) => {
        online?.dispose();
        online = match;
        world = match.world;
        // a client has no game of its own: seat the same rocks from the same seed
        if (match.world !== game) prepareTerrain(terrain, mulberry32(match.seed));
        swapTerrainMesh(terrain);
        log.info('match start', {
          mode: match.world === game ? 'host' : 'client',
          seed: match.seed, terrain: terrain.label, real: terrain.isReal
        });
        if (terrain.isReal) events.emit('location:changed', { label: terrain.label, isReal: true });
        showroom.dispose();
        introEl.remove();
        uiHandler = null;  // gameplay: driving input takes over
        rebuildViews();
        hudEl.hidden = false;
        relocateBarEl.hidden = true;
        relocateBarEl.featured = false;
        pickups.setVisible(true);
      },
      onLeave: () => { uiHandler = null; }
    });
  }
  // the lobby screen owns UI actions while it is visible
  const lobbyEl = document.querySelector('sr-lobby') as LobbyScreen;
  uiHandler = (a) => lobbyEl.handleUiAction(a);
  onlineFlow.open(type);
}

endEl.onRematch = () => {
  // ponytail: an online rematch is a fresh lobby; reload rather than unwind the session
  if (online) {
    location.reload();
    return;
  }
  endEl.hidden = true;
  endEl.winner = null;
  uiHandler = null;  // back to gameplay
  // rematch on whatever terrain is loaded; a relocation's tiles stay in place
  startMatch(game.terrainProvider);
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
    const { terrain: loaded, tiles: newTiles, groundStreamer: newGround } = await relocate({
      query: q, apiKey: key, anisotropy: renderer.maxAnisotropy,
      resolutionMode: currentResolution3D,
      onProgress: (msg) => { loaderEl.message = msg; }
    });
    // one ground for everything: physics, spawn, drape and props all sample
    // the heightfield cut from the tiles, not the coarse elevation grid
    const terrain: TerrainProvider = newTiles
      ? { ...loaded, heightfield: newTiles.groundHeightfield() }
      : loaded;
    clearTiles();
    tiles = newTiles;
    groundStreamer = newGround ?? null;
    if (groundStreamer) {
      groundStreamer.onPatch = m => { patchDetailGrain(m.material as Material); renderer.warm(m); onGroundPatch(m); };
      groundStreamer.onPatchEvicted = (x, z) => groundShade.removePatch(x, z);
      groundStreamer.onCoverageChanged = (cells, n, cell) => terrainMesh.setPatchCoverage(cells, n, cell);
      groundStreamer.group.visible = viewMode !== 'game3d';
      renderer.scene.add(groundStreamer.group);
    }
    if (tiles) {
      tiles.group.visible = viewMode === 'photoreal' || viewMode === 'masked-tiles';
      renderer.scene.add(tiles.group);
    }
    swapTerrainMesh(terrain);
    if (tiles) attachTiles(tiles, terrain);
    if (introEl.isConnected) {
      // garage: adopt the terrain without spawning — it becomes the backdrop
      // behind the showroom, and START ENGINE plays the match on it
      game.adoptTerrain(terrain);
      prepareTerrain(terrain);
      game.setSurfaceProvider(tiles ? (x, z, cy, gy) => tiles!.surfaceElevation(x, z, cy, gy) : undefined);
      events.emit('location:changed', { label: terrain.label, isReal: terrain.isReal });
    } else {
      startMatch(terrain);
      events.emit('location:changed', { label: terrain.label, isReal: terrain.isReal });
      showroom.dispose();
      hudEl.hidden = false;
      pickups.setVisible(true);
    }
    // the relocate flow is done: hide the bar entirely (refresh to reset).
    // keeps the post-submit screen free of the GO SOMEWHERE REAL button
    relocateBarEl.featured = false;
    relocateBarEl.hidden = true;
  } catch (err) {
    log.error('relocate failed', err);
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
dirArrowEl.bind(store);
minimapEl.bind(store);

// ---- live alignment diagnostic HUD (toggle with F8 or ?debug / ?scenario) ----
const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
let showDiagnostic = !!urlParams && (urlParams.has('debug') || urlParams.has('scenario') || urlParams.has('lat'));
const diagEl = document.createElement('div');
diagEl.id = 'debug-diagnostic';
diagEl.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999;background:rgba(11,15,23,0.92);backdrop-filter:blur(8px);border:1px solid #ff5500;border-radius:8px;padding:8px 16px;font-family:\'JetBrains Mono\',monospace;font-size:11px;color:#f1f5f9;pointer-events:none;display:flex;gap:14px;align-items:center;box-shadow:0 4px 20px rgba(0,0,0,0.6);';
diagEl.style.display = showDiagnostic ? 'flex' : 'none';
diagEl.innerHTML = `
  <span style="color:#ff5a1f;font-weight:700;">[F8 DIAG]</span>
  <span id="diag-gps" style="color:#ffb84d;font-weight:600;display:none;"></span>
  <span id="diag-xz">X:0 Z:0</span>
  <span id="diag-ground">Ground: 0.0m</span>
  <span id="diag-car">Car Y: 0.0m</span>
  <span id="diag-status" style="font-weight:700;"></span>
  <span id="diag-tiles">Tiles: off</span>
  <span id="diag-osm" style="font-weight:600;color:#eab308;">OSM: ⏳ Pending</span>
  <button id="res-toggle-btn" style="pointer-events:auto;cursor:pointer;background:#1e293b;border:1px solid #10b981;color:#34d399;border-radius:4px;padding:2px 8px;font-family:inherit;font-size:11px;font-weight:700;">
    RES: Balanced [F10]
  </button>
  <button id="exp-toggle-btn" style="pointer-events:auto;cursor:pointer;background:#1e293b;border:1px solid #38bdf8;color:#38bdf8;border-radius:4px;padding:2px 8px;font-family:inherit;font-size:11px;font-weight:700;">
    EXP: Baseline (10m) [F9]
  </button>
  <button id="exp-teleport-btn" style="pointer-events:auto;cursor:pointer;background:#1e293b;border:1px solid #a855f7;color:#c084fc;border-radius:4px;padding:2px 8px;font-family:inherit;font-size:11px;font-weight:700;">
    Teleport [T]
  </button>
`;
document.body.appendChild(diagEl);

const diagGpsEl = diagEl.querySelector('#diag-gps') as HTMLElement | null;
const diagXzEl = diagEl.querySelector('#diag-xz') as HTMLElement | null;
const diagGroundEl = diagEl.querySelector('#diag-ground') as HTMLElement | null;
const diagCarEl = diagEl.querySelector('#diag-car') as HTMLElement | null;
const diagStatusEl = diagEl.querySelector('#diag-status') as HTMLElement | null;
const diagTilesEl = diagEl.querySelector('#diag-tiles') as HTMLElement | null;
const diagOsmEl = diagEl.querySelector('#diag-osm') as HTMLElement | null;
const resToggleBtn = diagEl.querySelector('#res-toggle-btn') as HTMLButtonElement | null;
const expToggleBtn = diagEl.querySelector('#exp-toggle-btn') as HTMLButtonElement | null;

window.addEventListener('keydown', (e) => {
  if (e.code === 'F8') {
    showDiagnostic = !showDiagnostic;
    diagEl.style.display = showDiagnostic ? 'flex' : 'none';
  }
  // letter hotkeys are bare keys: any of Cmd/Ctrl/Alt held means the
  // keystroke belongs to the browser (Cmd+R reload, Cmd+Shift+R hard reload),
  // so neither fire the hotkey nor preventDefault it
  const bareKey = !e.metaKey && !e.ctrlKey && !e.altKey;
  if (e.code === 'F9' || (e.code === 'KeyE' && bareKey && !e.repeat && !isTypingInField())) {
    cycleExperimentMode();
    e.preventDefault();
  }
  if (e.code === 'F10' || ((e.code === 'KeyV' || e.code === 'KeyR') && e.shiftKey && bareKey && !e.repeat && !isTypingInField())) {
    cycleResolutionMode();
    e.preventDefault();
  }
  if (e.code === 'KeyT' && bareKey && !e.repeat && !isTypingInField()) {
    teleportToObstacle();
    e.preventDefault();
  }
});

// ---- 3D Resolution & Photogrammetry Fidelity Profiles ----
let currentResolution3D: Resolution3DMode = 'balanced';
const resParam = urlParams?.get('res3d') as Resolution3DMode | null;
const savedRes = typeof localStorage !== 'undefined' ? localStorage.getItem('stt.res3d') as Resolution3DMode | null : null;
if (resParam && RESOLUTION_3D_MODES.includes(resParam)) {
  currentResolution3D = resParam;
} else if (savedRes && RESOLUTION_3D_MODES.includes(savedRes)) {
  currentResolution3D = savedRes;
}

function applyResolutionProfile(mode: Resolution3DMode): void {
  currentResolution3D = mode;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('stt.res3d', mode);
  }
  const profile = getResolutionProfile(mode);
  renderer.setDprCap(profile.dprCap);
  if (tiles) {
    tiles.setResolutionMode(mode);
  }
  if (groundStreamer) {
    groundStreamer.setZoom(profile.satelliteZoom, profile.satelliteMaxPatches, profile.anisotropy);
  }
  if (settingsEl) {
    settingsEl.resolutionMode = mode;
  }
  if (resToggleBtn) {
    resToggleBtn.textContent = `RES: ${profile.label} [F10]`;
  }
  showToast(`[3D RES: ${profile.label}] ${profile.description}`);
}

function cycleResolutionMode(): void {
  const idx = RESOLUTION_3D_MODES.indexOf(currentResolution3D);
  const next = RESOLUTION_3D_MODES[(idx + 1) % RESOLUTION_3D_MODES.length]!;
  applyResolutionProfile(next);
}

// Initialize renderer DPR cap from chosen profile
renderer.setDprCap(getResolutionProfile(currentResolution3D).dprCap);
if (settingsEl) {
  settingsEl.resolutionMode = currentResolution3D;
}
if (resToggleBtn) {
  resToggleBtn.textContent = `RES: ${getResolutionProfile(currentResolution3D).label} [F10]`;
}

// ---- Driving Experiments (Road Clearance & Building Collider Fidelity) ----
const EXPERIMENT_MODES: readonly ColliderExperimentMode[] = [
  'baseline',
  'road_carve',
  'curbside_inset',
  'high_res'
];

let currentExperiment: ColliderExperimentMode = 'baseline';
const expParam = urlParams?.get('colliderExp') as ColliderExperimentMode | null;
if (expParam && EXPERIMENT_MODES.includes(expParam)) {
  currentExperiment = expParam;
}

function experimentLabel(mode: ColliderExperimentMode): string {
  switch (mode) {
    case 'baseline': return 'Baseline (10m)';
    case 'road_carve': return 'Road-Carve (OSM)';
    case 'curbside_inset': return 'Curbside-Inset (2.4m)';
    case 'high_res': return 'High-Res 5m Grid';
  }
}

function experimentDescription(mode: ColliderExperimentMode): string {
  switch (mode) {
    case 'baseline': return '10m grid, 1.0m inset (reproduces road obstruction)';
    case 'road_carve': return 'OSM Overpass reactive rebuild + 0.85 reach clearance corridor';
    case 'curbside_inset': return '2.4m exterior street insetting (100% offline-safe)';
    case 'high_res': return '5m sub-lane grid resolution (fine-grained geometry)';
  }
}

const toastEl = document.createElement('div');
toastEl.id = 'exp-toast';
toastEl.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:9999;background:rgba(15,23,42,0.94);backdrop-filter:blur(10px);border:1px solid #38bdf8;border-radius:8px;padding:8px 18px;font-family:\'JetBrains Mono\',monospace;font-size:12px;color:#f1f5f9;box-shadow:0 8px 30px rgba(0,0,0,0.6);transition:opacity 0.3s ease, transform 0.3s ease;pointer-events:none;opacity:0;';
document.body.appendChild(toastEl);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.style.opacity = '1';
  toastEl.style.transform = 'translateX(-50%) translateY(0)';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.style.opacity = '0';
    toastEl.style.transform = 'translateX(-50%) translateY(8px)';
  }, 3500);
}

function setExperiment(mode: ColliderExperimentMode): void {
  currentExperiment = mode;
  if (tiles) {
    tiles.setExperimentMode(mode);
    if (clutterFilter) {
      clutterFilter.updateStructureGrid(tiles.structureGrid, tiles.grid.n);
    }
    applyColliders();
  }
  if (expToggleBtn) {
    expToggleBtn.textContent = `EXP: ${experimentLabel(mode)} [F9]`;
  }
  showToast(`[EXP: ${experimentLabel(mode)}] ${experimentDescription(mode)}`);
}

function cycleExperimentMode(): void {
  const idx = EXPERIMENT_MODES.indexOf(currentExperiment);
  const next = EXPERIMENT_MODES[(idx + 1) % EXPERIMENT_MODES.length]!;
  setExperiment(next);
}

function teleportToObstacle(): void {
  const player = world.player;
  if (!player) return;
  const targetX = 290;
  const targetZ = 12;
  const hf = world.terrainProvider.heightfield;
  const targetY = (tiles ? tiles.surfaceElevation(targetX, targetZ, 15, hf.sample(targetX, targetZ)) : null)
    ?? (hf.sample(targetX, targetZ) + 1.2);

  player.body.pos.set(targetX, targetY, targetZ);
  player.body.vel.set(0, 0, 0);
  player.body.angVel.set(0, 0, 0);
  player.body.quat.setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2);
  player.body.snapPrev();
  cameraRig.skipIntro(player.body);
  cameraRig.snap(player.body);
  showToast('Teleported in front of St. Johns Bridge road test spot (X:290, Z:12)');
}

diagEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  if (target.id === 'res-toggle-btn' || target.closest('#res-toggle-btn')) {
    cycleResolutionMode();
  } else if (target.id === 'exp-toggle-btn' || target.closest('#exp-toggle-btn')) {
    cycleExperimentMode();
  } else if (target.id === 'exp-teleport-btn' || target.closest('#exp-teleport-btn')) {
    teleportToObstacle();
  }
});

// ---- URL test scenarios / deep linking (?scenario=<id> | ?lat=<lat>&lon=<lon> | ?key=<apiKey>) ----
if (urlParams) {
  const urlKey = urlParams.get('key');
  if (urlKey) {
    localStorage.setItem('gmap_key', urlKey.trim());
  }
  const scenarioId = urlParams.get('scenario');
  const latStr = urlParams.get('lat');
  const lonStr = urlParams.get('lon');

  let targetCoords: string | null = null;
  let targetScenario: TestScenario | undefined = undefined;

  if (scenarioId) {
    targetScenario = getScenario(scenarioId);
    if (targetScenario) {
      targetCoords = `${targetScenario.lat}, ${targetScenario.lon}`;
    }
  } else if (latStr && lonStr) {
    const lat = parseFloat(latStr);
    const lon = parseFloat(lonStr);
    if (!isNaN(lat) && !isNaN(lon)) {
      targetCoords = `${lat}, ${lon}`;
      targetScenario = findScenarioByCoords(lat, lon);
    }
  }

  if (targetCoords) {
    const activeKey = urlKey || localStorage.getItem('gmap_key') || '';
    if (activeKey) {
      relocateBarEl.busy = true;
      relocateBarEl.hidden = true;
      relocateBarEl.featured = false;
      setTimeout(() => {
        // a deep link relocates into the garage backdrop — START ENGINE (or a
        // game already in progress) plays from there; no forced match start
        relocateBarEl.onSearch?.(targetCoords, activeKey);
      }, 50);
    } else {
      setTimeout(() => {
        relocateBarEl.setQuery(targetCoords);
        relocateBarEl.status = `Scenario: ${targetScenario?.name ?? targetCoords}. Enter Google Maps API key to relocate.`;
      }, 200);
    }
  }
}

// ---- frame loop ----
let last = performance.now();
let simTime = 0;

function frame(now: number): void {
  const rawDt = (now - last) / 1000;
  last = now;

  // When tab is hidden or backgrounded, skip simulation and avoid corrupting adaptive resolution
  if (typeof document !== 'undefined' && document.hidden) {
    requestAnimationFrame(frame);
    return;
  }

  const dt = Math.min(rawDt, config.loop.maxFrameDt);
  if (rawDt <= 0.15) {
    renderer.adapt(rawDt, now);
  }

  if (showDiagnostic && world.player?.body) {
    const b = world.player.body;
    const hf = world.terrainProvider.heightfield;
    const groundY = hf.sample(b.pos.x, b.pos.z);
    const diff = b.pos.y - groundY;
    const isUnder = diff < -0.3;
    const center = world.terrainProvider.center;
    if (center && diagGpsEl) {
      const gps = worldToLl(b.pos.x, b.pos.z, center);
      const matched = findScenarioByCoords(gps.lat, gps.lon);
      diagGpsEl.style.display = 'inline';
      diagGpsEl.textContent = `${matched ? `[${matched.name}]` : 'GPS'} ${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}`;
    } else if (diagGpsEl) {
      diagGpsEl.style.display = 'none';
    }
    if (diagXzEl) diagXzEl.textContent = `X:${b.pos.x.toFixed(0)} Z:${b.pos.z.toFixed(0)}`;
    if (diagGroundEl) diagGroundEl.textContent = `Ground: ${groundY.toFixed(1)}m`;
    if (diagCarEl) diagCarEl.textContent = `Car Y: ${b.pos.y.toFixed(1)}m`;
    if (diagStatusEl) {
      diagStatusEl.style.color = isUnder ? '#ff2d55' : '#7dd87d';
      diagStatusEl.textContent = isUnder ? `⚠️ UNDERGROUND (${Math.abs(diff).toFixed(1)}m)` : `✅ ON SURFACE (Δ ${diff.toFixed(2)}m)`;
    }
    if (diagTilesEl) {
      diagTilesEl.textContent = `Tiles: ${tiles ? `${tiles.tileCount} active` : 'off'}${groundStreamer ? ` | Sat: Z${groundStreamer.activeZoom} (${groundStreamer.patchCount}p)` : ''}`;
    }
    if (diagOsmEl) {
      diagOsmEl.style.color = tiles?.hasRoadGrid ? '#38bdf8' : '#eab308';
      diagOsmEl.textContent = `OSM: ${tiles?.hasRoadGrid ? '✅ Loaded' : '⏳ Pending'}`;
    }
  }

  // poll every source each frame so gamepad edges fire on menus too — the
  // gamepad has no keydown event, so its edge scan must run even when nothing
  // is driving (vehicleInput is only called while playing, below)
  input.poll();
  // UI actions and hotkeys drain every frame, menus open or not; each screen
  // registers a handler that returns true if it consumed the action
  const uiActions = input.drainUiActions();
  if (uiActions.length > 0) audio.resume();
  for (const action of uiActions) {
    if (uiHandler) {
      if (uiHandler(action)) continue;
    }
    if (game.matchPhase === 'countdown' && (action === 'confirm' || action === 'pause')) {
      skipCinematic();
      continue;
    }
    // unhandled UI action while no screen is open: treat pause/back specially
    if (action === 'pause' && !introEl.isConnected && endEl.hidden) {
      openSettings();
    }
  }
  for (const hot of input.drainHotkeys()) {
    if (hot === 'camera') cameraRig.cycleMode();
    if (hot === 'reset') resetPlayer();
    if (hot === 'viewMode') toggleViewMode();
    if (hot === 'clutterMode') cycleClutterMode();
  }
  const playing = !introEl.isConnected && endEl.hidden;
  if (playing) {
    const drive = input.vehicleInput();
    // the sessions get real elapsed time: Game clamps its own step, and a
    // client's playback clock must not run slow just because frames are
    if (online) online.tick(rawDt, drive);
    else game.update(dt, drive);
    simTime += dt;
    const player = world.player?.body ?? null;
    if (tiles && player) {
      tiles.update(player.pos, now);
      // refined tiles change the building footprints; rebuild at most every 1.5 s
      if (tiles.collidersDirty && now - colliderRefreshAt > 1500) {
        colliderRefreshAt = now;
        refreshColliders();
        if (!groundBuilder) {
          groundBuilder = tiles.createGroundBuilder();
        }
      }
    }
    // Step amortized ground refinement (bounded to 1.5ms per frame)
    if (groundBuilder && tiles) {
      const finished = groundBuilder.step(1.5);
      if (finished && groundBuilder.result) {
        const refined = Heightfield.fromCells(groundBuilder.result, tiles.grid.n, tiles.grid.cell);
        world.terrainProvider.heightfield.copyFrom(refined);
        if (game && (game as unknown) !== world) {
          game.terrainProvider.heightfield.copyFrom(refined);
        }
        terrainMesh.refresh(world.terrainProvider.heightfield);
        clutterFilter?.groundChanged(world.terrainProvider.heightfield);
        buildingMeshView.refreshHeights((x, z) => world.terrainProvider.heightfield.sample(x, z));
        if (groundStreamer) groundStreamer.refresh();
        groundBuilder = null;
      }
    }
    if (groundStreamer && player) {
      groundStreamer.update(player.pos, now);
    }
    for (const v of vehicleViews) v.sync(dt, world.alpha);
    // each carried crate rides its carrier's interpolated pose, not the body,
    // so it does not judder a frame behind the car it is strapped to
    pickups.sync(world.state, simTime, dt, body => vehicleViews.find(v => v.actor.body === body)?.pose ?? null);
    cameraRig.update(dt, vehicleViews.find(v => v.actor.isPlayer)?.pose ?? null);
    const nav = world.navMarker();
    if (nav) dirArrowEl.setNav(nav.yaw, nav.distance);
    minimapEl.draw(world.state, world.vehicles, world.player, nav?.target ?? null);
    audio.update(dt, world, drive, world.state, true);
  } else {
    audio.update(dt, null, null, null, false);
    if (introEl.isConnected) {
      showroom.update(dt, window.innerWidth, window.innerHeight);
      if (tiles) tiles.update(renderer.camera.position, now);
      if (groundStreamer) groundStreamer.update(renderer.camera.position, now);
    }
  }
  renderer.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
