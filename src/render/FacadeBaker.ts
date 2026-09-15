import {
  Box3, BufferAttribute, BufferGeometry, Camera, ClampToEdgeWrapping, Color,
  DoubleSide, DynamicDrawUsage, Group, LinearFilter, LinearSRGBColorSpace,
  Mesh, MeshBasicMaterial, MeshStandardMaterial, NoBlending, NoToneMapping,
  OrthographicCamera, RGBAFormat, Scene, UnsignedByteType, Vector2, Vector3,
  Vector4, WebGLRenderTarget,
  type Material, type Texture, type WebGLRenderer
} from 'three';
import type { BuildingCollider } from '../core/physics/VehicleBody.ts';

const ATLAS_SIZE = 2048;
const SLOT_SIZE = 256;
const SLOT_COUNT = 64;
const GUTTER = 2;
const INNER_SIZE = SLOT_SIZE - 2 * GUTTER;
const LOAD_RADIUS = 220;
const RETAIN_RADIUS = 320;
const CAPTURE_INTERVAL = 80;
const SOURCE_INTERVAL = 500;
const SELECTION_INTERVAL = 250;
const MAX_DRAWS = 24;
const MAX_TRIANGLES = 120_000;

export interface FacadeFace {
  readonly key: string;
  readonly center: Vector3;
  readonly normal: Vector3;
  readonly right: Vector3;
  readonly width: number;
  readonly height: number;
  readonly inward: number;
  readonly outward: number;
  readonly bounds: Box3;
}

/** Four outward-facing, world-fixed destination walls, excluding roofs and props */
export function buildingFacadeFaces(box: BuildingCollider, cellSize = 10): FacadeFace[] {
  const { min, max } = box;
  if (box.kind === 'prop' || ![min.x, min.y, min.z, max.x, max.y, max.z].every(Number.isFinite)
    || max.x <= min.x || max.y <= min.y || max.z <= min.z) return [];
  const tolerance = Math.min(14, Math.max(2, (Number.isFinite(cellSize) ? cellSize : 10) + 2));
  const key = [...min.toArray(), ...max.toArray()].join(',');
  return [new Vector3(1, 0, 0), new Vector3(-1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, 0, -1)]
    .map((normal, direction) => {
      const xFace = normal.x !== 0;
      const thickness = xFace ? max.x - min.x : max.z - min.z;
      const width = xFace ? max.z - min.z : max.x - min.x;
      const height = max.y - min.y;
      const center = min.clone().add(max).multiplyScalar(0.5).addScaledVector(normal, thickness / 2);
      const right = new Vector3(normal.z, 0, -normal.x);
      const inward = thickness;
      const outward = tolerance;
      const bounds = new Box3();
      for (const u of [-1, 1]) for (const v of [-1, 1]) for (const depth of [-inward, outward]) {
        bounds.expandByPoint(center.clone().addScaledVector(right, u * width / 2)
          .add(new Vector3(0, v * height / 2, 0)).addScaledVector(normal, depth));
      }
      bounds.expandByScalar(Math.max(width, height) / INNER_SIZE);
      return { key: `${key}:${direction}:${inward}:${outward}`, center, normal, right, width, height, inward, outward, bounds };
    });
}

interface Source {
  readonly mesh: Mesh;
  readonly signature: string;
  readonly proxy: Mesh<BufferGeometry, MeshBasicMaterial | MeshBasicMaterial[]>;
  readonly bounds: Box3;
  readonly draws: number;
  readonly triangles: number;
}

interface Resident {
  readonly face: FacadeFace;
  readonly slot: number;
  sources: Source[];
  wanted: string;
  baked: string | null;
  blocked: boolean;
}

export interface FacadeBakerStats {
  readonly faces: number;
  /** Completed captures, not a measurement of nonempty photographic coverage */
  readonly bakedFaces: number;
  readonly captures: number;
  readonly pending: number;
  readonly sourceMeshes: number;
  readonly budgetSkipped: number;
  readonly captureErrors: number;
  readonly lastError: string | null;
}

