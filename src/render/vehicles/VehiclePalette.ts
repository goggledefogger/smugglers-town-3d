import {
  MeshStandardMaterial, MeshPhysicalMaterial, type Texture
} from 'three';
import type { VehicleStats } from '../../core/physics/vehicleStats.ts';
import type { VehiclePalette } from './types.ts';
import {
  liverySide, liveryTop, liveryRear, liveryTailgate, liveryHood
} from './textures/liveryTextures.ts';
import { tread, sidewall } from './textures/wheelTextures.ts';

let envMap: Texture | null = null;

/** Reflections for paint, glass and chrome; set once from the renderer before any vehicle is built. */
export function setVehicleEnvMap(t: Texture | null): void {
  envMap = t;
}

/** The studio envmap shared with reflective props like the golden toilet. */
export function vehicleEnvMap(): Texture | null {
  return envMap;
}

export function createVehiclePalette(stats: VehicleStats, teamColor: number): VehiclePalette {
  const paintOpts = {
    metalness: 0.3,
    roughness: 0.42,
    clearcoat: 0.45,
    clearcoatRoughness: 0.4,
    envMap,
    envMapIntensity: 0.22
  };

  const paint = new MeshPhysicalMaterial({ color: teamColor, ...paintOpts });
  const livery = (map: Texture): MeshPhysicalMaterial =>
    new MeshPhysicalMaterial({ color: 0xffffff, map, ...paintOpts });

  const right = livery(liverySide(stats, teamColor, false));
  const left = livery(liverySide(stats, teamColor, true));
  const top = livery(liveryTop(stats, teamColor));
  const rear = livery(liveryRear(stats, teamColor));
  const tailgate = livery(liveryTailgate(stats, teamColor));
  const hood = livery(liveryHood(stats, teamColor));
  const wall = new MeshStandardMaterial({
    map: sidewall(),
    roughness: 0.7,
    metalness: 0.3,
    envMap,
    envMapIntensity: 0.3
  });

  return {
    paint,
    // Box faces: [+x right, -x left, +y top, -y bottom, +z rear, -z front]
    body: [right, left, top, paint, rear, paint],
    top,
    rear,
    tailgate,
    hood,
    dark: new MeshStandardMaterial({ color: 0x1b1b1f, roughness: 0.85 }),
    glass: new MeshStandardMaterial({
      color: 0x0c1620,
      metalness: 1.0,
      roughness: 0.08,
      envMap,
      envMapIntensity: 0.8
    }),
    accent: new MeshStandardMaterial({ color: stats.color, roughness: 0.5, metalness: 0.2 }),
    chrome: new MeshStandardMaterial({
      color: 0xd0d6dc,
      metalness: 1.0,
      roughness: 0.2,
      envMap,
      envMapIntensity: 0.9
    }),
    tire: [new MeshStandardMaterial({ map: tread(), roughness: 0.95 }), wall, wall],
    head: new MeshStandardMaterial({ color: 0xfff4d0, emissive: 0xffe6a0, emissiveIntensity: 1.4 }),
    tail: new MeshStandardMaterial({ color: 0x4a0000, emissive: 0xff2a14, emissiveIntensity: 0.6 })
  };
}
