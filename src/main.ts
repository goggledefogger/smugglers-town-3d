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
import { VehicleView } from './render/VehicleView.ts';
import { PropScatter } from './render/PropScatter.ts';
import { Pickups } from './render/Pickups.ts';
import { CameraRig } from './render/CameraRig.ts';

import { Showroom } from './render/Showroom.ts';
import { setVehicleEnvMap } from './render/vehicleMeshes.ts';
import { PMREMGenerator } from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Heightfield } from './core/heightfield.ts';
import { generateDesertHeightfieldData, createDesertTerrain } from './core/terrain/ProceduralTerrain.ts';
import type { TerrainProvider } from './core/terrain/TerrainProvider.ts';
import { InputManager } from './input/InputManager.ts';
import type { UiAction } from './input/types.ts';
import { logger } from './app/log.ts';
import { PROTOCOL_VERSION } from './net/protocol.ts';
import { relocate, relocateTo } from './services/relocate.ts';
import type { TileStreamer } from './services/tiles/Tileset.ts';
import { GroundStreamer } from './services/maps/GroundStreamer.ts';
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

const log = logger('app');
const app = document.getElementById('app')!;

// ---- DOM shell ----
app.innerHTML = `
  <canvas id="c"></canvas>
  <div id="hud">
    <div class="hud-corner hud-tl"><sr-health></sr-health></div>
    <div class="hud-corner hud-tr"><sr-score></sr-score></div>
    <div class="hud-corner hud-bl"><sr-objective></sr-objective></div>
    <div class="hud-corner hud-br"><sr-speed></sr-speed><sr-minimap></sr-minimap></div>
    <sr-dirarrow id="dirarrow"></sr-dirarrow>
    <sr-banner id="banner"></sr-banner>
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

// ---- stores, events, game ----
const events = new EventBus<GameEventMap>();
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
/** What the renderer draws: the local game, or a mirrored world while online. */
let world: WorldView = game;
let online: RunningMatch | null = null;
let onlineFlow: OnlineFlow | null = null;

// ---- renderer + views ----
const renderer = new GameRenderer({ canvas });
// studio reflections for car paint, glass and chrome only (scene lighting is untouched)
{
  const pmrem = new PMREMGenerator(renderer.renderer);
  setVehicleEnvMap(pmrem.fromScene(new RoomEnvironment(), 0.04).texture);
  pmrem.dispose();
}
const terrainMesh = new TerrainMesh();
renderer.scene.add(terrainMesh.build(desertTerrain, renderer.maxAnisotropy));
const propScatter = new PropScatter(renderer.scene);
const pickups = new Pickups(renderer.scene);
const cameraRig = new CameraRig(
  renderer.camera, () => world.terrainProvider.heightfield, (a, b) => world.lineOfSight(a, b)
);
const minimapEl = document.querySelector('sr-minimap') as Minimap;
const showroom = new Showroom(renderer.scene, renderer.camera, () => world.terrainProvider.heightfield);
const vehicleViews: VehicleView[] = [];
let tiles: TileStreamer | null = null;
let groundStreamer: GroundStreamer | null = null;
let colliderRefreshAt = 0;
let groundRefreshAt = 0;
let groundDirty = false;

/** Buildings from the streamed tiles plus the scattered props. */
function applyColliders(): void {
  game.setBuildingColliders([...(tiles?.colliders() ?? []), ...propScatter.colliders]);
}

function rebuildViews(): void {
  for (const v of vehicleViews) {
    renderer.scene.remove(v.group);
    v.dispose();
  }
  vehicleViews.length = 0;
  for (const actor of world.vehicles) {
    const view = new VehicleView(actor, () => world.terrainProvider.heightfield);
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
  if (groundStreamer) {
    renderer.scene.remove(groundStreamer.group);
    groundStreamer.dispose();
    groundStreamer = null;
  }
  if (!tiles) return;
  renderer.scene.remove(tiles.group);
  tiles.dispose();
  tiles = null;
}

function swapTerrainMesh(terrain: TerrainProvider): void {
  const old = terrainMesh.mesh;
  if (old) renderer.scene.remove(old);
  renderer.scene.add(terrainMesh.build(terrain, renderer.maxAnisotropy));
  minimapEl.setTerrain(terrain.heightfield, config.world.mapHalf);
}

/** New terrain or rematch: props, colliders, then spawn everything clear of them. */
function startMatch(terrain: TerrainProvider): void {
  prepareTerrain(terrain);
  game.reset(terrain);
  rebuildViews();
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
relocateBarEl.hidden = false;
pickups.setVisible(false);

// ---- input ----
// One InputManager owns the keyboard and gamepad sources and merges them.
// Driving input is polled each frame; UI actions and hotkeys are edge-triggered
// and drained into whatever screen is active (or the gameplay hotkeys).
const input = new InputManager();

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
events.on('match:countdown', ({ n }) => bannerEl.show(n > 0 ? String(n) : 'GO!', n > 0 ? 900 : 700));
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
  pickups.setVisible(true);
};

introEl.onOnline = (type) => {
  void openOnline(type);
};

// controls/rebind screen: opened from the garage, owns UI actions while open
settingsEl.inputManager = input;
introEl.onControls = () => {
  settingsEl.hidden = false;
  uiHandler = (a) => settingsEl.handleUiAction(a);
};
settingsEl.addEventListener('settings-close', () => {
  uiHandler = (a) => introEl.handleUiAction(a);
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
        loaderEl.hidden = false;
        try {
          const { terrain: loaded, tiles: newTiles, groundStreamer: newGround } = await relocateTo(
            map, apiKey, msg => { loaderEl.message = msg; }, renderer.maxAnisotropy
          );
          clearTiles();
          tiles = newTiles;
          groundStreamer = newGround ?? null;
          if (groundStreamer) renderer.scene.add(groundStreamer.group);
          if (tiles) renderer.scene.add(tiles.group);
          // one ground for everything, cut from the tiles — same as single player
          return tiles ? { ...loaded, heightfield: tiles.groundHeightfield() } : loaded;
        } finally {
          loaderEl.hidden = true;
        }
      },
      makeHostGame: (seed, terrain, seats) => {
        game = new Game(terrain, { events, store, seed });
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
    if (groundStreamer) renderer.scene.add(groundStreamer.group);
    if (tiles) renderer.scene.add(tiles.group);
    swapTerrainMesh(terrain);
    startMatch(terrain);
    events.emit('location:changed', { label: terrain.label, isReal: terrain.isReal });
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

// ---- frame loop ----
let last = performance.now();
let simTime = 0;

function frame(now: number): void {
  const rawDt = (now - last) / 1000;
  const dt = Math.min(rawDt, config.loop.maxFrameDt);
  last = now;
  renderer.adapt(rawDt, now);
  // poll every source each frame so gamepad edges fire on menus too — the
  // gamepad has no keydown event, so its edge scan must run even when nothing
  // is driving (vehicleInput is only called while playing, below)
  input.poll();
  // UI actions and hotkeys drain every frame, menus open or not; each screen
  // registers a handler that returns true if it consumed the action
  for (const action of input.drainUiActions()) {
    if (uiHandler) {
      if (uiHandler(action)) continue;
    }
    // unhandled UI action while no screen is open: treat pause/back specially
  }
  for (const hot of input.drainHotkeys()) {
    if (hot === 'camera') cameraRig.cycleMode();
    if (hot === 'reset') resetPlayer();
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
        applyColliders();
        groundDirty = true;
      }
      // ...and sharpen the shared ground, less often: this one costs ~50 ms
      if (groundDirty && now - groundRefreshAt > 6000) {
        groundRefreshAt = now;
        groundDirty = false;
        game.terrainProvider.heightfield.copyFrom(tiles.groundHeightfield());
        terrainMesh.refresh(game.terrainProvider.heightfield);
        groundStreamer?.refresh();
        minimapEl.setTerrain(game.terrainProvider.heightfield, config.world.mapHalf);
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
  } else if (introEl.isConnected) {
    showroom.update(dt, window.innerWidth, window.innerHeight);
    if (tiles) tiles.update(renderer.camera.position, now);
    if (groundStreamer) groundStreamer.update(renderer.camera.position, now);
  }
  renderer.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
