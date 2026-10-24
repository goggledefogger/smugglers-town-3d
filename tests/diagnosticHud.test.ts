import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DiagnosticHud,
  EXPERIMENT_MODES,
  experimentLabel,
  experimentDescription
} from '../src/ui/hud/DiagnosticHud.ts';

describe('DiagnosticHud', () => {
  let origDocument: unknown;
  let origWindow: unknown;
  let origLocalStorage: unknown;

  beforeEach(() => {
    origDocument = (globalThis as any).document;
    origWindow = (globalThis as any).window;
    origLocalStorage = (globalThis as any).localStorage;

    const makeEl = () => ({
      id: '',
      style: { cssText: '', display: '', opacity: '', transform: '', color: '' },
      innerHTML: '',
      textContent: '',
      querySelector: () => makeEl(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      remove: vi.fn()
    });

    (globalThis as any).document = {
      createElement: () => makeEl(),
      body: { appendChild: vi.fn() }
    };
    (globalThis as any).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
    (globalThis as any).localStorage = {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn()
    };
  });

  afterEach(() => {
    (globalThis as any).document = origDocument;
    (globalThis as any).window = origWindow;
    (globalThis as any).localStorage = origLocalStorage;
    vi.restoreAllMocks();
  });

  it('provides human-readable labels and descriptions for all 4 experiment modes', () => {
    expect(EXPERIMENT_MODES).toEqual(['baseline', 'road_carve', 'curbside_inset', 'high_res']);
    for (const mode of EXPERIMENT_MODES) {
      expect(experimentLabel(mode).length).toBeGreaterThan(3);
      expect(experimentDescription(mode).length).toBeGreaterThan(10);
    }
  });

  it('cycles experiment and 3D resolution modes and cleans up listeners on dispose', () => {
    const setDprCap = vi.fn();
    const applyColliders = vi.fn();
    const setExperimentMode = vi.fn();
    const setResolutionMode = vi.fn();
    const updateStructureGrid = vi.fn();

    const hud = new DiagnosticHud({
      urlParams: new URLSearchParams('debug=1&colliderExp=road_carve'),
      weakDevice: false,
      renderer: { setDprCap } as any,
      settingsEl: null,
      relocateBarEl: { setQuery: vi.fn(), status: '', busy: false, hidden: false, featured: false } as any,
      cameraRig: { skipIntro: vi.fn(), snap: vi.fn() } as any,
      getWorld: () => ({ player: null, terrainProvider: { heightfield: { sample: () => 0 } } }) as any,
      getTiles: () => ({
        setExperimentMode,
        setResolutionMode,
        structureGrid: new Uint8Array(4),
        grid: { n: 2 }
      }) as any,
      getGroundStreamer: () => null,
      getClutterFilter: () => ({ updateStructureGrid }) as any,
      applyColliders,
      getSurface: () => ({ active: false, field: null, capture: null })
    });

    expect(hud.experimentMode).toBe('road_carve');
    hud.cycleExperimentMode();
    expect(hud.experimentMode).toBe('curbside_inset');
    expect(setExperimentMode).toHaveBeenCalledWith('curbside_inset');
    expect(updateStructureGrid).toHaveBeenCalledTimes(1);
    expect(applyColliders).toHaveBeenCalledTimes(1);

    const initialRes = hud.resolutionMode;
    hud.cycleResolutionMode();
    expect(hud.resolutionMode).not.toBe(initialRes);
    expect(setResolutionMode).toHaveBeenCalledWith(hud.resolutionMode);

    hud.dispose();
    expect((globalThis as any).window.removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
  });
});
