/**
 * Stylized 3D rendering of the game's actual collision geometry (buildings, piers, obstacles).
 *
 * In "Game 3D" mode, this replaces photogrammetry meshes so players see the exact 3D
 * collision boxes they interact with — 100% physically coherent, zero invisible walls,
 * zero drive-through-wall mismatch.
 */
import {
  Group, BoxGeometry, InstancedMesh, MeshStandardMaterial, Matrix4, Vector3,
  Quaternion, Color, LineSegments, DataTexture, RGBAFormat, UnsignedByteType,
  type Texture, type WebGLProgramParametersWithUniforms
} from 'three';
import type { BuildingCollider } from '../core/physics/VehicleBody.ts';
import type { Grid } from '../services/tiles/tileColliders.ts';
import { NO_DATA } from '../services/tiles/tileColliders.ts';
import { BUILDING_COLORS } from '../core/theme.ts';

export type BuildingMeshMode = 'arcade' | 'textured';

const _mat = new Matrix4();
const _pos = new Vector3();
const _scale = new Vector3();
const _quat = new Quaternion();
const _color = new Color();

const VERTEX_PARS_BUILDING = `
uniform float uHasTexture;
varying vec3 vWorldPos;
varying vec3 vBuildingNormal;
varying float vIsRoof;
varying float vLocalNormY;
`;

const VERTEX_BODY_BUILDING = `
vec4 bWorldPos = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
  bWorldPos = batchingMatrix * bWorldPos;
#endif
#ifdef USE_INSTANCING
  bWorldPos = instanceMatrix * bWorldPos;
#endif
vWorldPos = (modelMatrix * bWorldPos).xyz;
vIsRoof = normal.y > 0.5 ? 1.0 : 0.0;
vBuildingNormal = normal;
vLocalNormY = position.y + 0.5;
`;

const FRAGMENT_PARS_BUILDING = `
uniform sampler2D uSatelliteMap;
uniform float uMapSize;
uniform float uHasTexture;
varying vec3 vWorldPos;
varying vec3 vBuildingNormal;
varying float vIsRoof;
varying float vLocalNormY;
`;

/**
 * Textured (Best 3D) look: the roof is the satellite image, the walls are an
 * unlit satellite-toned concrete with face shading and eave/plinth occlusion.
 * The walls are only the fill behind the snapped tile facades; the tiles
 * themselves carry the real imagery. Unlit like the tiles and the ground
 * around it: the photo light rig turned a lit wall near black.
 */
const FRAGMENT_BODY_BUILDING = `
vec3 bestFill = vec3(-1.0);
if (uHasTexture > 0.5) {
  vec2 satUV = vec2(
    vWorldPos.x / uMapSize + 0.5,
    0.5 - vWorldPos.z / uMapSize
  );
  vec4 sat = texture2D(uSatelliteMap, clamp(satUV, 0.0, 1.0));
  if (vIsRoof > 0.5) {
    bestFill = sat.rgb;
  } else {
    float faceLight = abs(vBuildingNormal.z) > 0.5 ? 0.94 : 0.86;
    if (vBuildingNormal.y < -0.5) faceLight = 0.5;
    float eaveShadow = smoothstep(0.92, 1.0, vLocalNormY);
    float groundPlinth = smoothstep(0.08, 0.0, vLocalNormY);
    float verticalAO = (1.0 - 0.22 * eaveShadow) * (1.0 - 0.32 * groundPlinth);
    // linear values: 0.2 lands near mid grey once tone mapped and encoded, about the
    // brightness of a photographed concrete wall
    bestFill = mix(vec3(0.21, 0.20, 0.19), sat.rgb, 0.35) * faceLight * verticalAO;
  }
  diffuseColor.rgb = bestFill;
}
`;

const FRAGMENT_OPAQUE_BUILDING = `
if (bestFill.r >= 0.0) {
  gl_FragColor.rgb = bestFill;
}
`;

/**
 * Anchors a collider firmly into the ground across its entire footprint,
 * ensuring physics collision boxes and visual geometry reach down below the lowest
 * downhill terrain point (multi-point footprint sampling) so vehicles can never drive
 * underneath buildings on steep hillsides or uneven ground.
 */
