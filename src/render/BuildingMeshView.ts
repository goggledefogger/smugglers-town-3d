/**
 * Stylized 3D rendering of the game's actual collision geometry (buildings, piers, obstacles).
 *
 * In "Game 3D" mode, this replaces photogrammetry meshes so players see the exact 3D
 * collision boxes they interact with — 100% physically coherent, zero invisible walls,
 * zero drive-through-wall mismatch.
 */
import {
  Group, BoxGeometry, InstancedMesh, InstancedBufferAttribute, MeshStandardMaterial, Matrix4, Vector3,
  Quaternion, Color, LineSegments, DataTexture, RGBAFormat, UnsignedByteType,
  type Texture, type WebGLProgramParametersWithUniforms
} from 'three';
import type { BuildingCollider } from '../core/physics/VehicleBody.ts';
import type { Grid } from '../services/tiles/tileColliders.ts';
import { NO_DATA } from '../services/tiles/tileColliders.ts';
import { BUILDING_COLORS } from '../core/theme.ts';
import { FACADE_GLSL } from './facadeShader.ts';

type BuildingMeshMode = 'arcade' | 'textured';

const _mat = new Matrix4();
const _pos = new Vector3();
const _scale = new Vector3();
const _quat = new Quaternion();
const _color = new Color();

const VERTEX_PARS_BUILDING = `
uniform float uHasTexture;
attribute vec4 aRectNX;
attribute vec4 aRectPX;
attribute vec4 aRectNZ;
attribute vec4 aRectPZ;
attribute vec4 aPhotoV0;
varying vec3 vWorldPos;
varying vec3 vBuildingNormal;
varying float vIsRoof;
varying float vLocalNormY;
varying vec2 vAtlasUV;
varying float vHasRect;
varying float vBuildingHeight;
varying vec2 vLocalXZ;
varying vec2 vBuildingFootprint;
varying vec2 vBuildingSeed;
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
vLocalXZ = position.xz;
vBuildingHeight = 1.0;
vBuildingFootprint = vec2(10.0, 10.0);
vBuildingSeed = floor(vWorldPos.xz / 8.0);
#ifdef USE_INSTANCING
  vBuildingHeight = length(instanceMatrix[1].xyz);
  vBuildingFootprint = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[2].xyz));
  vBuildingSeed = floor((modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xz / 8.0);
#endif
// Painted 3D: each wall face's photo lives in an atlas rectangle (x, y, w, h in atlas UV,
// w < 0 = not painted). u runs the way the face camera's right vector runs: +z on the -x
// face, -z on +x, -x on -z, +x on +z; v is height
{
  vec4 rect = normal.x < -0.5 ? aRectNX : normal.x > 0.5 ? aRectPX : normal.z < -0.5 ? aRectNZ : aRectPZ;
  // the photo may start part way up: below that a flush neighbour hides the face anyway
  float pv0 = normal.x < -0.5 ? aPhotoV0.x : normal.x > 0.5 ? aPhotoV0.y : normal.z < -0.5 ? aPhotoV0.z : aPhotoV0.w;
  float fu = normal.x < -0.5 ? position.z + 0.5 : normal.x > 0.5 ? 0.5 - position.z : normal.z < -0.5 ? 0.5 - position.x : position.x + 0.5;
  float fv = position.y + 0.5;
  vAtlasUV = rect.xy + vec2(fu, (fv - pv0) / max(0.001, 1.0 - pv0)) * rect.zw;
  vHasRect = (rect.z > 0.0 && abs(normal.y) < 0.5 && fv >= pv0) ? 1.0 : 0.0;
}
`;

