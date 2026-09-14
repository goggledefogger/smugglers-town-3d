/**
 * Stylized 3D rendering of the game's actual collision geometry (buildings, piers, obstacles).
 *
 * In "Game 3D" mode, this replaces photogrammetry meshes so players see the exact 3D
 * collision boxes they interact with — 100% physically coherent, zero invisible walls,
 * zero drive-through-wall mismatch.
 */
import {
  Group, BoxGeometry, InstancedMesh, MeshStandardMaterial, Matrix4, Vector3, Vector2,
  Quaternion, Color, LineSegments, DataTexture, RGBAFormat, UnsignedByteType,
  type Texture, type WebGLProgramParametersWithUniforms
} from 'three';
import type { BuildingCollider } from '../core/physics/VehicleBody.ts';
import type { Grid } from '../services/tiles/tileColliders.ts';
import { NO_DATA } from '../services/tiles/tileColliders.ts';
import { BUILDING_COLORS } from '../core/theme.ts';

export type BuildingMeshMode = 'arcade' | 'textured';
export type BuildingTextureStyle = 'planar' | 'hybrid' | 'projected-2d' | 'projected-3d' | 'projected' | 'best-3d' | 'map-objects';

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
varying float vBuildingHeight;
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
vBuildingHeight = 1.0;
#ifdef USE_INSTANCING
  vBuildingHeight = length(instanceMatrix[1].xyz);