function photoMaterial(material: Material, geometry: BufferGeometry): material is MeshBasicMaterial | MeshStandardMaterial {
  if (!(material instanceof MeshBasicMaterial || material instanceof MeshStandardMaterial)
    || !material.visible || !material.map || (material.transparent && material.alphaTest === 0)) return false;
  return [material.map, material.alphaMap].every(map => {
    if (!map) return true;
    const uv = geometry.getAttribute(map.channel === 0 ? 'uv' : `uv${map.channel}`);
    return Number.isInteger(map.channel) && map.channel >= 0 && map.channel <= 3 && uv?.itemSize >= 2;
  });
}

function textureSignature(map: Texture | null): string {
  if (!map) return '';
  return [map.uuid, map.version, map.channel, map.colorSpace, map.flipY, map.matrixAutoUpdate,
    ...map.offset.toArray(), ...map.repeat.toArray(), ...map.center.toArray(), map.rotation,
    ...(map.matrixAutoUpdate ? [] : map.matrix.elements)].join(',');
}

function sourceSignature(mesh: Mesh): string {
  const geometry = mesh.geometry;
  const attributes = Object.entries(geometry.attributes).map(([name, attribute]) => {
    const version = attribute instanceof BufferAttribute ? attribute.version : attribute.data.version;
    return `${name}:${attribute.count}:${version}`;
  });
  const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(material => {
    if (!photoMaterial(material, geometry)) return `${material.uuid}:unsupported`;
    return [material.uuid, material.version, ...material.color.toArray(), material.opacity,
      material.vertexColors, material.alphaTest, textureSignature(material.map), textureSignature(material.alphaMap)].join('/');
  });
  return [mesh.uuid, geometry.uuid, geometry.index?.version, geometry.index?.count,
    geometry.drawRange.start, geometry.drawRange.count,
    ...geometry.groups.map(g => `${g.start}:${g.count}:${g.materialIndex}`),
    ...attributes, ...materials, ...mesh.matrixWorld.elements].join('|');
}

function distanceToFace(face: FacadeFace, point: Vector3): number {
  const dx = point.x - face.center.x, dy = point.y - face.center.y, dz = point.z - face.center.z;
  const horizontal = Math.max(0, Math.abs(dx * face.right.x + dz * face.right.z) - face.width / 2);
  const vertical = Math.max(0, Math.abs(dy) - face.height / 2);
  return Math.hypot(horizontal, vertical, dx * face.normal.x + dz * face.normal.z);
}

function priority(face: FacadeFace, point: Vector3): number {
  const facing = (point.x - face.center.x) * face.normal.x + (point.z - face.center.z) * face.normal.z;
  return distanceToFace(face, point) + (facing <= 0 ? 40 : 0);
}

export class FacadeBaker {
  readonly group = new Group();
  private root: Group | null = null;
  private readonly sources = new Map<Mesh, Source>();
  private faces = new Map<string, FacadeFace>();
  private readonly residents = new Map<string, Resident>();
  private atlas: WebGLRenderTarget | null = null;
  private readonly scene = new Scene();
  private readonly faceCamera = new OrthographicCamera();
  private readonly cameraPosition = new Vector3();
  private readonly geometry = new BufferGeometry();
  private readonly positions = new BufferAttribute(new Float32Array(SLOT_COUNT * 12), 3).setUsage(DynamicDrawUsage);
  private readonly uvs = new BufferAttribute(new Float32Array(SLOT_COUNT * 8), 2).setUsage(DynamicDrawUsage);
  private readonly material = new MeshBasicMaterial({
    toneMapped: false, alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
  });
  private readonly overlay = new Mesh(this.geometry, this.material);
  private readonly uniforms = {
    uFacadeCenter: { value: new Vector3() },
    uFacadeNormal: { value: new Vector3() },
    uFacadeSlab: { value: new Vector2() }
  };
  private lastSourcesAt = -Infinity;
  private lastSelectionAt = -Infinity;
  private lastCaptureAt = -Infinity;
  private captures = 0;
  private captureErrors = 0;
  private budgetSkipped = 0;
  private lastError: string | null = null;

