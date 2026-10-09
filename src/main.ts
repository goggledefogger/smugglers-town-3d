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
import { BuildingMeshView, anchorCollider } from './render/BuildingMeshView.ts';
import { FacadeBaker, ATLAS_SIZE } from './render/FacadeBaker.ts';
import { PrismMeshView, wallColliders, type Prism } from './render/PrismMeshView.ts';
import { RoadRibbonView } from './render/RoadRibbonView.ts';
import { pointInRing, type Footprint } from './services/overture/buildings.ts';
import {
  packFootprints, CutoutStencilBuilder, cutoutInputDigest, fallbackCarBoxes, ROOF_MIN_M, type CoverageGap, type FootprintMaskOptions, type PackedFootprints, type RoofInput
} from './services/overture/footprintMask.ts';
import { CoalescedRebuild } from './services/overture/coalescedRebuild.ts';
import { StencilColliders } from './services/overture/stencilWalls.ts';
import { RemeasureTracker } from './services/overture/remeasureTracker.ts';
import { SEG_STRIDE } from './services/overture/stencilTrace.ts';
import { CutoutDebugOverlay } from './render/CutoutDebugOverlay.ts';
import type { FootprintMaskJob, FootprintMaskResult, HeightMessage, HeightReply } from './services/overture/footprintMaskWorker.ts';
import { HeightCapture } from './render/HeightCapture.ts';
import type { HeightState } from './services/overture/heightField.ts';
import { VIEW_MODE_CYCLE, traits, parseViewMode, type ViewMode } from './render/viewModes.ts';
import { NO_DATA } from './services/tiles/tileColliders.ts';
import { TileClutterFilter, type ClutterMode } from './render/TileClutterFilter.ts';
import { VehicleView } from './render/VehicleView.ts';
import { PropScatter } from './render/PropScatter.ts';
import { Pickups } from './render/Pickups.ts';
import { CameraRig } from './render/CameraRig.ts';
import { AudioManager } from './audio/AudioManager.ts';
import { Vector3 } from 'three';

import { Showroom } from './render/Showroom.ts';
import { setVehicleEnvMap } from './render/vehicles/index.ts';
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
import { FrameProfiler } from './app/frameProfiler.ts';
import { PROTOCOL_VERSION } from './net/protocol.ts';
import { relocate, relocateTo } from './services/relocate.ts';
import { FOOTPRINT_RADIUS_M, type TileStreamer } from './services/tiles/Tileset.ts';
import { AmortizedGroundBuilder, TILE_GROUND_GAP, type ColliderExperimentMode } from './services/tiles/tileColliders.ts';
import {
  type Resolution3DMode, RESOLUTION_3D_MODES, getResolutionProfile,
  loadResolution3D, saveResolution3D
} from './services/tiles/resolutionProfiles.ts';
import { SurfaceHeightfield, surfaceGate, type SurfaceGate } from './core/terrain/SurfaceHeightfield.ts';
import { SurfaceCapture, SurfacePreview } from './render/SurfaceCapture.ts';
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
// an uncaught error otherwise reaches only the console, where a player's
// "copy debug log" and the remote log never see it
const errorData = (e: unknown): unknown =>
  e instanceof Error ? { message: e.message, stack: e.stack?.split('\n').slice(0, 5).join(' | ') } : e;
window.addEventListener('error', e => log.error('uncaught', errorData(e.error ?? e.message)));
window.addEventListener('unhandledrejection', e => log.error('unhandled rejection', errorData(e.reason)));
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
      <button id="surface-btn" class="hud-btn" type="button" hidden title="True Surface: the wheels ride a 1 m surface captured from the photogrammetry (kerbs, humps, ramps) instead of the 10 m ground grid. Physics, so the host decides online (Hotkey: U)">
        <span>🛣️</span> <span id="surface-text">SURFACE: OFF</span> <span class="mono" style="opacity:0.6;font-size:9px;">[U]</span>
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
const profiler = new FrameProfiler(events);
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
/** Footprint 3D: Overture building polygons extruded to their heights (render/PrismMeshView.ts). */
const prismView = new PrismMeshView();
renderer.scene.add(prismView.group);
if (typeof window !== 'undefined') (window as any).__prismView = prismView;
/** Vector City: the OSM road ways as asphalt ribbons (render/RoadRibbonView.ts). */
const roadRibbons = new RoadRibbonView();
renderer.scene.add(roadRibbons.group);
if (typeof window !== 'undefined') (window as any).__roadRibbons = roadRibbons;
/** Painted 3D: photos of the tiles baked onto the box faces (render/FacadeBaker.ts). */
const facadeBaker = new FacadeBaker(renderer.renderer, renderer.scene, {
  tiles: () => tiles?.group ?? null,
  // the photo wants the raw tiles: no clutter flattening, no snapping
  before: () => { if (clutterFilter) { bakeSaved = { mode: clutterFilter.mode, snap: clutterFilter.snap }; clutterFilter.mode = 'off'; clutterFilter.snap = false; } },
  after: () => { if (clutterFilter && bakeSaved) { clutterFilter.mode = bakeSaved.mode; clutterFilter.snap = bakeSaved.snap; } },
  onRect: (box, face, r, pv0) => buildingMeshView.setFaceRect(box, face, r.x, r.y, r.w, r.h, ATLAS_SIZE, pv0),
  onWallRect: (wall, r, pv0) => prismView.setWallRect(wall, r.x, r.y, r.w, r.h, ATLAS_SIZE, pv0)
});
/** the colliders as last applied, so switching into Painted 3D can queue their faces */
let lastColliders: readonly BuildingCollider[] = [];
/** the tile boxes as last received, so a mode switch can re-apply them against the other physics shape */
let lastTileBoxes: readonly BuildingCollider[] = [];
/** the cars currently hit the footprint walls (the prism modes) rather than the boxes */
let physicsOnWalls = false;
// Cutout 3D collision state: declared before the first setViewMode, which runs at module load
/** Cutout 3D's car colliders: the stencil on screen traced into walls (one source for picture and physics). */
const cutoutWalls = new StencilColliders();
/** The car is on the stencil walls right now (Cutout 3D with a stencil landed). */
let carOnStencil = false;
/** The car's colliders were last built for Cutout 3D (its fallback boxes pass the roofed-over rule). */
let carInCutout = false;
/**
 * Cutout 3D's roofed-over rule (m): a classifier gap group fills the stencil, and a classifier box
 * collides before the stencil lands, only if some cell's lowest geometry stands this far above the
 * ground, so poles, trees and steps over open paving do not. ?cutoutRoofMin= overrides for tuning.
 */