const FRAGMENT_PARS_BUILDING = `
uniform sampler2D uSatelliteMap;
uniform sampler2D uAtlas;
uniform float uUseAtlas;
uniform float uFacade;
uniform float uMapSize;
uniform float uHasTexture;
varying vec3 vWorldPos;
varying vec3 vBuildingNormal;
varying float vIsRoof;
varying float vLocalNormY;
varying vec2 vAtlasUV;
varying float vHasRect;
varying float vBuildingHeight;
varying vec2 vLocalXZ;
varying vec2 vBuildingFootprint;
varying vec2 vBuildingSeed;
` + FACADE_GLSL;

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
  float edgeDist = min((0.5 - abs(vLocalXZ.x)) * vBuildingFootprint.x, (0.5 - abs(vLocalXZ.y)) * vBuildingFootprint.y);
  if (vIsRoof > 0.5) {
    bestFill = uFacade > 0.5 ? metroRoof(sat.rgb, edgeDist) : sat.rgb;
  } else {
    float faceLight = abs(vBuildingNormal.z) > 0.5 ? 0.94 : 0.86;
    if (vBuildingNormal.y < -0.5) faceLight = 0.5;
    float eaveShadow = smoothstep(0.92, 1.0, vLocalNormY);
    float groundPlinth = smoothstep(0.08, 0.0, vLocalNormY);
    float verticalAO = (1.0 - 0.22 * eaveShadow) * (1.0 - 0.32 * groundPlinth);
    // linear values: 0.2 lands near mid grey once tone mapped and encoded, about the
    // brightness of a photographed concrete wall
    bestFill = mix(vec3(0.21, 0.20, 0.19), sat.rgb, 0.35) * faceLight * verticalAO;
    // Painted 3D: the face's photo where the bake saw tiles, the fill where it saw nothing
    bool painted = false;
    if (uUseAtlas > 0.5 && vHasRect > 0.5) {
      vec4 photo = texture2D(uAtlas, vAtlasUV);
      if (photo.a > 0.5) { bestFill = photo.rgb; painted = true; }
    }
    // Painted Metropolis: the procedural facade where there is no photo, its grid over the photo where there is
    if (uFacade > 0.5) {
      float wallU = abs(vBuildingNormal.z) > 0.5 ? vWorldPos.x : vWorldPos.z;
      float hAbove = vLocalNormY * vBuildingHeight;
      float cornerDist = abs(vBuildingNormal.z) > 0.5 ? (0.5 - abs(vLocalXZ.x)) * vBuildingFootprint.x : (0.5 - abs(vLocalXZ.y)) * vBuildingFootprint.y;
      bestFill = painted
        ? photoDetail(bestFill, wallU, hAbove, vBuildingHeight, vBuildingNormal, vWorldPos)
        : metroWall(wallU, hAbove, vBuildingHeight, vBuildingNormal, vWorldPos, vBuildingSeed, cornerDist);
    }
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

/** A deck island longer than this many cells is an elevated road even if its ramps went unfound. */
const DECK_ROAD_MIN_CELLS = 60;
/** A deck island reaching this close to the loaded area's edge may continue outside it: drawn. */
const DECK_EDGE_CELLS = 2;

/**
 * Which deck cells to draw: every cell of a 4-connected deck component that
 * comes down to ground level somewhere (a ramp), runs off the edge of the
 * loaded area (a bridge whose ramps lie outside it), or is long enough to be
 * an elevated road regardless. The rest are building setbacks and rooftop
 * terraces the classifier read as roadway: downtown they hung in the air as
 * squares over every street. The physics keeps all of them; a slab the car
 * can never reach is only ever seen.
 */
function reachableDecks(
  deckGrid: Float32Array,
  grid: Grid,
  sampleGround?: (x: number, z: number) => number
): Uint8Array {
  const { n, cell, half } = grid;
  const drawn = new Uint8Array(n * n);
  if (!sampleGround) {
    for (let c = 0; c < n * n; c++) drawn[c] = deckGrid[c] !== NO_DATA ? 1 : 0;
    return drawn;
  }
  const seen = new Uint8Array(n * n);
  const comp: number[] = [];
  for (let s0 = 0; s0 < n * n; s0++) {
    if (seen[s0] || deckGrid[s0] === NO_DATA) continue;
    comp.length = 0;
    comp.push(s0);
    seen[s0] = 1;
    let grounded = false, atEdge = false;
    for (let q = 0; q < comp.length; q++) {
      const c = comp[q]!;
      const i = c % n, j = Math.floor(c / n);
      if (deckGrid[c]! <= sampleGround(-half + (i + 0.5) * cell, -half + (j + 0.5) * cell) + 1.5) grounded = true;
      if (i < DECK_EDGE_CELLS || j < DECK_EDGE_CELLS || i >= n - DECK_EDGE_CELLS || j >= n - DECK_EDGE_CELLS) atEdge = true;
      const nbs = [i > 0 ? c - 1 : -1, i < n - 1 ? c + 1 : -1, c - n, c + n];
      for (const nb of nbs) {
        if (nb < 0 || nb >= n * n || seen[nb] || deckGrid[nb] === NO_DATA) continue;
        seen[nb] = 1;
        comp.push(nb);
      }
    }
    if (grounded || atEdge || comp.length >= DECK_ROAD_MIN_CELLS) for (const c of comp) drawn[c] = 1;
  }
  return drawn;
}

export class BuildingMeshView {
  readonly group = new Group();
  private buildingMesh: InstancedMesh | null = null;
  private deckMesh: InstancedMesh | null = null;
  private wireframeMesh: LineSegments | null = null;
  private readonly boxGeo = new BoxGeometry(1, 1, 1);

  // Material uniforms for texture projection
  private readonly uHasTexture = { value: 0.0 };
  private readonly uUseAtlas = { value: 0.0 };
  private readonly uFacade = { value: 0.0 };
  private readonly uMapSize = { value: 5600.0 };
  private readonly dummyTex: DataTexture;
  private readonly uSatelliteMap: { value: Texture };
  private readonly uAtlas: { value: Texture };
  /** Per-instance atlas rects, four faces, (x, y, w, h) in atlas UV; w = -1 until painted. */
  private rects: InstancedBufferAttribute[] | null = null;
  /** Per-instance fraction of the box height where each face's photo starts (four faces). */
  private photoV0: InstancedBufferAttribute | null = null;

  // Modern arcade architectural materials
  private readonly buildingMat: MeshStandardMaterial;
  private readonly deckMat: MeshStandardMaterial;

  constructor() {
    this.group.visible = false;
    this.dummyTex = new DataTexture(new Uint8Array([100, 110, 120, 255]), 1, 1, RGBAFormat, UnsignedByteType);
    this.dummyTex.needsUpdate = true;
    this.uSatelliteMap = { value: this.dummyTex };
    this.uAtlas = { value: this.dummyTex };

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
      shader.uniforms.uUseAtlas = this.uUseAtlas;
      shader.uniforms.uFacade = this.uFacade;
      shader.uniforms.uAtlas = this.uAtlas;
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

  /** Painted 3D: the facade atlas the walls read their photos from; null turns painting off. */
  setAtlas(tex: Texture | null): void {
    this.uAtlas.value = tex ?? this.dummyTex;
    this.uUseAtlas.value = tex ? 1.0 : 0.0;
  }

  /** Painted Metropolis: the procedural facade on unpainted walls, its grid over painted ones, parapets on roofs. */
  setFacade(on: boolean): void {
    this.uFacade.value = on ? 1.0 : 0.0;
  }

  get facade(): boolean {
    return this.uFacade.value > 0.5;
  }

  /**
   * A face's photo landed in the atlas: give box `i`'s face its rectangle
   * (texels, atlas `size` square). Face order: -x, +x, -z, +z.
   */
  setFaceRect(i: number, face: 0 | 1 | 2 | 3, x: number, y: number, w: number, h: number, size: number, pv0 = 0): void {
    const attr = this.rects?.[face];
    if (!attr || i >= attr.count || !this.photoV0) return;
    attr.setXYZW(i, x / size, y / size, w / size, h / size);
    attr.needsUpdate = true;
    this.photoV0.setComponent(i, face, pv0);
    this.photoV0.needsUpdate = true;
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
      this.update(this.lastColliders, this.lastDeckGrid, this.lastGrid, sampleGround);
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
    sampleGround?: (x: number, z: number) => number
  ): void {
    this.lastColliders = colliders;
    this.lastDeckGrid = deckGrid;
    this.lastGrid = grid;

    this.dispose();

    // 1. Build building boxes
    const count = colliders.length;
    if (count > 0) {
      // own geometry per mesh: the atlas rects are per-instance attributes on it
      const geo = this.boxGeo.clone();
      const names = ['aRectNX', 'aRectPX', 'aRectNZ', 'aRectPZ'] as const;
      this.rects = names.map(name => {
        const data = new Float32Array(count * 4);
        for (let k = 0; k < count; k++) data[k * 4 + 2] = -1;
        const attr = new InstancedBufferAttribute(data, 4);
        geo.setAttribute(name, attr);
        return attr;
      });
      this.photoV0 = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
      geo.setAttribute('aPhotoV0', this.photoV0);
      const mesh = new InstancedMesh(geo, this.buildingMat, count);
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
      this.buildingMesh = mesh;
      this.group.add(mesh);
    }

    // 2. Build elevated bridge decks and ramps from deckGrid
    if (deckGrid && grid) {
      const { n, cell, half } = grid;
      const drawn = reachableDecks(deckGrid, grid, sampleGround);
      const deckIndices: number[] = [];
      for (let c = 0; c < n * n; c++) {
        if (deckGrid[c] !== NO_DATA && drawn[c]) deckIndices.push(c);
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

  clear(): void {
    this.dispose();
  }

  dispose(): void {
    if (this.buildingMesh) {
      this.group.remove(this.buildingMesh);
      this.buildingMesh.geometry.dispose();
      this.buildingMesh.dispose();
      this.buildingMesh = null;
      this.rects = null;
      this.photoV0 = null;
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
