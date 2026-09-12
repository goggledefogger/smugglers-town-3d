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
export type BuildingTextureStyle = 'planar' | 'hybrid';

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
uniform float uTextureStyle;
varying vec3 vWorldPos;
varying vec3 vBuildingNormal;
varying float vIsRoof;
varying float vLocalNormY;
`;

const FRAGMENT_BODY_BUILDING = `
if (uHasTexture > 0.5) {
  vec2 satUV = vec2(
    vWorldPos.x / uMapSize + 0.5,
    0.5 - vWorldPos.z / uMapSize
  );
  vec4 sat = texture2D(uSatelliteMap, clamp(satUV, 0.0, 1.0));
  if (vIsRoof > 0.5) {
    // Rooftop: Pristine satellite aerial imagery with authentic rooftop textures
    diffuseColor.rgb = sat.rgb;
  } else {
    // Wall facades: Grounded directly in real aerial imagery of the building
    // 1. Directional sun and ambient shading per facade
    float faceLight = abs(vBuildingNormal.z) > 0.5 ? 0.94 : 0.86;
    if (vBuildingNormal.y < -0.5) faceLight = 0.5;

    // 2. Vertical ambient occlusion: soft eave shadow under roof, contact plinth at ground
    float eaveShadow = smoothstep(0.92, 1.0, vLocalNormY);
    float groundPlinth = smoothstep(0.08, 0.0, vLocalNormY);
    float verticalAO = (1.0 - 0.22 * eaveShadow) * (1.0 - 0.32 * groundPlinth);

    // Instance masonry tone (warm sandstone/limestone/stucco/terracotta from building color palette)
    #ifdef USE_INSTANCING_COLOR
      vec3 instTone = vColor.rgb;
    #else
      vec3 instTone = vec3(0.68, 0.65, 0.60);
    #endif

    // Blend genuine satellite imagery with warm, vibrant building masonry tone
    // so walls are NEVER a hollow black void, but a rich, warm, color-mapped facade
    vec3 wallTone = mix(instTone, sat.rgb, 0.5);
    wallTone = max(wallTone, instTone * 0.7);

    vec3 baseWall = wallTone * faceLight * verticalAO;

    if (uTextureStyle < 0.5) {
      // Planar mode: Authentic satellite texture draped with natural ambient occlusion
      diffuseColor.rgb = baseWall;
    } else {
      // Hybrid mode: Real satellite imagery modulated with subtle architectural floor relief
      // Architectural story height ~3.5m
      float storyFrac = fract(vWorldPos.y / 3.5);
      float isFloorBand = step(storyFrac, 0.18);

      // Subtle horizontal facade frieze derived from building's own tone
      vec3 floorBandColor = baseWall * 0.86;
      vec3 facadeColor = mix(baseWall, floorBandColor, isFloorBand * 0.35);

      // Solid concrete/slate foundation plinth contact at terrain
      vec3 plinthTone = mix(facadeColor, instTone * 0.45, groundPlinth * 0.55);
      diffuseColor.rgb = plinthTone;
    }
  }
}
`;

export class BuildingMeshView {
  readonly group = new Group();
  private buildingMesh: InstancedMesh | null = null;
  private deckMesh: InstancedMesh | null = null;
  private wireframeMesh: LineSegments | null = null;
  private readonly boxGeo = new BoxGeometry(1, 1, 1);

  // Material uniforms for texture projection
  private readonly uHasTexture = { value: 0.0 };
  private readonly uTextureStyle = { value: 0.0 }; // 0 = planar, 1 = hybrid
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
      shader.uniforms.uTextureStyle = this.uTextureStyle;
      shader.uniforms.uSatelliteMap = this.uSatelliteMap;
      shader.uniforms.uMapSize = this.uMapSize;

      shader.vertexShader = VERTEX_PARS_BUILDING + shader.vertexShader
        .replace('#include <project_vertex>', '#include <project_vertex>\n' + VERTEX_BODY_BUILDING);

      shader.fragmentShader = FRAGMENT_PARS_BUILDING + shader.fragmentShader
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAGMENT_BODY_BUILDING);
    };
  }

  setMode(mode: BuildingMeshMode): void {
    this.uHasTexture.value = mode === 'textured' ? 1.0 : 0.0;
  }

  getMode(): BuildingMeshMode {
    return this.uHasTexture.value > 0.5 ? 'textured' : 'arcade';
  }

  setTextureStyle(style: BuildingTextureStyle): void {
    this.uTextureStyle.value = style === 'hybrid' ? 1.0 : 0.0;
  }

  getTextureStyle(): BuildingTextureStyle {
    return this.uTextureStyle.value > 0.5 ? 'hybrid' : 'planar';
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
  private lastDeckGrid?: Float32Array;
  private lastGrid?: Grid;
  private lastSampleGround?: (x: number, z: number) => number;

  /**
   * Refresh building heights when the terrain heightfield refines in the background.
   */
  refreshHeights(sampleGround: (x: number, z: number) => number): void {
    this.lastSampleGround = sampleGround;
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
    this.lastSampleGround = sampleGround;

    this.dispose();

    // 1. Build building boxes
    const count = colliders.length;
    if (count > 0) {
      const mesh = new InstancedMesh(this.boxGeo, this.buildingMat, count);
      mesh.castShadow = false; // Perf: avoid rendering thousands of instances in shadow pass
      mesh.receiveShadow = true;

      for (let i = 0; i < count; i++) {
        const b = colliders[i]!;
        const cx = (b.min.x + b.max.x) / 2;
        const cz = (b.min.z + b.max.z) / 2;

        let minY = b.min.y;
        if (sampleGround) {
          // Multi-point footprint sampling (4 corners, 4 perimeter midpoints, 1 center)
          // to account for steep slopes across large building footprints
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
          const maxGround = Math.max(g00, g10, g01, g11, gMidX0, gMidX1, gMidZ0, gMidZ1, gCenter);

          if (b.kind === 'prop') {
            // Props (scattered rocks, obstacles) embed firmly into the local ground
            minY = Math.min(b.min.y, minGround - 0.8);
          } else if (b.min.y <= maxGround + 3.0) {
            // Ground-rooted building: firmly embed foundation at least 2.5m below the lowest
            // downhill terrain point across the entire footprint, completely eliminating hover
            minY = Math.min(b.min.y, minGround - 2.5);
          }
        }
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

  clear(): void {
    this.dispose();
  }

  dispose(): void {
    if (this.buildingMesh) {
      this.group.remove(this.buildingMesh);
      this.buildingMesh.dispose();
      this.buildingMesh = null;
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