export function anchorCollider(
  b: BuildingCollider,
  sampleGround?: (x: number, z: number) => number
): BuildingCollider {
  if (!sampleGround) return b;
  const cx = (b.min.x + b.max.x) / 2;
  const cz = (b.min.z + b.max.z) / 2;

  const g00 = sampleGround(b.min.x, b.min.z);
  const g10 = sampleGround(b.max.x, b.min.z);
  const g01 = sampleGround(b.min.x, b.max.z);
  const g11 = sampleGround(b.max.x, b.max.z);
  const gMidX0 = sampleGround(cx, b.min.z);
  const gMidX1 = sampleGround(cx, b.max.z);
  const gMidZ0 = sampleGround(b.min.x, cz);
  const gMidZ1 = sampleGround(b.max.x, cz);
  const gCenter = sampleGround(cx, cz);

  const minGround = Math.min(g00, g10, g01, g11, gMidX0, gMidX1, gMidZ0, gMidZ1, gCenter);
  const drop = b.kind === 'prop' ? 0.8 : 2.5;
  const minY = Math.min(b.min.y, minGround - drop);
  if (minY === b.min.y) return b;
  return {
    ...b,
    min: new Vector3(b.min.x, minY, b.min.z),
    max: new Vector3(b.max.x, b.max.y, b.max.z)
  };
}

export class BuildingMeshView {
  readonly group = new Group();
  private buildingMesh: InstancedMesh | null = null;
  private deckMesh: InstancedMesh | null = null;
  private wireframeMesh: LineSegments | null = null;
  private readonly boxGeo = new BoxGeometry(1, 1, 1);

  // Material uniforms for texture projection
  private readonly uHasTexture = { value: 0.0 };
  private readonly uMapSize = { value: 5600.0 };
  private readonly dummyTex: DataTexture;
  private readonly uSatelliteMap: { value: Texture };

  // Modern arcade architectural materials
  private readonly buildingMat: MeshStandardMaterial;
  private readonly deckMat: MeshStandardMaterial;

