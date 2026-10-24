import { Vector3 } from 'three';
import type { GameRenderer } from '../../render/Renderer.ts';
import type { CameraRig } from '../../render/CameraRig.ts';
import type { TileClutterFilter } from '../../render/TileClutterFilter.ts';
import { SurfacePreview, type SurfaceCapture } from '../../render/SurfaceCapture.ts';
import type { SurfaceHeightfield } from '../../core/terrain/SurfaceHeightfield.ts';
import type { TileStreamer } from '../../services/tiles/Tileset.ts';
import type { GroundStreamer } from '../../services/maps/GroundStreamer.ts';
import type { ColliderExperimentMode } from '../../services/tiles/tileColliders.ts';
import {
  type Resolution3DMode,
  RESOLUTION_3D_MODES,
  getResolutionProfile,
  loadResolution3D,
  saveResolution3D
} from '../../services/tiles/resolutionProfiles.ts';
import { getScenario, findScenarioByCoords, type TestScenario } from '../../core/geo/testScenarios.ts';
import { worldToLl } from '../../core/geo/projection.ts';
import { isTypingInField } from '../controls.ts';
import type { SettingsScreen } from '../screens/SettingsScreen.ts';
import type { RelocateBar } from '../screens/RelocateBar.ts';
import type { WorldView } from '../../app/WorldView.ts';

const UNIT_Y = new Vector3(0, 1, 0);

export const EXPERIMENT_MODES: readonly ColliderExperimentMode[] = [
  'baseline',
  'road_carve',
  'curbside_inset',
  'high_res'
];

export function experimentLabel(mode: ColliderExperimentMode): string {
  switch (mode) {
    case 'baseline': return 'Baseline (10m)';
    case 'road_carve': return 'Road-Carve (OSM)';
    case 'curbside_inset': return 'Curbside-Inset (2.4m)';
    case 'high_res': return 'High-Res 5m Grid';
  }
}

export function experimentDescription(mode: ColliderExperimentMode): string {
  switch (mode) {
    case 'baseline': return '10m grid, 1.0m inset (reproduces road obstruction)';
    case 'road_carve': return 'OSM Overpass reactive rebuild + 0.85 reach clearance corridor';
    case 'curbside_inset': return '2.4m exterior street insetting (100% offline-safe)';
    case 'high_res': return '5m sub-lane grid resolution (fine-grained geometry)';
  }
}

export interface DiagnosticHudDeps {
  readonly urlParams: URLSearchParams | null;
  readonly weakDevice: boolean;
  readonly renderer: GameRenderer;
  readonly settingsEl: SettingsScreen | null;
  readonly relocateBarEl: RelocateBar;
  readonly cameraRig: CameraRig;
  readonly getWorld: () => WorldView;
  readonly getTiles: () => TileStreamer | null;
  readonly getGroundStreamer: () => GroundStreamer | null;
  readonly getClutterFilter: () => TileClutterFilter | null;
  readonly applyColliders: () => void;
  readonly getSurface: () => {
    readonly active: boolean;
    readonly field: SurfaceHeightfield | null;
    readonly capture: SurfaceCapture | null;
  };
}

/**
 * Encapsulates the F8 Live Alignment Diagnostic HUD, F9 Driving Experiment
 * cycler, F10 Resolution Profile cycler, [T] obstacle teleporter, Toast banner,
 * and URL scenario deep-link bootstrap.
 */
export class DiagnosticHud {
  resolutionMode: Resolution3DMode;
  experimentMode: ColliderExperimentMode = 'baseline';
  private showDiagnostic: boolean;
  private readonly diagEl: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private surfacePreview: SurfacePreview | null = null;
  private surfacePreviewAt = 0;

  private readonly diagGpsEl: HTMLElement | null;
  private readonly diagXzEl: HTMLElement | null;
  private readonly diagGroundEl: HTMLElement | null;
  private readonly diagCarEl: HTMLElement | null;
  private readonly diagStatusEl: HTMLElement | null;
  private readonly diagTilesEl: HTMLElement | null;
  private readonly diagOsmEl: HTMLElement | null;
  private readonly diagSurfaceEl: HTMLElement | null;
  private readonly resToggleBtn: HTMLButtonElement | null;
  private readonly expToggleBtn: HTMLButtonElement | null;

