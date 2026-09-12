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
varying float vIsRoof;
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
`;

const FRAGMENT_PARS_BUILDING = `
uniform sampler2D uSatelliteMap;
uniform float uMapSize;
uniform float uHasTexture;
uniform float uTextureStyle;
varying vec3 vWorldPos;
varying float vIsRoof;
`;

const FRAGMENT_BODY_BUILDING = `
if (uHasTexture > 0.5) {
  vec2 satUV = vec2(
    vWorldPos.x / uMapSize + 0.5,
    0.5 - vWorldPos.z / uMapSize
  );
  vec4 sat = texture2D(uSatelliteMap, clamp(satUV, 0.0, 1.0));
  if (vIsRoof > 0.5) {
    diffuseColor.rgb = sat.rgb;
  } else if (uTextureStyle < 0.5) {
    // Pure top-down planar stretch: edge pixels stretched down straight box walls
    // Baseline minimum brightness so shadowed faces don't crush to pitch black
    diffuseColor.rgb = max(sat.rgb * 0.88, vec3(0.12, 0.14, 0.18));
  } else {
    // Hybrid facade: rooftop satellite + architectural window/floor grid
    float floorLine = step(0.12, fract(vWorldPos.y / 3.5));
    float windowCol = step(0.25, fract(length(vWorldPos.xz) / 2.8));
    float grid = 0.70 + 0.30 * (floorLine * windowCol);
    vec3 facadeBase = max(sat.rgb * 0.85, vec3(0.15, 0.17, 0.22));
    diffuseColor.rgb = facadeBase * grid;
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
      color: 0x323a48,
      roughness: 0.65,
      metalness: 0.15,
      flatShading: true
    });

    this.deckMat = new MeshStandardMaterial({
      color: BUILDING_COLORS.deck,
      roughness: 0.8,
      metalness: 0.05
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

  /**
   * Rebuild instances from the exact active colliders and deck grid.
   * If sampleGround is provided, each building box is firmly anchored into the terrain.
   */
  update(
    colliders: readonly BuildingCollider[],
    deckGrid?: Float32Array,
    grid?: Grid,
    sampleGround?: (x: number, z: number) => number
  ): void {
    this.dispose();

    // 1. Build building boxes
    const count = colliders.length;
    if (count > 0) {
      const mesh = new InstancedMesh(this.boxGeo, this.buildingMat, count);
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      for (let i = 0; i < count; i++) {
        const b = colliders[i]!;
        const cx = (b.min.x + b.max.x) / 2;
        const cz = (b.min.z + b.max.z) / 2;

        let minY = b.min.y;
        if (sampleGround) {
          const groundY = sampleGround(cx, cz);
          // Firmly embed ground-anchored building bases into ground so buildings never hover,
          // but preserve elevated floating overhead obstacles (bridge spans, high canopies)
          if (b.min.y <= groundY + 1.5) {
            minY = Math.min(minY, groundY - 1.5);
          }
        }
        const maxY = b.max.y;

        const sx = Math.max(0.2, b.max.x - b.min.x);
        const sy = Math.max(0.2, maxY - minY);
        const sz = Math.max(0.2, b.max.z - b.min.z);
        const cy = (minY + maxY) / 2;

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