const CUTOUT_ROOF_MIN_M = ((): number => {
  const q = Number(new URLSearchParams(window.location.search).get('cutoutRoofMin') ?? '');
  return Number.isFinite(q) && q > 0 ? q : ROOF_MIN_M;
})();
/** ?cutoutDebug=1 / window.__cutoutDebug(on): draw the walls the car can hit, coloured by source. */
let cutoutDebug = new URLSearchParams(window.location.search).get('cutoutDebug') === '1';
let cutoutDebugOverlay: CutoutDebugOverlay | null = null;
let bakeSaved: { mode: ClutterMode; snap: boolean } | null = null;
if (typeof window !== 'undefined') (window as any).__facadeBaker = facadeBaker;
buildingMeshView.visible = false;
if (typeof window !== 'undefined') {
  (window as any).__buildingMeshView = buildingMeshView;
  (window as any).__terrainMesh = terrainMesh;
  (window as any).__renderer = renderer;
  (window as any).__setViewMode = (m: ViewMode) => setViewMode(m);
}
export type { ViewMode } from './render/viewModes.ts';
/** ?view=cutout-3d (any mode name) starts in that view. */
let viewMode: ViewMode = parseViewMode(new URLSearchParams(window.location.search).get('view')) ?? 'photoreal';
let clutterFilter: TileClutterFilter | null = null;
// the mode survives a relocate: a new filter starts in it
// swept by default: flattens road clutter while keeping kerbside building facades
// and trees over the sharper streamed satellite ground
let clutterMode: ClutterMode = 'off';
/** Modes that discard the tile's own road surface, so satellite ground must stream beneath tiles. */
const REVEALS_GROUND: ReadonlySet<ClutterMode> = new Set(['hidden', 'swept', 'cutout']);
const clutterBtn = document.getElementById('clutter-btn') as HTMLButtonElement | null;
const clutterText = document.getElementById('clutter-text') as HTMLSpanElement | null;
const CLUTTER_LABEL: Record<ClutterMode, string> = { off: 'CLUTTER: OFF', flatten: 'CLUTTER: FLAT', hidden: 'CLUTTER: HIDDEN', swept: 'CLUTTER: SWEPT', cutout: 'CLUTTER: CUTOUT' };

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

// ---- True Surface (physics): wheels sample a 1 m GPU capture of the tiles ----
// Off by default; ?surface=1 starts with it on. Only the sim's owner may turn
// it on: online that is the host, and a client only shows the host decides.
let surfaceOn = new URLSearchParams(window.location.search).get('surface') === '1';
/** The wheels are on the composite right now (on, tiles loaded, tiles on screen, and this browser owns the sim). */
let surfaceActive = false;
let surfaceState: SurfaceGate = 'off';
// made once and kept: switching the mode back on, or relocating, then costs no shader compile
let surfaceField: SurfaceHeightfield | null = null;
let surfaceCapture: SurfaceCapture | null = null;
let surfacePreview: SurfacePreview | null = null;
let surfacePreviewAt = 0;
const surfaceBtn = document.getElementById('surface-btn') as HTMLButtonElement | null;
const surfaceText = document.getElementById('surface-text') as HTMLSpanElement | null;

/** Online and not the host: the sim, and so the ground, is someone else's. */
function isOnlineClient(): boolean {
  return online !== null && (world as unknown) !== game;
}

function updateSurfaceUi(): void {
  if (!surfaceBtn || !surfaceText) return;
  surfaceBtn.hidden = !tiles;
  const client = surfaceState === 'client';
  surfaceBtn.classList.toggle('active', surfaceState === 'active' || surfaceState === 'hidden');
  surfaceText.textContent = client ? 'SURFACE: HOST DECIDES'
    : surfaceState === 'active' ? 'SURFACE: TRUE 1M'
    : surfaceState === 'hidden' ? 'SURFACE: TRUE 1M (HIDDEN VIEW)'
    : 'SURFACE: OFF';
}

/** Wheels back on the base ground; the capture is forgotten but its GPU objects kept. */
function deactivateSurface(): void {
  surfaceActive = false;
  surfaceCapture?.reset();
  game.setVehicleGround(undefined);
  if (surfacePreview) surfacePreview.visible = false;
}

/** Bring the composite in line with surfaceOn, the loaded tiles and the current game. Idempotent. */
function applySurface(): void {
  surfaceState = surfaceGate({
    on: surfaceOn, hasTiles: !!tiles, onlineClient: isOnlineClient(), showsTiles: traits(viewMode).showsTiles
  });
  if (surfaceState !== 'active' || !tiles) {
    // off, a client, or a view that hides the tiles: base ground, capture paused
    deactivateSurface();
    updateSurfaceUi();
    return;
  }
  // wrap the live base object, never a copy: ground refinement writes into it in place
  const base = game.terrainProvider.heightfield;
  if (!surfaceField || !surfaceCapture) {
    surfaceField = new SurfaceHeightfield(base, (x, z) => tiles?.isRoadAt(x, z) ?? false, { liftM: TILE_GROUND_GAP });
    surfaceCapture = new SurfaceCapture(
      renderer.renderer, surfaceField, () => tiles?.group ?? null, () => game.terrainProvider.heightfield
    );
  } else if (surfaceField.base !== base || !surfaceActive) {
    // a new world or a fresh switch-on: nothing captured so far applies
    surfaceField.base = base;
    surfaceCapture.reset();
  }
  surfaceActive = true;
  game.setVehicleGround(surfaceField);
  updateSurfaceUi();
}

function toggleSurfaceMode(): void {
  if (isOnlineClient()) {
    showToast('True Surface changes physics: the host decides');
    return;
  }
  surfaceOn = !surfaceOn;
  applySurface();
  if (!tiles) showToast(`True Surface ${surfaceOn ? 'armed' : 'off'}: it needs a real place with 3D tiles`);
  else if (surfaceState === 'hidden') showToast('True Surface on, paused: this view hides the 3D tiles, so the wheels keep the 10 m grid');
  else showToast(surfaceOn ? 'True Surface: wheels ride the 1 m tile surface' : 'True Surface off: 10 m ground grid');
}

surfaceBtn?.addEventListener('click', toggleSurfaceMode);
(window as any).__surface = () => ({ on: surfaceOn, active: surfaceActive, field: surfaceField, capture: surfaceCapture });

/** Every tile, now and as they refine: clutter filter patched in, programs and textures warmed. */
function attachTiles(streamer: TileStreamer, terrain: TerrainProvider): void {
  (window as any).__tiles = streamer; // scripts/clutter-shots.mjs teleports onto a road cell through this
  cutoutTerrain = terrain;
  clutterFilter = new TileClutterFilter(
    terrain.heightfield, streamer.structureGrid, streamer.grid.n, terrain.reliefBoost
  );
  (window as any).__clutterFilter = clutterFilter;
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
    if (viewMode === 'vector-city') rebuildRibbons();
    showToast('OSM Road Mask Loaded: Road Corridors Carved');
  };
  streamer.onBuildingsLoaded = () => {
    log.info('building footprints arrived in background, refreshing colliders');
    refreshColliders();
    // the prisms exist now: the mode re-applies so they replace the boxes and queue for the baker
    // (Cutout 3D: its stencil replaces the structure fallback, and its traced walls the boxes)
    cutoutMaskFor = null;
    cutoutDirty = true;
    cutoutCoverageLogged = false;
    footprintsLandedAt = performance.now();
    if (traits(viewMode).prismPhysics || traits(viewMode).cutsToFootprints) setViewMode(viewMode);
  };
  clutterFilter.patch(streamer.group);
  renderer.warm(streamer.group);
  streamer.group.traverse(o => o.layers.set(1));
  streamer.onTileLoaded = g => {
    clutterFilter?.patch(g);
    renderer.warm(g);
    g.traverse(o => o.layers.set(1));
    // no collider rebuild here: a city streams hundreds of tiles, and one per
    // tile chained rebuilds back to back (40-360 ms each on the main thread).
    // The frame loop picks up the dirty tiles, at most every 1.5 s
  };
  updateClutterUi();
  setViewMode(viewMode);
}

function updateViewModeUi(): void {
  if (!viewModeBtn || !viewModeText) return;
  viewModeBtn.classList.toggle('active', viewMode !== 'photoreal');
  viewModeText.textContent = traits(viewMode).label;
}