#endif
`;

const FRAGMENT_PARS_BUILDING = `
uniform sampler2D uSatelliteMap;
uniform sampler2D uTilesMap;
uniform vec2 uResolution;
uniform float uMapSize;
uniform float uHasTexture;
uniform float uTextureStyle;
uniform float uHasSatellite;
varying vec3 vWorldPos;
varying vec3 vBuildingNormal;
varying float vIsRoof;
varying float vLocalNormY;
varying float vBuildingHeight;
`;

const FRAGMENT_BODY_BUILDING = `
if (uHasTexture > 0.5 && uTextureStyle > 4.5) {
  if (vIsRoof < 0.5) {
    float belowRoof = (1.0 - vLocalNormY) * vBuildingHeight;
    float wallU = abs(vBuildingNormal.z) > 0.5 ? vWorldPos.x : vWorldPos.z;
    vec2 bays = vec2(wallU / 3.0, belowRoof / 3.5);
    vec2 edge = abs(fract(bays) - 0.5);
    vec2 aa = max(fwidth(bays), vec2(0.001));
    vec2 aperture = 1.0 - smoothstep(vec2(0.27, 0.24) - aa, vec2(0.27, 0.24) + aa, edge);
    float windows = aperture.x * aperture.y;
    windows *= 1.0 - smoothstep(0.15, 0.5, max(aa.x, aa.y));
    windows *= step(6.0, vBuildingHeight) * step(0.5, belowRoof) * step(0.08, vLocalNormY);
    float contact = smoothstep(0.0, 0.12, vLocalNormY);
    float eave = smoothstep(0.0, 0.6, belowRoof);
    vec3 stone = mix(vec3(0.48, 0.43, 0.36), vec3(0.32, 0.40, 0.46), smoothstep(18.0, 50.0, vBuildingHeight));
    vec3 masonry = mix(diffuseColor.rgb, stone, 0.8) * mix(0.72, 1.0, contact) * mix(0.8, 1.0, eave);
    diffuseColor.rgb = mix(masonry, vec3(0.10, 0.16, 0.21), windows * 0.65);
    // Baked ambient fill keeps shaded facades readable beside sunlit aerial imagery
    totalEmissiveRadiance += diffuseColor.rgb * 0.25;
  }
} else if (uHasTexture > 0.5) {
  vec2 satUV = vec2(
    vWorldPos.x / uMapSize + 0.5,
    0.5 - vWorldPos.z / uMapSize
  );
  vec4 sat = texture2D(uSatelliteMap, clamp(satUV, 0.0, 1.0));

  if (vIsRoof > 0.5) {
    // Rooftop: Pristine satellite aerial imagery with authentic rooftop textures
    diffuseColor.rgb = sat.rgb;
  } else if (uTextureStyle > 3.5) {
    // BEST 3D Mode:
    // Authentic building masonry tone with natural directional sun and ambient occlusion.
    // The authentic 3D photogrammetry imagery (with vertical walls, windows, brick, etc.)
    // is projected directly from uTilesMap in FRAGMENT_OPAQUE_BUILDING.
    float faceLight = abs(vBuildingNormal.z) > 0.5 ? 0.94 : 0.86;
    if (vBuildingNormal.x > 0.5) faceLight = 0.98;
    if (vBuildingNormal.y < -0.5) faceLight = 0.5;

    // Vertical ambient occlusion: soft eave shadow under roof, contact plinth at ground
    float eaveShadow = smoothstep(0.92, 1.0, vLocalNormY);
    float groundPlinth = smoothstep(0.08, 0.0, vLocalNormY);
    float verticalAO = (1.0 - 0.20 * eaveShadow) * (1.0 - 0.30 * groundPlinth);

    #ifdef USE_INSTANCING_COLOR
      vec3 instTone = vColor.rgb;
    #else
      vec3 instTone = vec3(0.68, 0.65, 0.60);
    #endif

    // Authentic building tone matching the building's color palette:
    vec3 baseWall = instTone * faceLight * verticalAO;
    float isPlinth = step(vLocalNormY, 0.04);
    vec3 plinthTone = baseWall * 0.70;
    diffuseColor.rgb = mix(baseWall, plinthTone, isPlinth);
  } else if (uTextureStyle > 1.5) {
    // Projected Modes (both 2D maps and 3D tiles fallback):
    // High-resolution architectural facade structure derived from aerial maps
    float wallU = abs(vBuildingNormal.z) > 0.5 ? vWorldPos.x : vWorldPos.z;
    float wallV = vWorldPos.y;

    // Directional sun and ambient shading per facade
    float faceLight = abs(vBuildingNormal.z) > 0.5 ? 0.94 : 0.86;
    if (vBuildingNormal.y < -0.5) faceLight = 0.5;

    // Vertical ambient occlusion: soft eave shadow under roof, contact plinth at ground
    float eaveShadow = smoothstep(0.92, 1.0, vLocalNormY);
    float groundPlinth = smoothstep(0.08, 0.0, vLocalNormY);
    float verticalAO = (1.0 - 0.22 * eaveShadow) * (1.0 - 0.32 * groundPlinth);

    // Oblique aerial projection: project satellite imagery along facade normal with elevation offset
    vec2 obliqueUV = satUV + vBuildingNormal.xz * (vLocalNormY * 0.0035);
    vec4 obliqueSat = texture2D(uSatelliteMap, clamp(obliqueUV, 0.0, 1.0));

    // Authentic building tone from the real 3D map
    vec3 realMapTone = max(mix(sat.rgb, obliqueSat.rgb, 0.45), vec3(0.18, 0.19, 0.22));

    // Multi-story architectural facade structure
    // Standard commercial/residential story is ~3.5m high
    float storyCoord = wallV / 3.5;
    float storyFrac = fract(storyCoord);
    float isFloorSlab = step(storyFrac, 0.20);

    // Window bays: 2.6m spacing with 0.65m structural masonry piers
    float bayCoord = wallU / 2.6;
    float bayFrac = fract(bayCoord);
    float isMullion = step(bayFrac, 0.25);

    // Window aperture (pane between floor slabs and between mullions)
    float isWindow = (1.0 - isFloorSlab) * (1.0 - isMullion);

    // Subtle per-window interior light variation
    float windowId = sin(floor(storyCoord) * 37.17 + floor(bayCoord) * 73.91);
    float windowVar = fract(windowId * 43758.5453);

    // Architectural reflective glass: sky gradient reflection with specular sheen
    vec3 glassReflection = vec3(0.12, 0.18, 0.26) + vec3(0.06, 0.08, 0.10) * (1.0 - storyFrac);
    if (windowVar > 0.70) {
      // Warm interior ambient light in select windows
      glassReflection += vec3(0.08, 0.06, 0.03);
    }

    // Structural masonry piers and spandrels derived directly from real 3D map
    vec3 wallMasonry = realMapTone * faceLight * verticalAO;
    vec3 floorSlabTone = wallMasonry * 0.82;

    // Ground floor commercial storefront display windows
    float isStorefront = step(vLocalNormY, 0.12);
    vec3 storefrontGlass = vec3(0.08, 0.12, 0.16);

    // Ground foundation plinth (solid concrete/slate base anchoring into the terrain)
    float isPlinth = step(vLocalNormY, 0.05);
    vec3 plinthColor = vec3(0.14, 0.15, 0.17);

    vec3 facade = mix(wallMasonry, floorSlabTone, isFloorSlab * 0.5);
    facade = mix(facade, glassReflection, isWindow * 0.75);
    facade = mix(facade, storefrontGlass, isStorefront * isWindow * 0.6);
    facade = mix(facade, plinthColor, isPlinth * 0.85);

    diffuseColor.rgb = facade;
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

const FRAGMENT_OPAQUE_BUILDING = `
if (uHasTexture > 0.5 && uTextureStyle > 2.5 && uTextureStyle < 4.5) {
  vec2 screenUV = gl_FragCoord.xy / uResolution;
  vec4 tileSample = texture2D(uTilesMap, screenUV);
  if (tileSample.a > 0.04) {
    gl_FragColor.rgb = tileSample.rgb;
  }
}
`;

// Three applies lighting and tone mapping before output color-space conversion
// Aerial roofs already contain daylight, so replace them after tone mapping but before fog/output conversion
const FRAGMENT_MAP_ROOF = `
if (uHasTexture > 0.5 && uTextureStyle > 4.5 && uHasSatellite > 0.5 && vIsRoof > 0.5) {
  vec2 roofUV = vec2(vWorldPos.x / uMapSize + 0.5, 0.5 - vWorldPos.z / uMapSize);
  if (all(greaterThanEqual(roofUV, vec2(0.0))) && all(lessThanEqual(roofUV, vec2(1.0)))) {
    gl_FragColor.rgb = texture2D(uSatelliteMap, roofUV).rgb;
  }
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
  private readonly uHasSatellite = { value: 0.0 };
  private readonly uTextureStyle = { value: 0.0 }; // 0 planar, 1 hybrid, 2 projected-2d, 3 projected-3d, 4 best-3d, 5 map-objects
  private readonly uMapSize = { value: 5600.0 };
  private readonly uResolution = { value: new Vector2(1280, 720) };
  private readonly dummyTex: DataTexture;
  private readonly uSatelliteMap: { value: Texture };
  private readonly uTilesMap: { value: Texture };

  // Modern arcade architectural materials
  private readonly buildingMat: MeshStandardMaterial;
  private readonly deckMat: MeshStandardMaterial;

  constructor() {
    this.group.visible = false;
    this.dummyTex = new DataTexture(new Uint8Array([100, 110, 120, 255]), 1, 1, RGBAFormat, UnsignedByteType);
    this.dummyTex.needsUpdate = true;
    this.uSatelliteMap = { value: this.dummyTex };
    this.uTilesMap = { value: this.dummyTex };

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
      shader.uniforms.uHasSatellite = this.uHasSatellite;
      shader.uniforms.uTextureStyle = this.uTextureStyle;
      shader.uniforms.uSatelliteMap = this.uSatelliteMap;
      shader.uniforms.uTilesMap = this.uTilesMap;
      shader.uniforms.uResolution = this.uResolution;
      shader.uniforms.uMapSize = this.uMapSize;

      shader.vertexShader = VERTEX_PARS_BUILDING + shader.vertexShader
        .replace('#include <project_vertex>', '#include <project_vertex>\n' + VERTEX_BODY_BUILDING);

      shader.fragmentShader = FRAGMENT_PARS_BUILDING + shader.fragmentShader
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAGMENT_BODY_BUILDING)
        .replace('#include <opaque_fragment>', '#include <opaque_fragment>\n' + FRAGMENT_OPAQUE_BUILDING)
        .replace('#include <tonemapping_fragment>', '#include <tonemapping_fragment>\n' + FRAGMENT_MAP_ROOF);
    };
  }

  setMode(mode: BuildingMeshMode): void {
    this.uHasTexture.value = mode === 'textured' ? 1.0 : 0.0;
  }

  getMode(): BuildingMeshMode {
    return this.uHasTexture.value > 0.5 ? 'textured' : 'arcade';
  }

  private _style: BuildingTextureStyle = 'planar';

  setTextureStyle(style: BuildingTextureStyle): void {
    this._style = style;
    if (style === 'map-objects') {
      this.uTextureStyle.value = 5.0;
    } else if (style === 'best-3d') {
      this.uTextureStyle.value = 4.0;
    } else if (style === 'projected-3d') {
      this.uTextureStyle.value = 3.0;
    } else if (style === 'projected-2d' || style === 'projected') {
      this.uTextureStyle.value = 2.0;
    } else if (style === 'hybrid') {
      this.uTextureStyle.value = 1.0;
    } else {
      this.uTextureStyle.value = 0.0;
    }
  }

  getTextureStyle(): BuildingTextureStyle {
    return this._style;
  }

  setTexture(tex: Texture | null, mapSize: number): void {
    this.uSatelliteMap.value = tex ?? this.dummyTex;
    this.uHasSatellite.value = tex ? 1.0 : 0.0;
    this.uMapSize.value = mapSize;
  }

  setTilesTexture(tex: Texture | null, resolution?: Vector2): void {
    this.uTilesMap.value = tex ?? this.dummyTex;
    if (resolution) {
      this.uResolution.value.copy(resolution);
    }
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
