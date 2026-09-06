/**
 * Procedural vehicle bodies: one silhouette per roster type, built from
 * primitives so the game stays asset-free. Local frame: +X right, +Y up,
 * -Z forward. Wheels sit at x = ±0.95, z = ±1.3 and every body stays inside
 * the 2.2 × 4 physics box. Team color is the paint; the type's accent color
 * goes on stripes, cages, spoilers and light bars.
 */
import {
  Group, Mesh, BoxGeometry, CylinderGeometry, MeshStandardMaterial, MeshPhysicalMaterial, MathUtils,
  type Texture
} from 'three';
import type { VehicleStats } from '../core/physics/vehicleStats.ts';
import { liverySide, liveryTop, tread, sidewall } from './vehicleTextures.ts';

let envMap: Texture | null = null;

/** Reflections for paint, glass and chrome; set once from the renderer before any vehicle is built. */
export function setVehicleEnvMap(t: Texture | null): void {
  envMap = t;
}

/** The studio envmap shared with reflective props like the golden toilet. */
export function vehicleEnvMap(): Texture | null {
  return envMap;
}

export interface VehicleMesh {
  readonly root: Group;
  /** Spin groups (rotate about local Y = the axle) with their radii. */
  readonly wheels: readonly { readonly spin: Group; readonly r: number }[];
  readonly frontPivots: readonly Group[];
  /** Front wheel radius: the ride-height reference for the body. */
  readonly wheelR: number;
  /** Tail-light material; brightened while braking. */
  readonly tail: MeshStandardMaterial;
}

interface Palette {
  readonly paint: MeshPhysicalMaterial;
  /** Body box faces: +x, −x, +y, −y, +z, −z — livery on the sides and roof. */
  readonly body: MeshPhysicalMaterial[];
  readonly dark: MeshStandardMaterial;
  readonly glass: MeshStandardMaterial;
  readonly accent: MeshStandardMaterial;
  readonly chrome: MeshStandardMaterial;
  /** Tire cylinder groups: tread around, sidewall on both caps. */
  readonly tire: MeshStandardMaterial[];
  readonly head: MeshStandardMaterial;
  readonly tail: MeshStandardMaterial;
}

function palette(stats: VehicleStats, teamColor: number): Palette {
  // reflections stay subtle on paint: the studio map is bright, and a glossy
  // clearcoat turns roofs into white mirrors at grazing angles
  const paintOpts = { metalness: 0.3, roughness: 0.42, clearcoat: 0.45, clearcoatRoughness: 0.4, envMap, envMapIntensity: 0.22 };
  const paint = new MeshPhysicalMaterial({ color: teamColor, ...paintOpts });
  const livery = (map: Texture): MeshPhysicalMaterial => new MeshPhysicalMaterial({ color: 0xffffff, map, ...paintOpts });
  const right = livery(liverySide(stats, teamColor, false));
  const left = livery(liverySide(stats, teamColor, true));
  const top = livery(liveryTop(stats, teamColor));
  const wall = new MeshStandardMaterial({ map: sidewall(), roughness: 0.7, metalness: 0.3, envMap, envMapIntensity: 0.3 });
  return {
    paint,
    body: [right, left, top, paint, paint, paint],
    dark: new MeshStandardMaterial({ color: 0x1b1b1f, roughness: 0.85 }),
    glass: new MeshStandardMaterial({ color: 0x0c1620, metalness: 1.0, roughness: 0.08, envMap, envMapIntensity: 0.8 }),
    accent: new MeshStandardMaterial({ color: stats.color, roughness: 0.5, metalness: 0.2 }),
    chrome: new MeshStandardMaterial({ color: 0xd0d6dc, metalness: 1.0, roughness: 0.2, envMap, envMapIntensity: 0.9 }),
    tire: [new MeshStandardMaterial({ map: tread(), roughness: 0.95 }), wall, wall],
    head: new MeshStandardMaterial({ color: 0xfff4d0, emissive: 0xffe6a0, emissiveIntensity: 1.4 }),
    tail: new MeshStandardMaterial({ color: 0x4a0000, emissive: 0xff2a14, emissiveIntensity: 0.6 })
  };
}

type Mat = MeshStandardMaterial | MeshPhysicalMaterial | (MeshStandardMaterial | MeshPhysicalMaterial)[];

/** Small builder bound to a group: boxes and cylinders placed in one call. */
class Builder {
  constructor(readonly g: Group) {}