function setViewMode(mode: ViewMode): void {
  viewMode = mode;
  const isRawPhotoreal = mode === 'photoreal';
  const isMaskedTiles = mode === 'masked-tiles';
  const isBest3d = traits(mode).snapsTiles;
  const isPainted = traits(mode).paintsBoxes;
  const isCutout = traits(mode).cutsToFootprints;
  // a prism mode before Overture answers shows the boxes; the load re-applies the mode
  const hasPrisms = traits(mode).prismPhysics && (rebuildPrisms(), prismView.count > 0);
  const isFootprint = traits(mode).showsPrisms && hasPrisms;
  const hasTiles = traits(mode).showsTiles;

  if (tiles) tiles.group.visible = hasTiles;
  if (hasTiles) {
    renderer.camera.layers.enable(1);
  } else {
    renderer.camera.layers.disable(1);
  }

  if (clutterFilter) {
    clutterFilter.snap = isBest3d;
    if (isBest3d) {
      clutterFilter.mode = 'hidden';
      clutterMode = 'hidden';
    } else if (isMaskedTiles) {
      clutterFilter.mode = 'swept';
      clutterMode = 'swept';
    } else if (isRawPhotoreal) {
      clutterFilter.mode = 'off';
      clutterMode = 'off';
    } else if (isCutout) {
      rebuildCutoutMask();
      clutterFilter.mode = 'cutout';
      clutterMode = 'cutout';
    } else if (clutterMode === 'cutout') {
      // cutout is this view's alone: the box and prism modes go back to the default
      clutterFilter.mode = 'off';
      clutterMode = 'off';
    }
    updateClutterUi();
  }

  if (groundStreamer) {
    groundStreamer.group.visible = true;
    if (isRawPhotoreal || isMaskedTiles) {
      groundStreamer.underTiles = REVEALS_GROUND.has(clutterMode);
    } else {
      groundStreamer.underTiles = true;
    }
  }

  terrainMesh.setMode(mode === 'game3d' ? 'game3d' : 'photoreal');

  // In photoreal and masked-tiles modes, real 3D tiles are shown cleanly without collider box occlusion.
  // In all other modes (including best-3d), buildingMeshView provides the physical solid collision geometry.
  // Cutout 3D: the cut photogrammetry is the building, the walls traced from its stencil collide
  buildingMeshView.visible = !(isRawPhotoreal || isMaskedTiles || isFootprint || isCutout);
  prismView.visible = isFootprint;
  roadRibbons.visible = mode === 'vector-city';
  // built on first entry, not when the roads land: draping 2,000 ways is a frame's worth of work
  if (mode === 'vector-city' && roadRibbons.vertexCount === 0) rebuildRibbons();
  buildingMeshView.setFacade(traits(mode).proceduralFacades);
  prismView.setFacade(traits(mode).proceduralFacades);

  const satTex = terrainMesh.sourceTexture ?? terrainMesh.texture;
  if (satTex) {
    buildingMeshView.setTexture(satTex, config.world.mapHalf * 2);
  }

  buildingMeshView.setMode(mode === 'game3d' ? 'arcade' : 'textured');
  buildingMeshView.setAtlas(isPainted ? facadeBaker.texture : null);
  if (satTex) prismView.setTexture(satTex, config.world.mapHalf * 2);
  prismView.setAtlas(mode === 'footprint-3d' ? facadeBaker.texture : null);
  // the baker holds one job list: the box faces or the footprint walls
  if (mode === 'footprint-3d' && isFootprint) {
    facadeBaker.setWalls(prismView.walls);
  } else if (isPainted) {
    facadeBaker.setColliders(lastColliders);
  }

  renderer.setLightRig((hasTiles || traits(mode).paintsWalls || mode === 'vector-city') && world.terrainProvider.isReal ? 'photo' : 'arcade');
  // what the car hits follows what it sees: the outline walls in a prism mode, the
  // stencil's traced walls in Cutout 3D, the boxes elsewhere
  if (hasPrisms !== physicsOnWalls) applyTileColliders(lastTileBoxes);
  // in and out of Cutout 3D: the stencil walls take over from (or hand back to) the boxes
  else if (carOnStencil !== (isCutout && cutoutWalls.walls !== null) || carInCutout !== isCutout) refreshCarColliders();
  // the wheels ride the captured surface only in a view that shows it
  applySurface();
  if (cutoutDebug) updateCutoutDebug();
  updateViewModeUi();
}

function toggleViewMode(): void {
  setViewMode(VIEW_MODE_CYCLE[(VIEW_MODE_CYCLE.indexOf(viewMode) + 1) % VIEW_MODE_CYCLE.length]!);
}

viewModeBtn?.addEventListener('click', () => {
  toggleViewMode();
});
setViewMode(viewMode);

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
let colliderPending = false;

/** The streaming loop's rebuild, in the tile worker; tiles that change meanwhile re-dirty for the next one. */
function refreshColliders(): void {
  if (!tiles) return;
  if (colliderJob) {
    colliderPending = true;
    return;
  }
  colliderPending = false;
  colliderJob = tiles.collidersAsync()
    .then(boxes => profiler.time('colliders', () => applyTileColliders(boxes)))
    .catch(e => log.warn('collider rebuild failed', e))
    .finally(() => {
      colliderJob = null;
      if (colliderPending) {
        refreshColliders();
      }
    });
}

/**
 * The ground a footprint stands on, from the heightfield under its ring's
 * vertices: the mean (its roof is measured from it) and the lowest (its
 * prism's base, and Cutout 3D's roof cap reference), plus its box.
 */
function footprintGround(p: Footprint, hf: { sample(x: number, z: number): number }):
  { ground: number; gMin: number; x0: number; x1: number; z0: number; z1: number } | null {
  let gMin = Infinity, gSum = 0, n = 0;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i + 3 < p.ring.length; i += 2) {
    const x = p.ring[i]!, z = p.ring[i + 1]!;
    const g = hf.sample(x, z);
    gMin = Math.min(gMin, g); gSum += g; n++;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  return n === 0 ? null : { ground: gSum / n, gMin, x0, x1, z0, z1 };
}

/** Height a footprint without an Overture height gets (m): two storeys, so it at least stands. */
const PRISM_FALLBACK_M = 6;

/**
 * Footprint 3D geometry: every Overture polygon from the ground it stands
 * on up to its height. Without a height, the photogrammetry roof over the
 * footprint (the classifier's per-cell tops) says how tall it is.
 */
let prismsFor: readonly Footprint[] | null = null;
function rebuildPrisms(): boolean {
  const polys = tiles?.footprints;
  if (!tiles || !polys) return false;
  // ponytail: built once per footprint set (~750 ms for a downtown); the roof-raster
  // fallback behind the 5% of polygons without a height is not worth re-extruding for
  if (prismsFor === polys && prismView.walls.length > 0) return false;
  prismsFor = polys;
  const hf = world.terrainProvider.heightfield;
  const grid = tiles.activeGrid;
  const tops = tiles.activeTopGrid;
  const prisms: Prism[] = [];
  for (const p of polys) {
    const fg = footprintGround(p, hf);
    if (!fg) continue;
    const { ground, gMin, x0, x1, z0, z1 } = fg;
    let height = p.height;
    if (height == null) {
      let top = -Infinity;
      const i0 = Math.max(0, Math.floor((x0 + grid.half) / grid.cell)), i1 = Math.min(grid.n - 1, Math.floor((x1 + grid.half) / grid.cell));
      const j0 = Math.max(0, Math.floor((z0 + grid.half) / grid.cell)), j1 = Math.min(grid.n - 1, Math.floor((z1 + grid.half) / grid.cell));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const t = tops[j * grid.n + i]!;
        if (t === NO_DATA || t <= top) continue;
        if (pointInRing(p.ring, -grid.half + (i + 0.5) * grid.cell, -grid.half + (j + 0.5) * grid.cell)) top = t;
      }
      height = top > -Infinity ? Math.max(3, top - ground) : PRISM_FALLBACK_M;
    }
    // a metre into the ground on the low side so a hillside never shows under the wall
    const y0 = p.minHeight > 0 ? ground + p.minHeight : gMin - 1;
    prisms.push({ ring: p.ring, holes: p.holes, y0, y1: ground + p.minHeight + height, part: p.part });
  }
  prismView.build(prisms);
  return true;
}