  constructor() {
    this.group.visible = false;
    this.dummyTex = new DataTexture(new Uint8Array([100, 110, 120, 255]), 1, 1, RGBAFormat, UnsignedByteType);
    this.dummyTex.needsUpdate = true;
    this.uSatelliteMap = { value: this.dummyTex };

    this.buildingMat = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.65,
      metalness: 0.15,
      flatShading: true,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2
    });

    this.deckMat = new MeshStandardMaterial({
      color: BUILDING_COLORS.deck,
      roughness: 0.8,
      metalness: 0.05,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2
    });

    this.hookMaterial(this.buildingMat, 'building-mesh-view');
    this.hookMaterial(this.deckMat, 'deck-mesh-view');
  }

  private hookMaterial(mat: MeshStandardMaterial, cacheKey: string): void {
    mat.customProgramCacheKey = () => cacheKey;
    mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
      shader.uniforms.uHasTexture = this.uHasTexture;
      shader.uniforms.uSatelliteMap = this.uSatelliteMap;
      shader.uniforms.uMapSize = this.uMapSize;

      shader.vertexShader = VERTEX_PARS_BUILDING + shader.vertexShader
        .replace('#include <project_vertex>', '#include <project_vertex>\n' + VERTEX_BODY_BUILDING);

      shader.fragmentShader = FRAGMENT_PARS_BUILDING + shader.fragmentShader
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAGMENT_BODY_BUILDING)
        .replace('#include <opaque_fragment>', '#include <opaque_fragment>\n' + FRAGMENT_OPAQUE_BUILDING);
    };
  }

  setMode(mode: BuildingMeshMode): void {
    this.uHasTexture.value = mode === 'textured' ? 1.0 : 0.0;
  }

  getMode(): BuildingMeshMode {
    return this.uHasTexture.value > 0.5 ? 'textured' : 'arcade';
  }

  setTexture(tex: Texture | null, mapSize: number): void {
    this.uSatelliteMap.value = tex ?? this.dummyTex;
    this.uMapSize.value = mapSize;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  set visible(v: boolean) {
    this.group.visible = v;
  }

  private lastColliders: readonly BuildingCollider[] = [];
  private lastDeckGrid: Float32Array | undefined;
  private lastGrid: Grid | undefined;

  /**
   * Refresh building heights when the terrain heightfield refines in the background.
   */
  refreshHeights(sampleGround: (x: number, z: number) => number): void {
    if (this.lastColliders.length > 0) {
      this.update(this.lastColliders, this.lastDeckGrid, this.lastGrid, sampleGround, this.lastTopGrid);
    }
  }

  /**
   * Rebuild instances from the exact active colliders and deck grid.
   * If sampleGround is provided, each building box is firmly anchored into the terrain
   * with multi-point footprint sampling so buildings never hover on steep hills.
   */
  update(
    colliders: readonly BuildingCollider[],
    deckGrid?: Float32Array,
    grid?: Grid,
    sampleGround?: (x: number, z: number) => number,
    topGrid?: Float32Array
  ): void {
    this.lastColliders = colliders;
    this.lastDeckGrid = deckGrid;
    this.lastGrid = grid;
    this.lastTopGrid = topGrid;

    this.dispose();
    if (topGrid && grid) this.buildColumns(colliders, topGrid, grid, sampleGround);

    // 1. Build building boxes
    const count = colliders.length;
    if (count > 0) {
      const mesh = new InstancedMesh(this.boxGeo, this.buildingMat, count);
      mesh.castShadow = false; // Perf: avoid rendering thousands of instances in shadow pass
      mesh.receiveShadow = true;

      for (let i = 0; i < count; i++) {
        const raw = colliders[i]!;
        const b = anchorCollider(raw, sampleGround);
        const cx = (b.min.x + b.max.x) / 2;
        const cz = (b.min.z + b.max.z) / 2;
        const minY = b.min.y;
        const maxY = b.max.y;

        const sx = Math.max(0.2, b.max.x - b.min.x);
        const sy = Math.max(0.5, maxY - minY);
        const sz = Math.max(0.2, b.max.z - b.min.z);
        const cy = minY + sy / 2;

        _pos.set(cx, cy, cz);
        _scale.set(sx, sy, sz);
        _mat.compose(_pos, _quat, _scale);
        mesh.setMatrixAt(i, _mat);

        // Height-based stylized arcade palette:
        // Taller skyscrapers get cooler steel/blue tones; lower buildings get warm stone/slate
        if (sy > 40) {
          _color.setHex(BUILDING_COLORS.tall); // tall high-rise
        } else if (sy > 18) {
          _color.setHex(BUILDING_COLORS.mid); // mid-rise
        } else if (b.kind === 'prop') {
          _color.setHex(BUILDING_COLORS.propRock); // rock/prop
        } else {
          _color.setHex(BUILDING_COLORS.low); // low commercial/residential
        }
        mesh.setColorAt(i, _color);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.visible = !this._columns;
      this.buildingMesh = mesh;
      this.group.add(mesh);
    }

    // 2. Build elevated bridge decks and ramps from deckGrid
    if (deckGrid && grid) {
      const { n, cell, half } = grid;
      const deckIndices: number[] = [];
      for (let c = 0; c < n * n; c++) {
        if (deckGrid[c] !== NO_DATA) deckIndices.push(c);
      }

      if (deckIndices.length > 0) {
        const deckMesh = new InstancedMesh(this.boxGeo, this.deckMat, deckIndices.length);
        deckMesh.castShadow = false;
        deckMesh.receiveShadow = true;
        const THICKNESS = 1.4;
        for (let idx = 0; idx < deckIndices.length; idx++) {
          const c = deckIndices[idx]!;
          const i = c % n;
          const j = Math.floor(c / n);
          const x = -half + (i + 0.5) * cell;
          const z = -half + (j + 0.5) * cell;
          const topY = deckGrid[c]!;

          _pos.set(x, topY - THICKNESS / 2, z);
          _scale.set(cell * 0.98, THICKNESS, cell * 0.98);
          _mat.compose(_pos, _quat, _scale);
          deckMesh.setMatrixAt(idx, _mat);
        }
        deckMesh.instanceMatrix.needsUpdate = true;
        this.deckMesh = deckMesh;
        this.group.add(deckMesh);
      }
    }
  }

  /**
   * Best 3D+: the same collider volumes cut into one column per grid cell,
   * each only as tall as the photogrammetry in that cell. A box merged along
   * a row of cells rises to its tallest member everywhere; the columns give
   * the low buildings in the run their real roofline while every outer face
   * stays exactly where the collider's is, so the snapped facades still land.
   */
  private buildColumns(
    colliders: readonly BuildingCollider[],
    topGrid: Float32Array,
    grid: Grid,
    sampleGround?: (x: number, z: number) => number
  ): void {
    const { n, cell, half } = grid;
    const cellIndex = (v: number) => Math.min(n - 1, Math.max(0, Math.floor((v + half) / cell)));
    const anchored = colliders.map(b => anchorCollider(b, sampleGround));
    let count = 0;
    for (const b of anchored) {
      count += (cellIndex(b.max.x - 1e-3) - cellIndex(b.min.x) + 1) * (cellIndex(b.max.z - 1e-3) - cellIndex(b.min.z) + 1);
    }
    if (count === 0) return;
    const mesh = new InstancedMesh(this.boxGeo, this.buildingMat, count);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    let k = 0;
    for (const b of anchored) {
      const i0 = cellIndex(b.min.x), i1 = cellIndex(b.max.x - 1e-3);
      const j0 = cellIndex(b.min.z), j1 = cellIndex(b.max.z - 1e-3);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const x0 = Math.max(b.min.x, -half + i * cell), x1 = Math.min(b.max.x, -half + (i + 1) * cell);
          const z0 = Math.max(b.min.z, -half + j * cell), z1 = Math.min(b.max.z, -half + (j + 1) * cell);
          const t = topGrid[j * n + i]!;
          // a cell with no photogrammetry top of its own (a prop, a carved edge) keeps the box height
          const top = t !== NO_DATA && t > b.min.y + 0.5 && t <= b.max.y ? t : b.max.y;
          const sy = Math.max(0.5, top - b.min.y);
          _pos.set((x0 + x1) / 2, b.min.y + sy / 2, (z0 + z1) / 2);
          _scale.set(Math.max(0.2, x1 - x0), sy, Math.max(0.2, z1 - z0));
          _mat.compose(_pos, _quat, _scale);
          mesh.setMatrixAt(k, _mat);
          _color.setHex(sy > 40 ? BUILDING_COLORS.tall : sy > 18 ? BUILDING_COLORS.mid : b.kind === 'prop' ? BUILDING_COLORS.propRock : BUILDING_COLORS.low);
          mesh.setColorAt(k, _color);
          k++;
        }
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.visible = this._columns;
    this.columnMesh = mesh;
    this.group.add(mesh);
  }

  private _columns = false;
  private columnMesh: InstancedMesh | null = null;
  private lastTopGrid: Float32Array | undefined;

  /** Draw the colliders as per-cell roof-height columns (Best 3D+) instead of whole boxes. */
  get columns(): boolean {
    return this._columns;
  }

  set columns(on: boolean) {
    this._columns = on;
    if (this.buildingMesh) this.buildingMesh.visible = !on;
    if (this.columnMesh) this.columnMesh.visible = on;
  }

  clear(): void {
    this.dispose();
  }

  dispose(): void {
    if (this.buildingMesh) {
      this.group.remove(this.buildingMesh);
      this.buildingMesh.dispose();
      this.buildingMesh = null;
    }
    if (this.columnMesh) {
      this.group.remove(this.columnMesh);
      this.columnMesh.dispose();
      this.columnMesh = null;
    }
    if (this.deckMesh) {
      this.group.remove(this.deckMesh);
      this.deckMesh.dispose();
      this.deckMesh = null;
    }
    if (this.wireframeMesh) {
      this.group.remove(this.wireframeMesh);
      this.wireframeMesh.geometry.dispose();
      this.wireframeMesh = null;
    }
  }
}
