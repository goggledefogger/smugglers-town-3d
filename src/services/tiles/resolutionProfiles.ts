import type { LodPolicy } from './Tileset.ts';

export type Resolution3DMode = 'balanced' | 'high' | 'ultra';

export const RESOLUTION_3D_MODES: readonly Resolution3DMode[] = ['balanced', 'high', 'ultra'];

export interface Resolution3DProfile {
  readonly mode: Resolution3DMode;
  readonly label: string;
  readonly description: string;
  readonly lod: LodPolicy;
  readonly maxTiles: number;
  readonly refineIntervalMs: number;
  readonly refineBatchSize: number;
  readonly anisotropy: number;
  readonly dprCap: number;
  readonly coreRadiusM: number;
  readonly coreRefineRounds: number;
  readonly satelliteZoom: number;
  readonly satelliteMaxPatches: number;
}

/**
 * 3D Resolution & Photogrammetry Fidelity Profiles
 *
 * Balanced:
 *   Baseline settings tuned for modest hardware and laptops. Clamps geometric
 *   error to 1.5m and caps tiles at 350 to ensure 60fps on integrated graphics.
 *   Ground satellite imagery streams at Zoom 18 (~0.24m/pixel).
 *
 * High (Crisp 3D & Roads):
 *   Descends to finest available Google 3D Tiles leaf nodes (~2m in practice).
 *   Increases tile ceiling to 550, unlocks native Retina 2.0x DPR with 8x anisotropy,
 *   and upgrades ground satellite imagery to Zoom 19 (~0.12m/pixel) for 2x sharper
 *   road surfaces, crosswalks, and asphalt markings.
 *
 * Ultra (Max Detail & Ground):
 *   Requests deepest possible leaf nodes, raises tile budget to 750 tiles with 80ms
 *   bursts, 2.5x supersampled DPR, full 16x anisotropic filtering, and pushes
 *   ground satellite imagery to Zoom 20 (~0.06m/pixel) for ultra-fine street texture.
 */
export const RESOLUTION_3D_PROFILES: Record<Resolution3DMode, Resolution3DProfile> = {
  balanced: {
    mode: 'balanced',
    label: 'Balanced (1.5m, Z18)',
    description: '1.5m LOD, 180 tiles, Zoom 18 ground (~24cm/px), 1.5x DPR',
    lod: { minErrorM: 1.5, maxErrorM: 40, errorPerMeter: 1 / 60 },
    maxTiles: 180,
    refineIntervalMs: 350,
    refineBatchSize: 1,
    anisotropy: 4,
    dprCap: 1.5,
    coreRadiusM: 450,
    coreRefineRounds: 5,
    satelliteZoom: 18,
    satelliteMaxPatches: 16
  },
  high: {
    mode: 'high',
    label: 'High (0.8m, Z19)',
    description: '0.8m LOD, 550 tiles, Zoom 19 ground (~12cm/px, 2x sharper), 2.0x DPR',
    lod: { minErrorM: 0.8, maxErrorM: 30, errorPerMeter: 1 / 90 },
    maxTiles: 550,
    refineIntervalMs: 120,
    refineBatchSize: 2,
    anisotropy: 8,
    dprCap: 2.0,
    coreRadiusM: 650,
    coreRefineRounds: 8,
    satelliteZoom: 19,
    satelliteMaxPatches: 36
  },
  ultra: {
    mode: 'ultra',
    label: 'Ultra (0.4m, Z20)',
    description: '0.4m LOD, 750 tiles, Zoom 20 ground (~6cm/px, 4x sharper), 2.5x DPR',
    lod: { minErrorM: 0.4, maxErrorM: 20, errorPerMeter: 1 / 120 },
    maxTiles: 750,
    refineIntervalMs: 80,
    refineBatchSize: 3,
    anisotropy: 16,
    dprCap: 2.5,
    coreRadiusM: 800,
    coreRefineRounds: 10,
    satelliteZoom: 20,
    satelliteMaxPatches: 48
  }
};

export function getResolutionProfile(mode: Resolution3DMode): Resolution3DProfile {
  return RESOLUTION_3D_PROFILES[mode] ?? RESOLUTION_3D_PROFILES.balanced;
}