/**
 * Cutout 3D stencil dilation (m): grows each footprint so leaning facades and overhangs are not
 * shaved. 2, not 1.5: in SF (Market and Montgomery) tile geometry over 18 m up left outside the
 * stencil fell from 7.6% at 1.5 m to 3.9% at 2 m with no extra kerb clutter. ?cutoutDilate= overrides.
 */
const CUTOUT_DILATE_M = Number(new URLSearchParams(window.location.search).get('cutoutDilate') ?? '') || 2;
/**
 * Cutout 3D stencil texel (m). 1 m normally; 2 m on a device that looks weak
 * (4 or fewer cores, 4 GB or less, or a max texture under 4096), which
 * quarters the raster, the 13 MB upload and the texture memory. ?cutoutTexel= overrides.
 */
const CUTOUT_WEAK_DEVICE = ((): boolean => {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return (nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 4
    || renderer.renderer.capabilities.maxTextureSize < 4096;
})();
const CUTOUT_TEXEL_M = ((): number => {
  const q = Number(new URLSearchParams(window.location.search).get('cutoutTexel') ?? '');
  return q > 0 ? q : CUTOUT_WEAK_DEVICE ? 2 : 1;
})();
/**
 * Cutout 3D roof cap: the stencil goes RG8, G the footprint's roof plus
 * CUTOUT_ROOF_MARGIN_M, and canopy above it is cut. Doubles the upload
 * (26 MB at 1 m), so a weak device keeps the R8 stencil (3.2 MB at 2 m)
 * uncapped. ?cutoutCap=1 / 0 overrides.
 */
const CUTOUT_ROOF_CAP = ((): boolean => {
  const q = new URLSearchParams(window.location.search).get('cutoutCap');
  return q === '1' ? true : q === '0' ? false : !CUTOUT_WEAK_DEVICE;
})();
/** Metres above the sampled roof that survive the cap: parapets, rooftop units, the dilation band's roof edge. */
const CUTOUT_ROOF_MARGIN_M = 3;
/**
 * How far (m) a footprint grows into the connected mesh the height field calls a building: registration
 * (1-3 m) plus an unmapped bay or wing. Reasoned, not measured: `grownTruncated` in the stats says if it is
 * short. Off at a 2 m texel (a weak device keeps the polygon), where the field is not read 1:1.
 */
const CUTOUT_GROW_M = 8;
/**
 * How far (m) the skirt runs out past the grown footprints into mesh that rises 1.5-3 m (the hysteresis floor up
 * to the keep rise) and is not kept: the strip at a wall's foot, a plinth, steps, an entrance canopy. Without it
 * that strip is cut and the satellite ground shows through a band at the base of the wall. Off with growth at a
 * 2 m texel. `skirted` in the stats counts it.
 */
const CUTOUT_SKIRT_M = 3;
/** The stencil covers the footprint fetch radius both ways, and no more. */
const CUTOUT_MASK_OPTS = {
  size: FOOTPRINT_RADIUS_M * 2, cell: CUTOUT_TEXEL_M, dilateM: CUTOUT_DILATE_M, roofCap: CUTOUT_ROOF_CAP,
  growM: CUTOUT_TEXEL_M === 2 ? 0 : CUTOUT_GROW_M,
  skirtM: CUTOUT_TEXEL_M === 2 ? 0 : CUTOUT_SKIRT_M
};
/** The mask options for a build: the constants plus the keep rise the height field is applied with (its relief). */
const cutoutMaskOpts = (): FootprintMaskOptions => ({
  ...CUTOUT_MASK_OPTS, keepRiseM: CUTOUT_MIN_RISE_M * (cutoutTerrain ?? world.terrainProvider).reliefBoost
});
/** A classifier building cell with an Overture texel this close (m) is covered; farther, it is a gap. */
const CUTOUT_GAP_REACH_M = 3;
/** Streaming tiles rewrite the classifier grid every collider pass: the stencil follows at most this often. */
const CUTOUT_REBUILD_MS = 2000;
let cutoutMaskFor: readonly Footprint[] | null = null;
/** the last stencil uploaded, for __cutoutMaskAt */
let cutoutLastMask: { n: number; cell: number; cx: number; cz: number; size: number; channels: 1 | 2; data: Uint8Array } | null = null;
/** The terrain the attached tileset plays on: the stencil's roof caps and tops share its frame. */
let cutoutTerrain: TerrainProvider | null = null;
/** A footprint the mesh rises less than this over (m) is not stencilled: an empty lot or a shed. */
const CUTOUT_MIN_RISE_M = 3;
let cutoutCoverageStat: (CoverageGap & { footprints: number; gapCells: number }) | null = null;
let cutoutCoverageLogged = false;
let footprintsLandedAt = Infinity;
/** Inputs moved since the last build (footprints, classifier grid, tileset). */
let cutoutDirty = true;
/** The footprint set the stencil builder holds, and its id; a new set is packed and sent once. */
let cutoutBuilderFor: readonly Footprint[] | null = null;
let cutoutSetId = 0;
let cutoutJobId = 0;
let cutoutWorker: Worker | null = null;
/** Worker-less runtimes build on this thread with the same builder. */
let cutoutLocalBuilder: CutoutStencilBuilder | null = null;
/** Cutout 3D's last stencil build, for the survey script. */
let cutoutStats: {
  footprints: number; texelM: number; n: number; dilateM: number; fallback: boolean;
  packMs?: number; buildMs?: number; uploadQueuedMs?: number; gapCells?: number; baseRebuilt?: boolean; roofCap?: boolean; uploadMB?: number;
  requests?: number; uploads?: number; unchanged?: number; digestSkips?: number; inputSkips?: number;
  segments?: number; traceMs?: number; wallsMs?: number; wallBuilds?: number;
  dropped?: number; droppedByField?: number; grown?: number; grownTruncated?: number; skirted?: number; rough?: number;
} | null = null;
let cutoutUploads = 0;
/** Each stencil that landed: when (performance.now), its main-thread ms, its segment count. */
const cutoutLandings: { at: number; ms: number; segments: number }[] = [];
(window as any).__cutoutLandings = () => cutoutLandings;
let cutoutUnchanged = 0;
let cutoutDigestSkips = 0;
let cutoutInputSkips = 0;
/** Bumped when a height chunk flips a kept or rough bit (or the field restarts): the footprints re-raster on it. */
let cutoutKeepVersion = 0;
/** cutoutInputDigest of the last job posted; cleared on a failure or a new tileset */
let cutoutLastInputDigest: string | null = null;
const cutoutRebuild = new CoalescedRebuild(runCutoutBuild, CUTOUT_REBUILD_MS);

/**
 * Cutout 3D's stencil: Overture at 1 m union the classifier's gap cells,
 * rebuilt when either input moves (the footprints land, a collider pass
 * rewrites the classifier grid), coalesced to one build per
 * CUTOUT_REBUILD_MS and one in flight, never per frame. Centred on the
 * tileset origin, so a car move never rebuilds it. Until it lands, and when
 * Overture has nothing here, cutout reads the structure mask.
 */
function rebuildCutoutMask(): void {
  if (!clutterFilter || !tiles || !cutoutDirty) return;
  cutoutRebuild.request();
}

/** The stencil job in flight, if any: the worker's one onmessage routes its result here. */
let cutoutFinish: ((r: FootprintMaskResult) => void) | null = null;

function ensureCutoutWorker(): Worker {
  if (!cutoutWorker) {
    cutoutWorker = new Worker(new URL('./services/overture/footprintMaskWorker.ts', import.meta.url), { type: 'module' });
    cutoutWorker.onmessage = (e: MessageEvent<FootprintMaskResult | HeightReply>) => {
      const d = e.data;
      if (d.kind !== undefined) onHeightReply(d);
      else if (d.id === cutoutJobId) cutoutFinish?.(d);
    };
  }
  return cutoutWorker;
}

function runCutoutBuild(): void {
  const filter = clutterFilter, ts = tiles;
  if (!filter || !ts || !traits(viewMode).cutsToFootprints) {
    cutoutRebuild.done();
    return;
  }
  cutoutDirty = false;
  const polys = ts.footprints;
  if (!polys || polys.length === 0) {
    if (filter.hasFootprintMask) filter.setFootprintMask(null);
    cutoutMaskFor = null;
    // the structure-mask fallback pairs with the classifier boxes it was drawn from
    cutoutWalls.clear();
    refreshCarColliders();
    cutoutStats = { footprints: 0, texelM: CUTOUT_TEXEL_M, n: 0, dilateM: CUTOUT_DILATE_M, fallback: true, roofCap: false };
    cutoutRebuild.done();
    return;
  }
  const grid = { ...ts.activeGrid };
  // copies, transferred: the worker reads the grid as of this collider pass
  const classifier = {
    structure: ts.structureGrid.slice(), grid, reachM: CUTOUT_GAP_REACH_M,
    // the roof tops decide which footprints the mesh rises over, capped or not
    top: ts.activeTopGrid.slice(),
    // the lowest surfaces decide which gap cells are roofed over
    lowRise: ts.activeLowRiseGrid.slice(),
    roofMinM: CUTOUT_ROOF_MIN_M * world.terrainProvider.reliefBoost
  };
  const t0 = performance.now();
  let packed: PackedFootprints | undefined;
  let roof: RoofInput | undefined;
  if (cutoutBuilderFor !== polys) {
    packed = packFootprints(polys);
    roof = roofInput(polys);
    cutoutBuilderFor = polys;
    cutoutSetId++;
  }
  const packMs = performance.now() - t0;
  // the same footprint set, cells and roof tops as the last posted job: the build would match it
  const maskOpts = cutoutMaskOpts();
  const inputDigest = cutoutInputDigest(cutoutSetId, maskOpts, classifier, cutoutKeepVersion);
  if (!packed && inputDigest === cutoutLastInputDigest && cutoutMaskFor === polys) {
    cutoutInputSkips++;
    if (cutoutStats) cutoutStats.inputSkips = cutoutInputSkips;
    cutoutRebuild.done();
    return;
  }
  cutoutLastInputDigest = inputDigest;
  const job: FootprintMaskJob = {
    id: ++cutoutJobId, setId: cutoutSetId, packed, roof, opts: maskOpts, classifier, keepVersion: cutoutKeepVersion
  };
  const finish = (r: FootprintMaskResult): void => {
    const tf = performance.now();
    cutoutRebuild.done();
    if (r.error !== undefined) {
      log.warn('cutout stencil build failed', r.error);
      cutoutBuilderFor = null;
      cutoutLastInputDigest = null;
      cutoutDirty = true;
      return;
    }
    if (clutterFilter !== filter || tiles !== ts || ts.footprints !== polys) return;
    const b = r.build;
    cutoutCoverageStat = b.coverage ? { footprints: polys.length, gapCells: b.gapCells, ...b.coverage } : null;
    if (!b.changed) {
      cutoutUnchanged++;
      if (cutoutStats) cutoutStats.unchanged = cutoutUnchanged;
      logCutoutCoverage();
      return;
    }
    const t1 = performance.now();
    // a stencil byte-identical to the one on the GPU: drop it, the texture is untouched
    if (!filter.setFootprintMask(b.mask, b.digest)) {
      cutoutDigestSkips++;
      cutoutMaskFor = polys;
      if (cutoutStats) cutoutStats.digestSkips = cutoutDigestSkips;
      logCutoutCoverage();
      return;
    }
    cutoutMaskFor = polys;
    cutoutLastMask = b.mask;
    cutoutUploads++;
    // the car's walls come from this same stencil, rebuilt only because it changed
    const t2 = performance.now();
    const hf = world.terrainProvider.heightfield;
    const wallsRebuilt = cutoutWalls.land(b.digest, b.segments, (x, z) => hf.sample(x, z));
    const wallsMs = performance.now() - t2;
    cutoutStats = {
      footprints: polys.length, texelM: b.mask.cell, n: b.mask.n, dilateM: CUTOUT_DILATE_M, fallback: false,
      packMs, buildMs: r.buildMs, uploadQueuedMs: performance.now() - t1, gapCells: b.gapCells, baseRebuilt: b.baseRebuilt,
      dropped: b.dropped, droppedByField: b.droppedByField, grown: b.grown, grownTruncated: b.grownTruncated, skirted: b.skirted, rough: b.rough,
      roofCap: b.mask.channels === 2, uploadMB: Math.round(b.mask.data.length / 1e4) / 100,
      requests: cutoutRebuild.starts, uploads: cutoutUploads, unchanged: cutoutUnchanged,
      digestSkips: cutoutDigestSkips, inputSkips: cutoutInputSkips,
      segments: b.segments.length / SEG_STRIDE, traceMs: b.traceMs, wallsMs, wallBuilds: cutoutWalls.builds
    };
    log.info('cutout stencil built', cutoutStats);
    if (cutoutDebug) {
      console.info(`[cutoutDebug] stencil landed: ${polys.length} footprints, ${b.dropped} dropped for no rise (${b.droppedByField} by the height field), `
        + `${b.grown} texels grown (${b.grownTruncated} past the bound), ${b.skirted} skirted, ${b.rough} rough, `
        + `${b.gapCells} gap cells (${b.unroofedCells} unroofed dropped), ${b.segments.length / SEG_STRIDE} segments; skips: ${cutoutDigestSkips} digest, `
        + `${cutoutInputSkips} input, ${cutoutUnchanged} unchanged`);
    }
    if (wallsRebuilt) refreshCarColliders();
    // every landing's main-thread cost (upload queue, walls, physics hand-over), for the perf survey
    cutoutLandings.push({ at: tf, ms: performance.now() - tf, segments: b.segments.length / SEG_STRIDE });
    logCutoutCoverage();
  };
  if (typeof Worker === 'undefined') {
    cutoutLocalBuilder ??= new CutoutStencilBuilder();
    const t1 = performance.now();
    try {
      finish({ id: job.id, build: cutoutLocalBuilder.build(job), buildMs: performance.now() - t1 });
    } catch (e) {
      finish({ id: job.id, error: String(e) });
    }
    return;
  }
  ensureCutoutWorker();
  cutoutFinish = finish;
  ensureCutoutWorker().onerror = e => finish({ id: job.id, error: e.message });
  const transfer: Transferable[] = [classifier.structure.buffer];
  if (classifier.top) transfer.push(classifier.top.buffer);
  transfer.push(classifier.lowRise.buffer);
  if (packed) transfer.push(packed.coords.buffer, packed.ringStarts.buffer, packed.polyRings.buffer);
  if (roof) transfer.push(roof.base.buffer, roof.overtureTop.buffer);
  ensureCutoutWorker().postMessage(job, transfer);
}

/**
 * Per footprint, what its roof cap is measured from: the prism's own
 * ground (the lowest ring-vertex sample, so the cap agrees with the wall
 * the car hits and never tightens on the downhill side) and Overture's
 * roof as the prism places it. The photogrammetry roof joins in the worker,
 * from the classifier's tops as they stream in.
 */
function roofInput(polys: readonly Footprint[]): RoofInput {
  // the tiles' own ground, not the live game's: the footprints land and the first stencil builds
  // before the match starts, while `world` is still the lobby's desert, and a base sampled off a
  // dune dropped 6022 of 6101 downtown Portland footprints for "no rise" (the square's invisible
  // walls, 2026-10-08: the buildings came back as classifier gap cells and the plaza rode along)
  const tp = cutoutTerrain ?? world.terrainProvider;
  const hf = tp.heightfield;
  const base = new Float32Array(polys.length), overtureTop = new Float32Array(polys.length);
  polys.forEach((p, k) => {
    const fg = footprintGround(p, hf);
    base[k] = fg ? fg.gMin : 0;
    overtureTop[k] = fg && p.height != null ? fg.ground + p.minHeight + p.height : NaN;
  });
  const boost = tp.reliefBoost;
  return { base, overtureTop, marginM: CUTOUT_ROOF_MARGIN_M * boost, minRiseM: CUTOUT_MIN_RISE_M * boost };
}

/**
 * How many classifier buildings have no Overture footprint within 3 m (the
 * gap the stencil fills from the classifier). From the last stencil build,
 * never builds one: null until then.
 */
function cutoutCoverage(): (CoverageGap & { footprints: number; gapCells: number }) | null {
  return tiles?.footprints && cutoutMaskFor === tiles.footprints ? cutoutCoverageStat : null;
}
(window as any).__cutoutCoverage = () => cutoutCoverage();
(window as any).__cutoutStats = () => ({ ...(cutoutStats ?? {}), heights: heightStats() });
/** The last uploaded stencil at world (x, z): inside flag and the roof cap byte (debug). */
(window as any).__cutoutMaskAt = (x: number, z: number): { inside: boolean; cap: number } | null => {
  const m = cutoutLastMask;
  if (!m) return null;
  const i = Math.floor((x - m.cx + m.size / 2) / m.cell), j = Math.floor((z - m.cz + m.size / 2) / m.cell);
  if (i < 0 || j < 0 || i >= m.n || j >= m.n) return null;
  const at = (j * m.n + i) * m.channels;
  return { inside: m.data[at]! !== 0, cap: m.channels === 2 ? m.data[at + 1]! : -1 };
};

/**
 * Cutout height field (docs/plans/2026-10-08-cutout-per-texel-heights.md): the capture renders the loaded tiles
 * top-down in 900 m chunks while the view cuts to footprints and posts each to the cutout worker, which keeps
 * the byte field and reads it in every stencil build (drop, cap, fill, growth, gap cells). A chunk that flips a
 * kept or rough bit bumps `cutoutKeepVersion` and asks for a rebuild, on the usual CUTOUT_REBUILD_MS cadence.
 */
let heightCapture: HeightCapture | null = null;
/** The terrain the worker's field was last seeded from; a new tileset sends it again and starts a fresh field. */
let heightsTerrainSent: TerrainProvider | null = null;
/** The ground was refined in place: the worker needs the new terrain, but keeps its field. */
let heightsTerrainRefined = false;
/** Chunks owed a re-measure after a refinement; drained, they bump the keep version once (roof caps read the new ground). */
const remeasure = new RemeasureTracker();
/** Times the set drained (live check: `requests` in the stencil stats only moves when a mask lands, this moves at once). */
let remeasureDrains = 0;
/** The last owed chunk is re-measured, or gave up: roof caps read the new ground, so rebuild once. */
function bumpRemeasured(): void {
  remeasureDrains++;
  cutoutKeepVersion++;
  cutoutRebuild.request();
}
const heightChunkStats = new Map<number, { known: number; kept: number; rough: number; changed: number }>();
const heightAtPending = new Map<number, (r: { rise: number; state: HeightState; chunk: number; rough: boolean }) => void>();
let heightAtReq = 0;

function heightStats(): { remeasurePending: number; remeasureDrains: number; rebuildStarts: number; chunks: number; captured: number; renderMs: number; readbackMs: number; known: number; kept: number; rough: number } {
  let known = 0, kept = 0, rough = 0;
  for (const c of heightChunkStats.values()) {
    known += c.known;
    kept += c.kept;
    rough += c.rough;
  }
  const t = heightCapture?.timings;
  return { remeasurePending: remeasure.pendingCount, remeasureDrains, rebuildStarts: cutoutRebuild.starts, chunks: heightChunkStats.size, captured: t?.captured ?? 0, renderMs: t?.renderMs ?? 0, readbackMs: t?.readbackMs ?? 0, known, kept, rough };
}

function onHeightReply(r: HeightReply): void {
  if (r.kind === 'heightsError') {
    log.warn('cutout height field message failed', r.message);
    // a failed chunk is still answered: without this its outstanding count never clears and the set never drains
    if (r.chunk !== undefined && remeasure.applied(r.chunk)) bumpRemeasured();
    return;
  }
  if (r.kind === 'heightsApplied') {
    heightChunkStats.set(r.chunk, { known: r.known, kept: r.kept, rough: r.rough, changed: r.changed });
    // the last re-measure after a refinement also rebuilds, whether or not it flipped a bit: caps baked while a
    // chunk still read the old ground are only corrected by a rebuild
    const drained = remeasure.applied(r.chunk);
    if (drained) bumpRemeasured();
    else if (r.changed > 0) {
      cutoutKeepVersion++;
      cutoutRebuild.request();
    }
    return;
  }
  heightAtPending.get(r.req)?.(r);
  heightAtPending.delete(r.req);
}

/** Per frame: advance the height capture while the view cuts to footprints. */
function updateHeights(nowMs: number): void {
  const ts = tiles, tp = cutoutTerrain;
  const active = !!ts && !!tp && typeof Worker !== 'undefined' && traits(viewMode).cutsToFootprints;
  if (!active || !ts || !tp) return;
  const worker = ensureCutoutWorker();
  if (heightsTerrainSent !== tp) {
    const hf = tp.heightfield;
    const terrain = { size: hf.size, segs: hf.segs, data: hf.raw.slice() };
    worker.postMessage({ kind: 'terrain', terrain } satisfies HeightMessage, [terrain.data.buffer]);
    heightsTerrainSent = tp;
    heightsTerrainRefined = false;
    remeasure.reset();
    heightChunkStats.clear();
    heightCapture?.reset();
    // the worker's field starts over, all unknown: the stencil must stop using the old one
    cutoutKeepVersion++;
    cutoutRebuild.request();
  } else if (heightsTerrainRefined) {
    // same tileset, refined ground: swap the baseline and re-measure, but keep what is known (no version bump, so
    // the stencil keeps its rule; a chunk that really flips a bit bumps it as usual)
    const hf = tp.heightfield;
    const terrain = { size: hf.size, segs: hf.segs, data: hf.raw.slice() };
    worker.postMessage({ kind: 'terrainUpdate', terrain } satisfies HeightMessage, [terrain.data.buffer]);
    heightsTerrainRefined = false;
    // the worker now holds the new ground: a chunk posted from here on is measured against it, one posted before was not
    remeasure.begin();
    heightCapture?.reset();
  }
  heightCapture ??= new HeightCapture(
    renderer.renderer, () => tiles, () => (cutoutTerrain ?? world.terrainProvider).heightfield,
    (chunk, data) => {
      if (!cutoutWorker || heightsTerrainSent !== cutoutTerrain) return;
      remeasure.posted(chunk);
      const boost = (cutoutTerrain ?? world.terrainProvider).reliefBoost;
      cutoutWorker.postMessage({ kind: 'heights', chunk, data, keepRiseM: CUTOUT_MIN_RISE_M * boost } satisfies HeightMessage, [data.buffer]);
    },
    // a chunk that lost its fine tiles will not be captured: stop waiting for it
    chunk => { if (remeasure.skipped(chunk)) bumpRemeasured(); }
  );
  heightCapture.update(nowMs, true);
}

/** Debug: the height field at world (x, z), asked of the worker that holds it (a round trip, not a mirror). */
(window as any).__cutoutHeightAt = (x: number, z: number): Promise<{ rise: number; state: HeightState; chunk: number; rough: boolean }> =>
  new Promise(resolve => {
    if (!cutoutWorker) return resolve({ rise: NaN, state: 'never', chunk: -1, rough: false });
    const req = ++heightAtReq;
    heightAtPending.set(req, resolve);
    cutoutWorker.postMessage({ kind: 'heightAt', req, x, z } satisfies HeightMessage);
  });

/**
 * Once per tileset load, after the footprints have had time to meet a
 * streamed-in neighbourhood: the size of the Overture gap the classifier
 * cells fill in Cutout 3D.
 */
function logCutoutCoverage(): void {
  if (cutoutCoverageLogged || performance.now() - footprintsLandedAt < 10000) return;
  const c = cutoutCoverage();
  if (!c) return;
  cutoutCoverageLogged = true;
  log.info('cutout coverage', c);
}

/**
 * What the cars hit. Cutout 3D: the walls traced from the stencil on screen
 * (plus the props), so every drawn building is solid and nothing undrawn
 * is; until a stencil lands, the classifier boxes, which the structure-mask
 * fallback is drawn from. A prism mode: the outline walls (plus the props).
 * Elsewhere the boxes. The bots and the blocked-ground checks always get
 * the boxes (the second argument to setBuildingColliders).
 */
function carColliders(colliders: readonly BuildingCollider[], nTileBoxes: number): BuildingCollider[] {
  const cutout = traits(viewMode).cutsToFootprints;
  const walls = cutout ? cutoutWalls.walls : null;
  carOnStencil = walls !== null;
  carInCutout = cutout;
  if (walls) return [...walls, ...colliders.slice(nTileBoxes)];
  // before the stencil lands, Cutout 3D's boxes pass the same roofed-over rule as its gap cells
  if (cutout) return [...cutoutFallbackBoxes(colliders.slice(0, nTileBoxes)), ...colliders.slice(nTileBoxes)];
  if (!physicsOnWalls) return colliders as BuildingCollider[];
  return [...wallColliders(prismView.walls), ...colliders.slice(nTileBoxes)];
}

/** The classifier boxes Cutout 3D's cars hit before its stencil lands: the roofed-over ones. */
function cutoutFallbackBoxes(tileBoxes: readonly BuildingCollider[]): BuildingCollider[] {
  return fallbackCarBoxes(true, tileBoxes, tiles?.activeLowRiseGrid ?? null, tiles?.activeGrid ?? null,
    CUTOUT_ROOF_MIN_M * world.terrainProvider.reliefBoost);
}

/** Hand the physics the cars' colliders again (a stencil landed, the view changed); the boxes stay as they are. */
function refreshCarColliders(): void {
  game.setBuildingColliders(carColliders(lastColliders, lastTileBoxes.length), [...lastColliders]);
  if (cutoutDebug) updateCutoutDebug();
}

/**
 * The debug fence over what the car hits in Cutout 3D: the stencil's walls
 * (Overture cyan, classifier-gap magenta) once one has landed, the
 * classifier boxes (yellow) before. Nothing is built while debug is off.
 */
function updateCutoutDebug(): void {
  if (!cutoutDebug || !traits(viewMode).cutsToFootprints) {
    cutoutDebugOverlay?.clear();
    return;
  }
  if (!cutoutDebugOverlay) {
    cutoutDebugOverlay = new CutoutDebugOverlay();
    renderer.scene.add(cutoutDebugOverlay.group);
  }
  const hf = world.terrainProvider.heightfield;
  const groundAt = (x: number, z: number) => hf.sample(x, z);
  if (cutoutWalls.segments) cutoutDebugOverlay.set(cutoutWalls.segments, null, groundAt);
  else cutoutDebugOverlay.set(null, cutoutFallbackBoxes(lastTileBoxes), groundAt);
}
(window as any).__cutoutDebug = (on?: boolean) => {
  if (on !== undefined) cutoutDebug = on;
  updateCutoutDebug();
  return cutoutDebug;
};

/** Vector City streets: the OSM ways draped on the ground the car drives on. */
function rebuildRibbons(): void {
  const polys = tiles?.roadPolylines;
  if (!polys) return;
  const hf = world.terrainProvider.heightfield;
  roadRibbons.build(polys, (x, z) => hf.sample(x, z));
}

function applyTileColliders(tileBoxes: readonly BuildingCollider[]): void {
  colliderGeneration++;
  lastTileBoxes = tileBoxes;
  const rawColliders = [...tileBoxes, ...propScatter.colliders];
  const sample = (x: number, z: number) => world.terrainProvider.heightfield.sample(x, z);
  const colliders = rawColliders.map(b => anchorCollider(b, sample));
  clutterFilter?.maskChanged();
  if (clutterFilter && tiles) clutterFilter.setSnapBoxes(colliders, tiles.activeGrid, tiles.roadMask);
  const prismsRebuilt = traits(viewMode).prismPhysics && rebuildPrisms();
  physicsOnWalls = traits(viewMode).prismPhysics && prismView.count > 0;
  // a prism mode draws the exact outline, so the cars hit the outline (plus the props);
  // the classifier's boxes stay behind it for the bots' routes and the blocked-ground checks
  // (Cutout 3D: the walls traced from its stencil instead, once one has landed)
  game.setBuildingColliders(carColliders(colliders, tileBoxes.length), colliders);
  buildingMeshView.update(colliders, tiles?.activeDeckGrid, tiles?.activeGrid, sample);
  lastColliders = colliders;
  // before a stencil lands the fence shows the boxes, which just changed
  if (cutoutDebug && !cutoutWalls.segments) updateCutoutDebug();
  // the classifier grid moved: Cutout 3D's gap cells follow, coalesced
  cutoutDirty = true;
  if (traits(viewMode).cutsToFootprints) rebuildCutoutMask();
  if (traits(viewMode).paintsBoxes) {
    facadeBaker.setColliders(colliders);
  } else if (viewMode === 'footprint-3d' && prismsRebuilt) {
    facadeBaker.setWalls(prismView.walls);
  }
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
  prismView.clear();
  roadRibbons.clear();
  prismsFor = null;
  cutoutMaskFor = null;
  cutoutWalls.clear();
  cutoutDebugOverlay?.clear();
  cutoutCoverageStat = null;
  cutoutBuilderFor = null;
  cutoutTerrain = null;
  heightCapture?.reset();
  heightsTerrainSent = null;
  remeasure.reset();
  heightChunkStats.clear();
  cutoutDirty = true;
  cutoutUploads = 0;
  cutoutUnchanged = 0;
  cutoutRebuild.reset();
  cutoutLastInputDigest = null;
  cutoutDigestSkips = 0;
  cutoutInputSkips = 0;
  cutoutCoverageLogged = false;
  footprintsLandedAt = Infinity;
  game.setSurfaceProvider(undefined);
  deactivateSurface();
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
  renderer.setLightRig(traits(viewMode).showsTiles && terrain.isReal ? 'photo' : 'arcade');
  renderer.scene.add(mesh);
  minimapEl.setTerrain(terrain.heightfield, config.world.mapHalf);
}

/** New terrain or rematch: props, colliders, then spawn everything clear of them. */
function startMatch(terrain: TerrainProvider): void {
  prepareTerrain(terrain);
  game.setSurfaceProvider(tiles ? (x, z, cy, gy) => tiles!.surfaceElevation(x, z, cy, gy) : undefined);
  game.reset(terrain);
  applySurface();
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
      surface: (x, z, cy, gy) => tiles ? tiles.surfaceElevation(x, z, cy, gy) : null,
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
            tiles.group.visible = traits(viewMode).showsTiles;
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
        applySurface();
        return game;
      },
      onMatch: (match, terrain) => {
        online?.dispose();
        online = match;
        world = match.world;
        // a client has no game of its own: seat the same rocks from the same seed
        if (match.world !== game) prepareTerrain(terrain, mulberry32(match.seed));
        applySurface();
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
      tiles.group.visible = traits(viewMode).showsTiles;
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
  <span id="diag-surface" style="font-weight:600;color:#c4b5fd;display:none;"></span>
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
const diagSurfaceEl = diagEl.querySelector('#diag-surface') as HTMLElement | null;
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
let currentResolution3D: Resolution3DMode = loadResolution3D(urlParams?.get('res3d') ?? null);

function applyResolutionProfile(mode: Resolution3DMode): void {
  currentResolution3D = mode;
  saveResolution3D(mode);
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

function step(now: number): void {
  const rawDt = (now - last) / 1000;
  last = now;

  // When tab is hidden or backgrounded, skip simulation and avoid corrupting adaptive resolution
  if (typeof document !== 'undefined' && document.hidden) return;

  profiler.begin();
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
    if (diagSurfaceEl) {
      const on = surfaceActive && surfaceField !== null && surfaceCapture !== null;
      diagSurfaceEl.style.display = on ? 'inline' : 'none';
      if (on) {
        const t = surfaceCapture!.timings;
        diagSurfaceEl.textContent = `Surface: ${surfaceField!.sample(b.pos.x, b.pos.z).toFixed(2)}m (Δ ${surfaceField!.deltaAt(b.pos.x, b.pos.z).toFixed(2)}) cap ${t.renderMs.toFixed(1)}/${t.readbackMs.toFixed(0)}/${t.processMs.toFixed(1)}ms ×${t.captures}`;
      }
    }
  }

  // F8 corner view of the captured surface, redrawn at 10 Hz (the field itself only changes per capture)
  if (showDiagnostic && surfaceActive && surfaceField && world.player?.body && now - surfacePreviewAt > 100) {
    surfacePreviewAt = now;
    surfacePreview ??= new SurfacePreview();
    surfacePreview.visible = true;
    surfacePreview.draw(surfaceField, world.player.body.pos.x, world.player.body.pos.z);
  } else if (surfacePreview && (!showDiagnostic || !surfaceActive)) {
    surfacePreview.visible = false;
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
    if (hot === 'surfaceMode') toggleSurfaceMode();
  }
  const playing = !introEl.isConnected && endEl.hidden;
  if (playing) {
    const drive = input.vehicleInput();
    // the sessions get real elapsed time: Game clamps its own step, and a
    // client's playback clock must not run slow just because frames are
    if (online) online.tick(rawDt, drive);
    else game.update(dt, drive);
    simTime += dt;
    profiler.lap('sim');
    const player = world.player?.body ?? null;
    if (surfaceActive && surfaceCapture && tiles && player) {
      // read before the collider refresh below clears it: new tiles mean a new surface
      if (tiles.collidersDirty) surfaceCapture.markDirty();
      surfaceCapture.update(now, player.pos.x, player.pos.z);
      // its own lap, so a slow-frame line names the capture rather than 'world'
      profiler.lap('surface');
    }
    updateHeights(now);
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
        // only the world being played: on a guest, `game` is the idle
        // single-player world on another terrain, and copying into it threw
        // every frame, which stopped every draw after the ground refined
        world.terrainProvider.heightfield.copyFrom(refined);
        terrainMesh.refresh(world.terrainProvider.heightfield);
        clutterFilter?.groundChanged(world.terrainProvider.heightfield);
        buildingMeshView.refreshHeights((x, z) => world.terrainProvider.heightfield.sample(x, z));
        // the rebuilt box mesh starts with no rectangles: without this every photo vanished until the next tile load
        if (traits(viewMode).paintsBoxes) facadeBaker.replay();
        roadRibbons.refreshHeights((x, z) => world.terrainProvider.heightfield.sample(x, z));
        if (groundStreamer) groundStreamer.refresh();
        surfaceCapture?.markDirty();
        // the worker's terrain is a copy of the ground just overwritten: send it again and re-measure
        heightsTerrainRefined = true;
        // the walls were baked against the old ground and no stencil bit flips for a refinement: stand them on the new
        {
          const hf = world.terrainProvider.heightfield;
          if (cutoutWalls.reground((x, z) => hf.sample(x, z))) refreshCarColliders();
        }
        groundBuilder = null;
      }
    }
    if (groundStreamer && player) {
      groundStreamer.update(player.pos, now);
    }
    profiler.lap('world');
    for (const v of vehicleViews) v.sync(dt, world.alpha);
    // each carried crate rides its carrier's interpolated pose, not the body,
    // so it does not judder a frame behind the car it is strapped to
    pickups.sync(world.state, simTime, dt, body => vehicleViews.find(v => v.actor.body === body)?.pose ?? null);
    cameraRig.update(dt, vehicleViews.find(v => v.actor.isPlayer)?.pose ?? null);
    const nav = world.navMarker();
    if (nav) dirArrowEl.setNav(nav.yaw, nav.distance);
    minimapEl.draw(world.state, world.vehicles, world.player, nav?.target ?? null);
    audio.update(dt, world, drive, world.state, true);
    profiler.lap('scene');
  } else {
    audio.update(dt, null, null, null, false);
    if (introEl.isConnected) {
      showroom.update(dt, window.innerWidth, window.innerHeight);
      if (tiles) tiles.update(renderer.camera.position, now);
      if (groundStreamer) groundStreamer.update(renderer.camera.position, now);
    }
  }
  if (traits(viewMode).paintsWalls) facadeBaker.update(renderer.camera.position, now);
  profiler.lap('facades');
  renderer.render();
  profiler.lap('render');
  profiler.end(rawDt * 1000);
}
/** Messages already logged, so a frame that throws every time logs once. */
const frameErrors = new Set<string>();
// one throwing frame must not end the loop: before this, a single error froze
// the world for good while the HTML overlays kept running
function frame(now: number): void {
  try {
    step(now);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!frameErrors.has(msg)) {
      frameErrors.add(msg);
      log.error('frame failed', errorData(e));
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