  constructor(private readonly deps: DiagnosticHudDeps) {
    const { urlParams, weakDevice, renderer, settingsEl } = deps;
    this.showDiagnostic = !!urlParams && (urlParams.has('debug') || urlParams.has('scenario') || urlParams.has('lat'));
    this.resolutionMode = loadResolution3D(urlParams?.get('res3d') ?? null, weakDevice);

    const expParam = urlParams?.get('colliderExp') as ColliderExperimentMode | null;
    if (expParam && EXPERIMENT_MODES.includes(expParam)) {
      this.experimentMode = expParam;
    }

    this.diagEl = document.createElement('div');
    this.diagEl.id = 'debug-diagnostic';
    this.diagEl.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999;background:rgba(11,15,23,0.92);backdrop-filter:blur(8px);border:1px solid #ff5500;border-radius:8px;padding:8px 16px;font-family:\'JetBrains Mono\',monospace;font-size:11px;color:#f1f5f9;pointer-events:none;display:flex;gap:14px;align-items:center;box-shadow:0 4px 20px rgba(0,0,0,0.6);';
    this.diagEl.style.display = this.showDiagnostic ? 'flex' : 'none';
    this.diagEl.innerHTML = `
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
    document.body.appendChild(this.diagEl);

    this.diagGpsEl = this.diagEl.querySelector('#diag-gps') as HTMLElement | null;
    this.diagXzEl = this.diagEl.querySelector('#diag-xz') as HTMLElement | null;
    this.diagGroundEl = this.diagEl.querySelector('#diag-ground') as HTMLElement | null;
    this.diagCarEl = this.diagEl.querySelector('#diag-car') as HTMLElement | null;
    this.diagStatusEl = this.diagEl.querySelector('#diag-status') as HTMLElement | null;
    this.diagTilesEl = this.diagEl.querySelector('#diag-tiles') as HTMLElement | null;
    this.diagOsmEl = this.diagEl.querySelector('#diag-osm') as HTMLElement | null;
    this.diagSurfaceEl = this.diagEl.querySelector('#diag-surface') as HTMLElement | null;
    this.resToggleBtn = this.diagEl.querySelector('#res-toggle-btn') as HTMLButtonElement | null;
    this.expToggleBtn = this.diagEl.querySelector('#exp-toggle-btn') as HTMLButtonElement | null;

    this.toastEl = document.createElement('div');
    this.toastEl.id = 'exp-toast';
    this.toastEl.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:9999;background:rgba(15,23,42,0.94);backdrop-filter:blur(10px);border:1px solid #38bdf8;border-radius:8px;padding:8px 18px;font-family:\'JetBrains Mono\',monospace;font-size:12px;color:#f1f5f9;box-shadow:0 8px 30px rgba(0,0,0,0.6);transition:opacity 0.3s ease, transform 0.3s ease;pointer-events:none;opacity:0;';
    document.body.appendChild(this.toastEl);

    renderer.setDprCap(getResolutionProfile(this.resolutionMode).dprCap);
    if (settingsEl) {
      settingsEl.resolutionMode = this.resolutionMode;
    }
    if (this.resToggleBtn) {
      this.resToggleBtn.textContent = `RES: ${getResolutionProfile(this.resolutionMode).label} [F10]`;
    }

    window.addEventListener('keydown', this.onKeyDown);
    this.diagEl.addEventListener('click', this.onDiagClick);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'F8') {
      this.showDiagnostic = !this.showDiagnostic;
      this.diagEl.style.display = this.showDiagnostic ? 'flex' : 'none';
    }
    // letter hotkeys are bare keys: any of Cmd/Ctrl/Alt held means the
    // keystroke belongs to the browser (Cmd+R reload, Cmd+Shift+R hard reload),
    // so neither fire the hotkey nor preventDefault it
    const bareKey = !e.metaKey && !e.ctrlKey && !e.altKey;
    if (e.code === 'F9' || (e.code === 'KeyE' && bareKey && !e.repeat && !isTypingInField())) {
      this.cycleExperimentMode();
      e.preventDefault();
    }
    if (e.code === 'F10' || ((e.code === 'KeyV' || e.code === 'KeyR') && e.shiftKey && bareKey && !e.repeat && !isTypingInField())) {
      this.cycleResolutionMode();
      e.preventDefault();
    }
    if (e.code === 'KeyT' && bareKey && !e.repeat && !isTypingInField()) {
      this.teleportToObstacle();
      e.preventDefault();
    }
  };

  private readonly onDiagClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.id === 'res-toggle-btn' || target.closest('#res-toggle-btn')) {
      this.cycleResolutionMode();
    } else if (target.id === 'exp-toggle-btn' || target.closest('#exp-toggle-btn')) {
      this.cycleExperimentMode();
    } else if (target.id === 'exp-teleport-btn' || target.closest('#exp-teleport-btn')) {
      this.teleportToObstacle();
    }
  };

  showToast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.style.opacity = '1';
    this.toastEl.style.transform = 'translateX(-50%) translateY(0)';
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastEl.style.opacity = '0';
      this.toastEl.style.transform = 'translateX(-50%) translateY(8px)';
    }, 3500);
  }

  applyResolutionProfile(mode: Resolution3DMode): void {
    this.resolutionMode = mode;
    saveResolution3D(mode);
    const profile = getResolutionProfile(mode);
    this.deps.renderer.setDprCap(profile.dprCap);
    const tiles = this.deps.getTiles();
    if (tiles) {
      tiles.setResolutionMode(mode);
    }
    const groundStreamer = this.deps.getGroundStreamer();
    if (groundStreamer) {
      groundStreamer.setZoom(profile.satelliteZoom, profile.satelliteMaxPatches, profile.anisotropy);
    }
    if (this.deps.settingsEl) {
      this.deps.settingsEl.resolutionMode = mode;
    }
    if (this.resToggleBtn) {
      this.resToggleBtn.textContent = `RES: ${profile.label} [F10]`;
    }
    this.showToast(`[3D RES: ${profile.label}] ${profile.description}`);
  }

  cycleResolutionMode(): void {
    const idx = RESOLUTION_3D_MODES.indexOf(this.resolutionMode);
    const next = RESOLUTION_3D_MODES[(idx + 1) % RESOLUTION_3D_MODES.length]!;
    this.applyResolutionProfile(next);
  }

  setExperiment(mode: ColliderExperimentMode): void {
    this.experimentMode = mode;
    const tiles = this.deps.getTiles();
    if (tiles) {
      tiles.setExperimentMode(mode);
      const clutterFilter = this.deps.getClutterFilter();
      if (clutterFilter) {
        clutterFilter.updateStructureGrid(tiles.structureGrid, tiles.grid.n);
      }
      this.deps.applyColliders();
    }
    if (this.expToggleBtn) {
      this.expToggleBtn.textContent = `EXP: ${experimentLabel(mode)} [F9]`;
    }
    this.showToast(`[EXP: ${experimentLabel(mode)}] ${experimentDescription(mode)}`);
  }

  cycleExperimentMode(): void {
    const idx = EXPERIMENT_MODES.indexOf(this.experimentMode);
    const next = EXPERIMENT_MODES[(idx + 1) % EXPERIMENT_MODES.length]!;
    this.setExperiment(next);
  }

  teleportToObstacle(): void {
    const world = this.deps.getWorld();
    const player = world.player;
    if (!player) return;
    const targetX = 290;
    const targetZ = 12;
    const hf = world.terrainProvider.heightfield;
    const tiles = this.deps.getTiles();
    const targetY = (tiles ? tiles.surfaceElevation(targetX, targetZ, 15, hf.sample(targetX, targetZ)) : null)
      ?? (hf.sample(targetX, targetZ) + 1.2);

    player.body.pos.set(targetX, targetY, targetZ);
    player.body.vel.set(0, 0, 0);
    player.body.angVel.set(0, 0, 0);
    player.body.quat.setFromAxisAngle(UNIT_Y, -Math.PI / 2);
    player.body.snapPrev();
    this.deps.cameraRig.skipIntro(player.body);
    this.deps.cameraRig.snap(player.body);
    this.showToast('Teleported in front of St. Johns Bridge road test spot (X:290, Z:12)');
  }

  hideSurfacePreview(): void {
    if (this.surfacePreview) this.surfacePreview.visible = false;
  }

  bootstrapUrlScenario(): void {
    const { urlParams, relocateBarEl } = this.deps;
    if (!urlParams) return;
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
          // a deep link relocates into the garage backdrop; START ENGINE (or a
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

  update(now: number): void {
    const world = this.deps.getWorld();
    const tiles = this.deps.getTiles();
    const groundStreamer = this.deps.getGroundStreamer();
    const surface = this.deps.getSurface();

    if (this.showDiagnostic && world.player?.body) {
      const b = world.player.body;
      const hf = world.terrainProvider.heightfield;
      const groundY = hf.sample(b.pos.x, b.pos.z);
      const diff = b.pos.y - groundY;
      const isUnder = diff < -0.3;
      const center = world.terrainProvider.center;
      if (center && this.diagGpsEl) {
        const gps = worldToLl(b.pos.x, b.pos.z, center);
        const matched = findScenarioByCoords(gps.lat, gps.lon);
        this.diagGpsEl.style.display = 'inline';
        this.diagGpsEl.textContent = `${matched ? `[${matched.name}]` : 'GPS'} ${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}`;
      } else if (this.diagGpsEl) {
        this.diagGpsEl.style.display = 'none';
      }
      if (this.diagXzEl) this.diagXzEl.textContent = `X:${b.pos.x.toFixed(0)} Z:${b.pos.z.toFixed(0)}`;
      if (this.diagGroundEl) this.diagGroundEl.textContent = `Ground: ${groundY.toFixed(1)}m`;
      if (this.diagCarEl) this.diagCarEl.textContent = `Car Y: ${b.pos.y.toFixed(1)}m`;
      if (this.diagStatusEl) {
        this.diagStatusEl.style.color = isUnder ? '#ff2d55' : '#7dd87d';
        this.diagStatusEl.textContent = isUnder ? `⚠️ UNDERGROUND (${Math.abs(diff).toFixed(1)}m)` : `✅ ON SURFACE (Δ ${diff.toFixed(2)}m)`;
      }
      if (this.diagTilesEl) {
        this.diagTilesEl.textContent = `Tiles: ${tiles ? `${tiles.tileCount} active` : 'off'}${groundStreamer ? ` | Sat: Z${groundStreamer.activeZoom} (${groundStreamer.patchCount}p)` : ''}`;
      }
      if (this.diagOsmEl) {
        this.diagOsmEl.style.color = tiles?.hasRoadGrid ? '#38bdf8' : '#eab308';
        this.diagOsmEl.textContent = `OSM: ${tiles?.hasRoadGrid ? '✅ Loaded' : '⏳ Pending'}`;
      }
      if (this.diagSurfaceEl) {
        const on = surface.active && surface.field !== null && surface.capture !== null;
        this.diagSurfaceEl.style.display = on ? 'inline' : 'none';
        if (on) {
          const t = surface.capture!.timings;
          this.diagSurfaceEl.textContent = `Surface: ${surface.field!.sample(b.pos.x, b.pos.z).toFixed(2)}m (Δ ${surface.field!.deltaAt(b.pos.x, b.pos.z).toFixed(2)}) cap ${t.renderMs.toFixed(1)}/${t.readbackMs.toFixed(0)}/${t.processMs.toFixed(1)}ms ×${t.captures}`;
        }
      }
    }

    // F8 corner view of the captured surface, redrawn at 10 Hz (the field itself only changes per capture)
    if (this.showDiagnostic && surface.active && surface.field && world.player?.body && now - this.surfacePreviewAt > 100) {
      this.surfacePreviewAt = now;
      this.surfacePreview ??= new SurfacePreview();
      this.surfacePreview.visible = true;
      this.surfacePreview.draw(surface.field, world.player.body.pos.x, world.player.body.pos.z);
    } else if (this.surfacePreview && (!this.showDiagnostic || !surface.active)) {
      this.surfacePreview.visible = false;
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.diagEl.removeEventListener('click', this.onDiagClick);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.diagEl.remove();
    this.toastEl.remove();
  }
}