  box(w: number, h: number, d: number, m: Mat, x: number, y: number, z: number, rx = 0): Mesh {
    const mesh = new Mesh(new BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    if (rx) mesh.rotation.x = rx;
    this.g.add(mesh);
    return mesh;
  }

  /** Cylinder along an axis. */
  cyl(r: number, len: number, m: Mat, x: number, y: number, z: number, axis: 'x' | 'y' | 'z' = 'y', segs = 10): Mesh {
    const mesh = new Mesh(new CylinderGeometry(r, r, len, segs), m);
    mesh.position.set(x, y, z);
    if (axis === 'x') mesh.rotation.z = Math.PI / 2;
    if (axis === 'z') mesh.rotation.x = Math.PI / 2;
    this.g.add(mesh);
    return mesh;
  }

  lights(p: Palette, y: number, frontZ: number, rearZ: number, w = 0.36): void {
    for (const x of [-0.7, 0.7]) {
      this.box(w, 0.16, 0.06, p.head, x, y, frontZ);
      this.box(w, 0.12, 0.06, p.tail, x, y, rearZ);
    }
  }

  bumpers(p: Palette, y: number, w: number, z: number): void {
    this.box(w, 0.22, 0.18, p.dark, 0, y, -z);
    this.box(w, 0.22, 0.18, p.dark, 0, y, z);
  }
}

/** A wheel: treaded tire with rim-textured sidewalls, in a spin group whose local Y is the axle. */
function wheel(r: number, width: number, p: Palette): Group {
  const spin = new Group();
  spin.rotation.z = Math.PI / 2;
  spin.add(new Mesh(new CylinderGeometry(r, r, width, 20), p.tire));
  return spin;
}

interface Layout {
  /** rear wheel radius (front is wheelR) */
  readonly rearR: number;
  readonly wheelW: number;
}

function buggy(b: Builder, p: Palette, r: number): Layout {
  const y = r + 0.35;
  b.box(1.7, 0.45, 2.8, p.body, 0, y, 0.2);           // tub
  b.box(1.4, 0.3, 1.0, p.paint, 0, y - 0.05, -1.7, -0.18); // nose, dipped
  for (const x of [-0.42, 0.42]) {                    // seats
    b.box(0.55, 0.45, 0.6, p.dark, x, y + 0.4, 0.2);
    b.box(0.55, 0.55, 0.1, p.dark, x, y + 0.7, 0.5);
  }
  b.box(0.9, 0.36, 0.55, p.dark, 0, y + 0.3, 1.4);    // engine
  b.cyl(0.18, 0.28, p.chrome, 0, y + 0.62, 1.4, 'y');  // air filter
  // roll cage
  for (const z of [-0.45, 0.85]) {
    for (const x of [-0.8, 0.8]) b.cyl(0.05, 1.15, p.accent, x, y + 0.75, z, 'y', 6);
    b.cyl(0.05, 1.7, p.accent, 0, y + 1.3, z, 'x', 6);
  }
  for (const x of [-0.8, 0.8]) b.cyl(0.05, 1.4, p.accent, x, y + 1.3, 0.2, 'z', 6);
  for (const x of [-0.45, 0.45]) b.cyl(0.14, 0.08, p.head, x, y + 0.15, -2.15, 'z', 10);
  for (const x of [-0.6, 0.6]) b.box(0.3, 0.12, 0.06, p.tail, x, y + 0.1, 1.85);
  return { rearR: r * 1.22, wheelW: 0.45 };
}

function rally(b: Builder, p: Palette, r: number): Layout {
  const y = r + 0.32;
  b.box(2.1, 0.5, 4.2, p.body, 0, y, 0);              // body
  b.box(1.85, 0.5, 1.9, p.paint, 0, y + 0.45, 0.35);  // cabin
  b.box(1.8, 0.08, 1.0, p.glass, 0, y + 0.5, -0.78, -0.62);   // raked windshield, meets the roof
  b.box(1.7, 0.08, 0.75, p.glass, 0, y + 0.5, 1.42, 0.7);     // rear glass
  b.box(1.86, 0.28, 1.5, p.glass, 0, y + 0.52, 0.35);         // side windows
  for (const x of [-1.06, 1.06]) b.box(0.03, 0.16, 3.7, p.accent, x, y + 0.08, 0);
  b.box(2.0, 0.06, 0.42, p.accent, 0, y + 0.85, 1.95);         // spoiler
  for (const x of [-0.7, 0.7]) b.box(0.08, 0.4, 0.08, p.dark, x, y + 0.62, 1.95);
  b.bumpers(p, y - 0.15, 2.15, 2.12);
  b.lights(p, y + 0.15, -2.12, 2.12);
  return { rearR: r, wheelW: 0.45 };
}

function suv(b: Builder, p: Palette, r: number): Layout {
  const y = r + 0.45;
  b.box(2.2, 0.8, 4.0, p.body, 0, y, 0);              // body
  b.box(2.0, 0.75, 2.5, p.paint, 0, y + 0.75, 0.1);   // cabin
  b.box(2.03, 0.4, 2.25, p.glass, 0, y + 0.85, 0.1);  // windows
  b.box(1.9, 0.08, 0.75, p.glass, 0, y + 0.85, -1.2, -0.62); // windshield
  for (const x of [-0.8, 0.8]) b.box(0.08, 0.08, 2.3, p.dark, x, y + 1.17, 0.1);   // rack rails
  for (const z of [-0.8, 0.1, 1.0]) b.box(1.7, 0.06, 0.06, p.dark, 0, y + 1.17, z);
  for (const x of [-1.11, 1.11]) b.box(0.03, 0.12, 3.6, p.accent, x, y - 0.1, 0);
  b.bumpers(p, y - 0.28, 2.25, 2.05);
  b.lights(p, y + 0.12, -2.03, 2.03, 0.42);
  return { rearR: r, wheelW: 0.5 };
}

/** Pickup on a lift; shared by the trophy and monster trucks. */
function pickup(b: Builder, p: Palette, r: number, lift: number): number {
  const y = r + 0.5 + lift;
  b.box(2.1, 0.5, 4.2, p.body, 0, y, 0);              // chassis
  b.box(2.0, 0.7, 1.75, p.paint, 0, y + 0.6, -0.55);  // cab
  b.box(2.03, 0.34, 1.35, p.glass, 0, y + 0.7, -0.55); // side glass
  b.box(1.85, 0.08, 0.7, p.glass, 0, y + 0.72, -1.45, -0.62); // windshield
  for (const x of [-1.0, 1.0]) b.box(0.08, 0.36, 1.8, p.paint, x, y + 0.43, 1.2); // bed walls
  b.box(2.0, 0.36, 0.08, p.paint, 0, y + 0.43, 2.06);  // tailgate
  b.box(0.5, 0.02, 1.2, p.accent, 0, y + 0.26, -1.55); // hood stripe
  b.bumpers(p, y - 0.28, 2.15, 2.12);
  b.lights(p, y + 0.05, -2.12, 2.12, 0.4);
  return y;
}

function trophy(b: Builder, p: Palette, r: number): Layout {
  const lift = 0.22;
  const y = pickup(b, p, r, lift);
  for (const x of [-1.15, 1.15]) for (const z of [-1.3, 1.3]) b.box(0.45, 0.22, 1.35, p.dark, x, r * 1.75 + lift, z); // fenders
  b.box(1.8, 0.12, 0.14, p.dark, 0, y + 1.02, -0.6);   // light bar
  for (const x of [-0.6, -0.2, 0.2, 0.6]) b.box(0.24, 0.14, 0.12, p.head, x, y + 1.02, -0.68);
  return { rearR: r, wheelW: 0.55 };
}

function monster(b: Builder, p: Palette, r: number): Layout {
  const lift = 0.85;
  const y = pickup(b, p, r, lift);
  for (const z of [-1.3, 1.3]) b.cyl(0.12, 2.3, p.dark, 0, r, z, 'x');           // axles
  b.box(0.5, 0.3, 3.2, p.dark, 0, r + 0.35, 0);                                   // spine
  for (const x of [-0.75, 0.75]) for (const z of [-1.3, 1.3]) b.box(0.12, lift + 0.3, 0.12, p.chrome, x, r + lift / 2 + 0.3, z); // shocks
  for (const x of [-0.55, 0.55]) b.cyl(0.08, 0.9, p.chrome, x, y + 1.0, 0.35, 'y', 8); // stacks
  for (const x of [-1.06, 1.06]) b.box(0.03, 0.18, 3.6, p.accent, x, y + 0.05, 0);
  return { rearR: r, wheelW: 0.75 };
}

const KINDS: Record<string, (b: Builder, p: Palette, r: number) => Layout> = {
  'Dune Buggy': buggy,
  'Rally Car': rally,
  'SUV': suv,
  'Trophy Truck': trophy,
  'Monster Truck': monster
};

export function buildVehicle(stats: VehicleStats, teamColor: number): VehicleMesh {
  const p = palette(stats, teamColor);
  const root = new Group();
  const b = new Builder(root);
  const wheelR = MathUtils.clamp(0.45 + 0.28 * (stats.mass - 0.9), 0.4, 0.8);
  const layout = (KINDS[stats.name] ?? suv)(b, p, wheelR);
  const wheels: { spin: Group; r: number }[] = [];
  const frontPivots: Group[] = [];
  for (const [x, z] of [[0.95, 1.3], [-0.95, 1.3], [0.95, -1.3], [-0.95, -1.3]] as const) {
    const r = z > 0 ? layout.rearR : wheelR;
    const pivot = new Group();
    pivot.position.set(x, r, z);
    const spin = wheel(r, layout.wheelW, p);
    pivot.add(spin);
    root.add(pivot);
    wheels.push({ spin, r });
    if (z < 0) frontPivots.push(pivot); // forward is -z
  }
  return { root, wheels, frontPivots, wheelR, tail: p.tail };
}
