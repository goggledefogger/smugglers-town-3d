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
import { BUILDING_COLORS } from '../core/theme.ts';

export type BuildingMeshMode = 'arcade' | 'textured';
export type BuildingTextureStyle = 'planar' | 'hybrid' | 'projected-2d' | 'projected-3d' | 'projected' | 'best-3d' | 'map-objects' | 'baked-facades' | 'metropolis';

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
varying vec2 vLocalXZ;
varying vec2 vBuildingFootprint;
varying vec3 vBuildingCenter;
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
vBuildingCenter = vWorldPos;
#ifdef USE_INSTANCING
  vBuildingHeight = length(instanceMatrix[1].xyz);
  vBuildingFootprint = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[2].xyz));
  vBuildingCenter = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
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
varying vec2 vLocalXZ;
varying vec2 vBuildingFootprint;
varying vec3 vBuildingCenter;
`;

const FRAGMENT_BODY_BUILDING = `
if (uHasTexture > 0.5 && uTextureStyle > 6.5) {
  if (vIsRoof < 0.5) {
    float belowRoof = (1.0 - vLocalNormY) * vBuildingHeight;
    float heightAboveGround = vLocalNormY * vBuildingHeight;
    float wallU = abs(vBuildingNormal.z) > 0.5 ? vWorldPos.x : vWorldPos.z;

    // Deterministic per-building spatial seed
    vec2 cellCoord = floor(vBuildingCenter.xz / 8.0);
    float bSeed = fract(sin(dot(cellCoord, vec2(12.9898, 78.233))) * 43758.5453);

    // Architectural Typologies
    vec3 baseWallColor;
    float isTower = step(38.0, vBuildingHeight);
    float isMidRise = step(16.0, vBuildingHeight) * (1.0 - isTower);
    float isLowRise = (1.0 - isTower) * (1.0 - isMidRise);

    if (isTower > 0.5) {
      // Skyscraper: modern reflective glass curtain wall & polished steel
      vec3 towerGlassA = vec3(0.15, 0.22, 0.32); // deep sapphire curtain wall
      vec3 towerGlassB = vec3(0.13, 0.16, 0.20); // smoked obsidian glass
      vec3 towerGlassC = vec3(0.20, 0.25, 0.28); // titanium steel
      baseWallColor = bSeed < 0.35 ? towerGlassA : (bSeed < 0.70 ? towerGlassB : towerGlassC);
    } else if (isMidRise > 0.5) {
      // Mid-Rise: warm limestone, architectural precast concrete, travertine
      vec3 limestone = vec3(0.55, 0.50, 0.43);
      vec3 concrete = vec3(0.46, 0.47, 0.49);
      vec3 sandMasonry = vec3(0.50, 0.44, 0.38);
      baseWallColor = bSeed < 0.35 ? limestone : (bSeed < 0.70 ? concrete : sandMasonry);
    } else {
      // Low-Rise: warm brick, historic brownstone, stucco
      vec3 redBrick = vec3(0.48, 0.25, 0.19);
      vec3 brownstone = vec3(0.41, 0.33, 0.27);
      vec3 warmStucco = vec3(0.50, 0.47, 0.42);
      baseWallColor = bSeed < 0.45 ? redBrick : (bSeed < 0.75 ? brownstone : warmStucco);
    }

    // Story and window bay grid
    float storyHeight = isTower > 0.5 ? 3.6 : 3.2;
    float bayWidth = isTower > 0.5 ? 2.2 : 2.8;
    vec2 bays = vec2(wallU / bayWidth, belowRoof / storyHeight);
    vec2 roomCoord = floor(bays);
    vec2 edge = abs(fract(bays) - 0.5);
    vec2 aa = max(fwidth(bays), vec2(0.001));

    // Antialiased window aperture
    vec2 apertureTarget = isTower > 0.5 ? vec2(0.38, 0.34) : vec2(0.28, 0.24);
    vec2 aperture = 1.0 - smoothstep(apertureTarget - aa, apertureTarget + aa, edge);
    float windows = aperture.x * aperture.y;
    windows *= 1.0 - smoothstep(0.15, 0.5, max(aa.x, aa.y));
    windows *= step(5.5, vBuildingHeight) * step(0.4, belowRoof);

    // View angle and distance attenuation to eliminate Moiré and grazing flicker
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float viewDot = clamp(abs(dot(vBuildingNormal, viewDir)), 0.0, 1.0);
    float dist = length(vWorldPos - cameraPosition);
    float distFade = 1.0 - smoothstep(140.0, 320.0, dist);
    float angleFade = smoothstep(0.10, 0.35, viewDot);
    windows *= distFade * angleFade;

    // Room interior lighting
    float roomHash = fract(sin(dot(roomCoord + cellCoord * 17.0, vec2(37.17, 73.91))) * 43758.5453);
    vec3 warmLight = vec3(1.0, 0.85, 0.55);
    vec3 coolLight = vec3(0.75, 0.90, 1.0);
    vec3 darkGlass = mix(vec3(0.07, 0.10, 0.14), vec3(0.14, 0.20, 0.28), clamp(1.0 - belowRoof / vBuildingHeight, 0.0, 1.0));

    vec3 windowColor;
    float isLit = 0.0;
    if (roomHash > 0.68) {
      windowColor = warmLight * (0.85 + 0.25 * sin(roomHash * 25.0));
      isLit = 1.0;
    } else if (roomHash > 0.54) {
      windowColor = coolLight * 0.90;
      isLit = 0.75;
    } else {
      windowColor = darkGlass;
    }

    // Window mullions (structural crossbar in window pane)
    float mullionX = 1.0 - smoothstep(0.03 - aa.x, 0.03 + aa.x, abs(edge.x - 0.22));
    windowColor = mix(windowColor, baseWallColor * 0.7, mullionX * 0.6);

    // Ambient Occlusion: roof eave & contact plinth
    float contact = smoothstep(0.0, 0.12, vLocalNormY);
    float eave = smoothstep(0.0, 0.6, belowRoof);
    vec3 wallColor = mix(diffuseColor.rgb, baseWallColor, 0.85) * mix(0.72, 1.0, contact) * mix(0.82, 1.0, eave);

    // Driving Eye-Level: Ground-Floor Storefronts & Lobbies (heightAboveGround < 4.2m)
    float isStorefront = (1.0 - step(4.2, heightAboveGround)) * step(0.65, heightAboveGround);
    if (isStorefront > 0.5) {
      // Large commercial glass bay
      vec2 storeBays = vec2(wallU / 3.6, heightAboveGround / 4.2);
      vec2 storeEdge = abs(fract(storeBays) - 0.5);
      vec2 storeAA = max(fwidth(storeBays), vec2(0.001));
      vec2 storeAp = 1.0 - smoothstep(vec2(0.38, 0.32) - storeAA, vec2(0.38, 0.32) + storeAA, storeEdge);
      float storeGlass = storeAp.x * storeAp.y * distFade * angleFade;
      vec3 storeGlow = vec3(0.96, 0.82, 0.58) * 0.85;
      wallColor = mix(wallColor, storeGlow, storeGlass * 0.85);
      totalEmissiveRadiance += storeGlow * storeGlass * 0.40;
    }

    // Foundation Plinth (anchoring building into terrain at heightAboveGround < 0.65m)
    float isPlinth = 1.0 - step(0.65, heightAboveGround);
    vec3 plinthTone = vec3(0.18, 0.19, 0.21);
    wallColor = mix(wallColor, plinthTone, isPlinth * 0.90);

    // Corner Edge AO for Drift Readability at 180 km/h
    float cornerDist = (abs(vBuildingNormal.z) > 0.5)
      ? (0.5 - abs(vLocalXZ.x)) * vBuildingFootprint.x
      : (0.5 - abs(vLocalXZ.y)) * vBuildingFootprint.y;
    float cornerAO = smoothstep(0.0, 0.65, cornerDist);
    wallColor *= mix(0.70, 1.0, cornerAO);

    // Combine wall and window
    if (isStorefront < 0.5 && isPlinth < 0.5) {
      diffuseColor.rgb = mix(wallColor, windowColor, windows * 0.78);
      totalEmissiveRadiance += windowColor * windows * isLit * 0.35;
    } else {
      diffuseColor.rgb = wallColor;
    }

    // Baked ambient fill keeps shaded facades readable beside sunlit aerial imagery
    totalEmissiveRadiance += diffuseColor.rgb * 0.22;
  }
} else if (uHasTexture > 0.5 && uTextureStyle > 4.5) {
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
    if (uTextureStyle > 5.5) windows = 0.0;

    // View angle and distance attenuation to eliminate procedural Moiré and grazing-angle flicker
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float viewDot = clamp(abs(dot(vBuildingNormal, viewDir)), 0.0, 1.0);
    float dist = length(vWorldPos - cameraPosition);
    float distFade = 1.0 - smoothstep(140.0, 320.0, dist);
    float angleFade = smoothstep(0.10, 0.35, viewDot);
    windows *= distFade * angleFade;

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

const FRAGMENT_MAP_ROOF = `
if (uHasTexture > 0.5 && uTextureStyle > 4.5 && uHasSatellite > 0.5 && vIsRoof > 0.5) {
  vec2 roofUV = vec2(vWorldPos.x / uMapSize + 0.5, 0.5 - vWorldPos.z / uMapSize);
  if (all(greaterThanEqual(roofUV, vec2(0.0))) && all(lessThanEqual(roofUV, vec2(1.0)))) {
    vec3 satRoof = texture2D(uSatelliteMap, roofUV).rgb;
    if (uTextureStyle > 6.5) {
      // Metropolis mode: frame the satellite roof with an architectural parapet border
      float edgeDist = min((0.5 - abs(vLocalXZ.x)) * vBuildingFootprint.x, (0.5 - abs(vLocalXZ.y)) * vBuildingFootprint.y);
      float isParapet = 1.0 - smoothstep(0.55, 0.75, edgeDist);
      vec3 parapetTone = vec3(0.24, 0.25, 0.27);
      float innerShadow = smoothstep(0.70, 1.40, edgeDist);
      gl_FragColor.rgb = mix(satRoof * mix(0.75, 1.0, innerShadow), parapetTone, isParapet);
    } else {
      gl_FragColor.rgb = satRoof;
    }
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

  constructor(private readonly onBuildings?: (colliders: readonly BuildingCollider[]) => void) {
    this.group.visible = false;
    this.dummyTex = new DataTexture(new Uint8Array([100, 110, 120, 255]), 1, 1, RGBAFormat, UnsignedByteType);
    this.dummyTex.needsUpdate = true;
    this.uSatelliteMap = { value: this.dummyTex };
    this.uTilesMap = { value: this.dummyTex };

    this.buildingMat = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.65,
      metalness: 0.15,
      flatShading: true
    });

    this.hookMaterial(this.buildingMat, 'building-mesh-view');
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
    if (style === 'metropolis') {
      this.uTextureStyle.value = 7.0;
    } else if (style === 'baked-facades') {
      this.uTextureStyle.value = 6.0;
    } else if (style === 'map-objects') {
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

  /**
   * Refresh building heights when the terrain heightfield refines in the background.
   */
  refreshHeights(sampleGround: (x: number, z: number) => number): void {
    if (this.lastColliders.length > 0) {
      this.update(this.lastColliders, undefined, undefined, sampleGround);
    }
  }

  /**
   * Rebuild instances from the exact active physical colliders.
   * If sampleGround is provided, each building box is firmly anchored into the terrain
   * with multi-point footprint sampling so buildings never hover on steep hills.
   *
   * Guarantees 100% 1:1 parity between visual geometry and physical collisions:
   * every box rendered is an active physical collider. Stale uncollided floating
   * slabs (deckMesh) have been eliminated.
   */
  update(
    colliders: readonly BuildingCollider[],
    _deckGrid?: Float32Array,
    _grid?: Grid,
    sampleGround?: (x: number, z: number) => number
  ): void {
    this.lastColliders = colliders;

    const oldBuildingMesh = this.buildingMesh;

    // 1. Build building boxes
    const count = colliders.length;
    const rendered: BuildingCollider[] = [];
    if (count > 0) {
      const mesh = new InstancedMesh(this.boxGeo, this.buildingMat, count);
      mesh.castShadow = false; // Perf: avoid rendering thousands of instances in shadow pass
      mesh.receiveShadow = true;

      for (let i = 0; i < count; i++) {
        const raw = colliders[i]!;
        const b = anchorCollider(raw, sampleGround);
        rendered.push(b);
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
    } else {
      this.buildingMesh = null;
    }
    this.onBuildings?.(rendered);

    // Dispose old instances after new ones are added to prevent any 1-frame gap
    if (oldBuildingMesh) {
      this.group.remove(oldBuildingMesh);
      oldBuildingMesh.dispose();
    }
  }

  clear(): void {
    this.dispose();
    this.lastColliders = [];
    this.onBuildings?.([]);
  }

  dispose(): void {
    if (this.buildingMesh) {
      this.group.remove(this.buildingMesh);
      this.buildingMesh.dispose();
      this.buildingMesh = null;
    }
    if (this.wireframeMesh) {
      this.group.remove(this.wireframeMesh);
      this.wireframeMesh.geometry.dispose();
      this.wireframeMesh = null;
    }
  }
}