  constructor(private readonly renderer: WebGLRenderer) {
    this.group.name = 'Baked Facades';
    this.group.visible = false;
    this.geometry.setAttribute('position', this.positions);
    this.geometry.setAttribute('uv', this.uvs);
    const indices: number[] = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const v = i * 4;
      indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
    }
    this.geometry.setIndex(indices);
    this.geometry.setDrawRange(0, 0);
    this.group.add(this.overlay);
    this.material.customProgramCacheKey = () => 'baked-facade-overlay-v1';
    this.material.onBeforeCompile = shader => {
      // Linear filtering mixes covered RGB with the atlas's transparent black holes
      // Divide by filtered coverage before discarding alpha, otherwise photo edges darken
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
        #ifdef USE_MAP
          vec4 photo = texture2D(map, vMapUv);
          if (photo.a < 0.5) discard;
          diffuseColor.rgb *= photo.rgb / max(photo.a, 0.0001);
          diffuseColor.a = 1.0;
        #endif
      `);
    };
  }

  get stats(): FacadeBakerStats {
    let bakedFaces = 0, pending = 0;
    for (const entry of this.residents.values()) {
      if (entry.baked !== null) bakedFaces++;
      if (entry.baked !== entry.wanted) pending++;
    }
    return { faces: this.residents.size, bakedFaces, captures: this.captures, pending,
      sourceMeshes: this.sources.size, budgetSkipped: this.budgetSkipped,
      captureErrors: this.captureErrors, lastError: this.lastError };
  }

  setSources(root: Group | null): void {
    if (root === this.root) return;
    this.releaseSources();
    this.releaseAtlas();
    this.root = root;
    this.lastSourcesAt = this.lastSelectionAt = this.lastCaptureAt = -Infinity;
  }

  setBuildings(colliders: readonly BuildingCollider[], cellSize = 10): void {
    const faces = new Map<string, FacadeFace>();
    for (const collider of colliders) for (const face of buildingFacadeFaces(collider, cellSize)) faces.set(face.key, face);
    this.faces = faces;
    let changed = false;
    for (const key of this.residents.keys()) if (!faces.has(key)) {
      this.residents.delete(key);
      changed = true;
    }
    if (changed) this.rebuildOverlay();
    this.lastSelectionAt = -Infinity;
  }

  update(camera: Camera, nowMs: number): void {
    if (!this.root || !Number.isFinite(nowMs)) return;
    camera.getWorldPosition(this.cameraPosition);
    if (nowMs - this.lastSourcesAt >= SOURCE_INTERVAL) {
      this.refreshSources();
      this.lastSourcesAt = nowMs;
      this.lastSelectionAt = -Infinity;
    }
    if (nowMs - this.lastSelectionAt >= SELECTION_INTERVAL) {
      this.selectFaces();
      this.lastSelectionAt = nowMs;
    }
    if (nowMs - this.lastCaptureAt < CAPTURE_INTERVAL) return;
    let next: Resident | null = null;
    let best = Infinity;
    for (const entry of this.residents.values()) {
      if (entry.blocked || entry.sources.length === 0 || entry.baked === entry.wanted) continue;
      const score = priority(entry.face, this.cameraPosition) + (entry.baked !== null ? 80 : 0);
      if (score < best) { next = entry; best = score; }
    }
    if (!next) return;
    if (next.sources.some(source => {
      let parent = source.mesh.parent;
      while (parent && parent !== this.root) parent = parent.parent;
      return parent !== this.root;
    })) {
      this.refreshSources();
      this.lastSourcesAt = nowMs;
      this.selectFaces();
      return;
    }
    this.lastCaptureAt = nowMs;
    try {
      this.capture(next);
      next.baked = next.wanted;
      this.captures++;
      this.lastError = null;
    } catch (error) {
      next.baked = null;
      this.captureErrors++;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.lastCaptureAt = nowMs + 1000;
    }
    this.rebuildOverlay();
  }

  private refreshSources(): void {
    const live = new Set<Mesh>();
    this.root!.updateWorldMatrix(true, true);
    this.root!.traverse(object => {
      if (!(object instanceof Mesh) || 'isSkinnedMesh' in object || 'isInstancedMesh' in object
        || object.morphTargetInfluences?.length || !object.geometry.getAttribute('position')) return;
      live.add(object);
      const signature = sourceSignature(object);
      const previous = this.sources.get(object);
      if (previous?.signature === signature) return;
      if (previous) this.disposeSource(previous);
      this.sources.delete(object);
      const source = this.makeSource(object, signature);
      if (source) this.sources.set(object, source);
    });
    for (const [mesh, source] of this.sources) if (!live.has(mesh)) {
      this.disposeSource(source);
      this.sources.delete(mesh);
    }
  }

  private makeSource(mesh: Mesh, signature: string): Source | null {
    const originals: Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (!originals.some(material => photoMaterial(material, mesh.geometry))) return null;
    const materials = originals.map(original => {
      const material = new MeshBasicMaterial({ toneMapped: false, fog: false, side: DoubleSide, blending: NoBlending });
      if (!photoMaterial(original, mesh.geometry)) {
        material.visible = false;
        return material;
      }
      material.map = original.map;
      material.alphaMap = original.alphaMap;
      material.color.copy(original.color);
      material.opacity = original.opacity;
      material.vertexColors = original.vertexColors;
      material.alphaTest = original.alphaTest;
      material.customProgramCacheKey = () => 'baked-facade-source-v1';
      material.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, this.uniforms);
        shader.vertexShader = 'varying vec3 vFacadeWorld;\n' + shader.vertexShader.replace(
          '#include <project_vertex>', '#include <project_vertex>\nvFacadeWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = `
          varying vec3 vFacadeWorld;
          uniform vec3 uFacadeCenter;
          uniform vec3 uFacadeNormal;
          uniform vec2 uFacadeSlab;
        ` + shader.fragmentShader.replace('#include <clipping_planes_fragment>', `
          #include <clipping_planes_fragment>
          vec3 geometricNormal = cross(dFdx(vFacadeWorld), dFdy(vFacadeWorld));
          float normalLength = length(geometricNormal);
          if (!gl_FrontFacing || normalLength < 0.000001) discard;
          geometricNormal /= normalLength;
          if (abs(geometricNormal.y) > 0.55 || dot(geometricNormal, uFacadeNormal) < 0.5) discard;
          float wallDistance = dot(vFacadeWorld - uFacadeCenter, uFacadeNormal);
          if (wallDistance < -uFacadeSlab.x || wallDistance > uFacadeSlab.y) discard;
          gl_FragDepth = 0.99999 * abs(wallDistance) / max(uFacadeSlab.x, uFacadeSlab.y);
        `).replace('#include <opaque_fragment>', `
          #include <opaque_fragment>
          gl_FragColor.a = 1.0;
        `);
      };
      return material;
    });
    const geometry = mesh.geometry;
    const count = geometry.index?.count ?? geometry.getAttribute('position').count;
    const groups = Array.isArray(mesh.material) ? geometry.groups : [{ start: 0, count, materialIndex: 0 }];
    let draws = 0, triangles = 0;
    for (const group of groups) {
      if (!materials[group.materialIndex ?? 0]?.visible) continue;
      const start = Math.max(group.start, geometry.drawRange.start);
      const end = Math.min(count, group.start + group.count, geometry.drawRange.start + geometry.drawRange.count);
      if (end > start) { draws++; triangles += Math.ceil((end - start) / 3); }
    }
    if (draws === 0) { for (const material of materials) material.dispose(); return null; }
    const proxy = new Mesh(geometry, Array.isArray(mesh.material) ? materials : materials[0]!);
    proxy.matrixAutoUpdate = false;
    proxy.matrix.copy(mesh.matrixWorld);
    proxy.frustumCulled = false;
    const bounds = new Box3(), point = new Vector3();
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) bounds.expandByPoint(point.fromBufferAttribute(position, i));
    bounds.applyMatrix4(mesh.matrixWorld);
    return { mesh, signature, proxy, bounds, draws, triangles };
  }

  private candidates(face: FacadeFace): { sources: Source[]; wanted: string; blocked: boolean } {
    const sources = [...this.sources.values()].filter(source => source.bounds.intersectsBox(face.bounds))
      .sort((a, b) => a.signature.localeCompare(b.signature));
    const draws = sources.reduce((sum, source) => sum + source.draws, 0);
    const triangles = sources.reduce((sum, source) => sum + source.triangles, 0);
    return { sources, wanted: sources.map(source => source.signature).join(';'), blocked: draws > MAX_DRAWS || triangles > MAX_TRIANGLES };
  }

  private selectFaces(): void {
    let changed = false;
    this.budgetSkipped = 0;
    for (const [key, entry] of this.residents) {
      if (distanceToFace(entry.face, this.cameraPosition) > RETAIN_RADIUS) {
        this.residents.delete(key);
        changed = true;
      } else {
        Object.assign(entry, this.candidates(entry.face));
        if (entry.blocked) this.budgetSkipped++;
      }
    }
    const nearby = [...this.faces.values()].filter(face => !this.residents.has(face.key)
      && distanceToFace(face, this.cameraPosition) <= LOAD_RADIUS)
      .sort((a, b) => priority(a, this.cameraPosition) - priority(b, this.cameraPosition) || a.key.localeCompare(b.key));
    for (const face of nearby) {
      let victim: Resident | null = null;
      if (this.residents.size === SLOT_COUNT) {
        for (const entry of this.residents.values()) {
          if (!victim || distanceToFace(entry.face, this.cameraPosition) > distanceToFace(victim.face, this.cameraPosition)) victim = entry;
        }
        if (!victim || distanceToFace(face, this.cameraPosition) + 60 >= distanceToFace(victim.face, this.cameraPosition)) continue;
      }
      const candidates = this.candidates(face);
      if (candidates.blocked) { this.budgetSkipped++; continue; }
      if (candidates.sources.length === 0) continue;
      if (victim) this.residents.delete(victim.face.key);
      const used = new Set([...this.residents.values()].map(entry => entry.slot));
      let slot = 0;
      while (used.has(slot)) slot++;
      this.residents.set(face.key, { face, slot, ...candidates, baked: null });
      changed = true;
    }
    if (changed) this.rebuildOverlay();
  }

  private capture(entry: Resident): void {
    if (!this.atlas) {
      this.atlas = new WebGLRenderTarget(ATLAS_SIZE, ATLAS_SIZE, {
        format: RGBAFormat, type: UnsignedByteType, colorSpace: LinearSRGBColorSpace,
        minFilter: LinearFilter, magFilter: LinearFilter, wrapS: ClampToEdgeWrapping, wrapT: ClampToEdgeWrapping,
        generateMipmaps: false, depthBuffer: true, stencilBuffer: false, samples: 0
      });
      this.atlas.texture.name = 'Baked Facades atlas';
      this.material.map = this.atlas.texture;
      this.material.needsUpdate = true;
    }
    const atlas = this.atlas;
    const face = entry.face;
    const camera = this.faceCamera;
    const expand = INNER_SIZE / (INNER_SIZE - 1);
    camera.left = -face.width * expand / 2;
    camera.right = face.width * expand / 2;
    camera.bottom = -face.height * expand / 2;
    camera.top = face.height * expand / 2;
    camera.near = 0.5;
    camera.far = face.outward + face.inward + 2;
    camera.position.copy(face.center).addScaledVector(face.normal, face.outward + 1);
    camera.up.set(0, 1, 0);
    camera.lookAt(face.center);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    this.uniforms.uFacadeCenter.value.copy(face.center);
    this.uniforms.uFacadeNormal.value.copy(face.normal);
    this.uniforms.uFacadeSlab.value.set(face.inward, face.outward);

    const r = this.renderer;
    const target = r.getRenderTarget(), cube = r.getActiveCubeFace(), mip = r.getActiveMipmapLevel();
    const viewport = r.getViewport(new Vector4()), scissor = r.getScissor(new Vector4()), scissorTest = r.getScissorTest();
    const clearColor = r.getClearColor(new Color()), clearAlpha = r.getClearAlpha();
    const autoClear = r.autoClear, autoColor = r.autoClearColor, autoDepth = r.autoClearDepth, autoStencil = r.autoClearStencil;
    const toneMapping = r.toneMapping, exposure = r.toneMappingExposure, outputColorSpace = r.outputColorSpace;
    const x = (entry.slot % 8) * SLOT_SIZE, y = Math.floor(entry.slot / 8) * SLOT_SIZE;
    try {
      for (const source of entry.sources) this.scene.add(source.proxy);
      // Three r169's viewport/scissor setters multiply by the canvas pixel ratio
      // Render-target rectangles are already pixels, so configure the atlas directly
      atlas.viewport.set(x + GUTTER, y + GUTTER, INNER_SIZE, INNER_SIZE);
      atlas.scissor.set(x, y, SLOT_SIZE, SLOT_SIZE);
      atlas.scissorTest = true;
      // An explicit clear inherits depth/color write masks from the previous draw
      // Three's auto-clear restores writable buffers before clearing the scissored slot
      r.autoClear = r.autoClearColor = r.autoClearDepth = true;
      r.autoClearStencil = false;
      r.toneMapping = NoToneMapping;
      r.setRenderTarget(atlas);
      r.setClearColor(0x000000, 0);
      r.render(this.scene, camera);
    } finally {
      this.scene.clear();
      r.autoClear = autoClear;
      r.autoClearColor = autoColor;
      r.autoClearDepth = autoDepth;
      r.autoClearStencil = autoStencil;
      r.toneMapping = toneMapping;
      r.toneMappingExposure = exposure;
      r.outputColorSpace = outputColorSpace;
      r.setClearColor(clearColor, clearAlpha);
      r.setViewport(viewport);
      r.setScissor(scissor);
      r.setScissorTest(scissorTest);
      r.setRenderTarget(target, cube, mip);
    }
  }

  private rebuildOverlay(): void {
    let count = 0;
    for (const entry of this.residents.values()) {
      if (entry.baked === null) continue;
      const { face, slot } = entry;
      const x = (slot % 8) * SLOT_SIZE + GUTTER + 0.5;
      const y = Math.floor(slot / 8) * SLOT_SIZE + GUTTER + 0.5;
      for (let corner = 0; corner < 4; corner++) {
        const u = corner === 1 || corner === 2 ? 1 : 0;
        const v = corner >= 2 ? 1 : 0;
        this.positions.setXYZ(count * 4 + corner,
          face.center.x + face.right.x * (u - 0.5) * face.width,
          face.center.y + (v - 0.5) * face.height,
          face.center.z + face.right.z * (u - 0.5) * face.width);
        this.uvs.setXY(count * 4 + corner, (x + u * (INNER_SIZE - 1)) / ATLAS_SIZE, (y + v * (INNER_SIZE - 1)) / ATLAS_SIZE);
      }
      count++;
    }
    this.positions.needsUpdate = this.uvs.needsUpdate = true;
    this.geometry.setDrawRange(0, count * 6);
    this.geometry.computeBoundingSphere();
    this.overlay.visible = count > 0;
  }

  private disposeSource(source: Source): void {
    const materials = Array.isArray(source.proxy.material) ? source.proxy.material : [source.proxy.material];
    for (const material of materials) material.dispose();
    source.proxy.removeFromParent();
  }

  private releaseSources(): void {
    for (const source of this.sources.values()) this.disposeSource(source);
    this.sources.clear();
    this.scene.clear();
  }

  private releaseAtlas(): void {
    this.residents.clear();
    this.atlas?.dispose();
    this.atlas = null;
    this.material.map = null;
    this.material.needsUpdate = true;
    this.rebuildOverlay();
  }

  clear(): void {
    this.releaseSources();
    this.releaseAtlas();
    this.faces.clear();
    this.root = null;
    this.lastSourcesAt = this.lastSelectionAt = this.lastCaptureAt = -Infinity;
    this.captures = this.captureErrors = this.budgetSkipped = 0;
    this.lastError = null;
  }

  dispose(): void {
    this.clear();
    this.geometry.dispose();
    this.material.dispose();
  }
}
