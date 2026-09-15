import { describe, expect, it, vi } from 'vitest';
import {
  ACESFilmicToneMapping, BoxGeometry, BufferAttribute, BufferGeometry, Color,
  DataTexture, DoubleSide, Group, LinearFilter, LinearSRGBColorSpace, Matrix4,
  Mesh, MeshBasicMaterial, MeshNormalMaterial, MeshStandardMaterial, NoToneMapping,
  OrthographicCamera, PerspectiveCamera, RGBAFormat, Scene, ShaderLib,
  SRGBColorSpace, UnsignedByteType, Vector3, Vector4, WebGLRenderTarget,
  type Camera, type WebGLProgramParametersWithUniforms, type WebGLRenderer
} from 'three';
import { FacadeBaker, buildingFacadeFaces } from '../src/render/FacadeBaker.ts';
import type { BuildingCollider } from '../src/core/physics/VehicleBody.ts';

function rendererFixture() {
  const state = {
    target: null as WebGLRenderTarget | null, cube: 0, mip: 0,
    viewport: new Vector4(11, 13, 800, 600), scissor: new Vector4(17, 19, 500, 400), scissorTest: false,
    currentViewport: new Vector4(), currentScissor: new Vector4(), currentScissorTest: false,
    clearColor: new Color(0x123456), clearAlpha: 0.7
  };
  const renderer = {
    autoClear: true, autoClearColor: false, autoClearDepth: true, autoClearStencil: false,
    toneMapping: ACESFilmicToneMapping, toneMappingExposure: 1.7, outputColorSpace: SRGBColorSpace as string,
    getRenderTarget: () => state.target,
    getActiveCubeFace: () => state.cube,
    getActiveMipmapLevel: () => state.mip,
    getViewport: (out: Vector4) => out.copy(state.viewport),
    getScissor: (out: Vector4) => out.copy(state.scissor),
    getScissorTest: () => state.scissorTest,
    getClearColor: (out: Color) => out.copy(state.clearColor),
    getClearAlpha: () => state.clearAlpha,
    setViewport: vi.fn((value: Vector4) => { state.viewport.copy(value); state.currentViewport.copy(value).multiplyScalar(2); }),
    setScissor: vi.fn((value: Vector4) => { state.scissor.copy(value); state.currentScissor.copy(value).multiplyScalar(2); }),
    setScissorTest: vi.fn((value: boolean) => { state.scissorTest = state.currentScissorTest = value; }),
    setClearColor: vi.fn((value: Color | number, alpha: number) => { state.clearColor.set(value); state.clearAlpha = alpha; }),
    setRenderTarget: vi.fn((target: WebGLRenderTarget | null, cube = 0, mip = 0) => {
      state.target = target;
      state.cube = cube;
      state.mip = mip;
      state.currentViewport.copy(target ? target.viewport : state.viewport.clone().multiplyScalar(2));
      state.currentScissor.copy(target ? target.scissor : state.scissor.clone().multiplyScalar(2));
      state.currentScissorTest = target ? target.scissorTest : state.scissorTest;
    }),
    clear: vi.fn((_color: boolean, _depth: boolean, _stencil: boolean) => {}),
    draw: vi.fn(),
    render: vi.fn((scene: Scene, _camera: Camera): void => {
      if (renderer.autoClear) renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
      scene.updateMatrixWorld(true);
      renderer.draw();
    })
  };
  renderer.setRenderTarget(null);
  renderer.setRenderTarget.mockClear();
  return { renderer, gl: renderer as unknown as WebGLRenderer, state };
}

function box(x = 0, z = 0, width = 20, height = 20): BuildingCollider {
  return { min: new Vector3(x, 0, z), max: new Vector3(x + width, height, z + width) };
}

function source(x = 0, z = 0, width = 20, height = 20) {
  const map = new DataTexture(new Uint8Array([210, 90, 35, 255, 25, 110, 220, 255]), 2, 1);
  map.colorSpace = SRGBColorSpace;
  map.needsUpdate = true;
  const mesh = new Mesh(new BoxGeometry(width, height, width), new MeshBasicMaterial({ map }));
  mesh.position.set(x + width / 2, height / 2, z + width / 2);
  return mesh;
}

function cameraAt(x = 40, y = 12, z = 40): PerspectiveCamera {
  const camera = new PerspectiveCamera(65, 1.6, 0.5, 8000);
  camera.position.set(x, y, z);
  camera.lookAt(10, 10, 10);
  camera.updateMatrixWorld(true);
  return camera;
}

function overlay(baker: FacadeBaker): Mesh<BufferGeometry, MeshBasicMaterial> {
  return baker.group.children[0] as Mesh<BufferGeometry, MeshBasicMaterial>;
}

function bindings(baker: FacadeBaker): Map<string, number[]> {
  const geometry = overlay(baker).geometry;
  const positions = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
  const result = new Map<string, number[]>();
  for (let i = 0; i < geometry.drawRange.count / 6; i++) {
    const center = new Vector3();
    const coordinates: number[] = [];
    for (let corner = 0; corner < 4; corner++) {
      center.add(new Vector3().fromBufferAttribute(positions, i * 4 + corner));
      coordinates.push(uv.getX(i * 4 + corner), uv.getY(i * 4 + corner));
    }
    result.set(center.multiplyScalar(0.25).toArray().join(','), coordinates);
  }
  return result;
}

function compile(material: MeshBasicMaterial) {
  const shader = {
    uniforms: {}, vertexShader: ShaderLib.basic.vertexShader, fragmentShader: ShaderLib.basic.fragmentShader
  } as WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as WebGLRenderer);
  return shader;
}

describe('buildingFacadeFaces', () => {
  it('defines four outward-facing wall frames with consistent bottom-left to top-right coordinates', () => {
    const bounds = { min: new Vector3(-4, 7, -8), max: new Vector3(16, 47, 22) };
    const faces = buildingFacadeFaces(bounds);
    expect(faces.map(f => f.normal.toArray())).toEqual([[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]);
    const right = [new Vector3(0, 0, -1), new Vector3(0, 0, 1), new Vector3(1, 0, 0), new Vector3(-1, 0, 0)];
    faces.forEach((face, i) => expect(face.right.equals(right[i]!)).toBe(true));
    expect(faces.map(f => f.width)).toEqual([30, 30, 20, 20]);
    for (const face of faces) {
      expect(face.height).toBe(40);
      expect(face.right.clone().cross(new Vector3(0, 1, 0)).equals(face.normal)).toBe(true);
      for (const u of [-0.5, 0.5]) for (const v of [-0.5, 0.5]) {
        const point = face.center.clone().addScaledVector(face.right, u * face.width);
        point.y += v * face.height;
        expect(point.y).toBe(v < 0 ? 7 : 47);
        expect(new Vector3().subVectors(point, face.center).dot(face.normal)).toBeCloseTo(0, 10);
        expect(face.bounds.containsPoint(point)).toBe(true);
      }
    }
    expect(bounds.min.toArray()).toEqual([-4, 7, -8]);
    expect(bounds.max.toArray()).toEqual([16, 47, 22]);
  });

  it('keys by complete bounds and searches the full interior without widening the exterior tolerance', () => {
    const a = box(0, 0, 2);
    expect(buildingFacadeFaces(a).map(f => f.key)).toEqual(buildingFacadeFaces({ min: a.min.clone(), max: a.max.clone() }).map(f => f.key));
    expect(buildingFacadeFaces(a).every(f => f.inward === 2 && f.outward === 12)).toBe(true);
    const changed = { min: a.min.clone(), max: a.max.clone().add(new Vector3(0, 1, 0)) };
    expect(buildingFacadeFaces(changed)[0]!.key).not.toBe(buildingFacadeFaces(a)[0]!.key);
    expect(buildingFacadeFaces(a, 5)[0]!.outward).toBe(7);
    expect(buildingFacadeFaces(a, Infinity)[0]!.outward).toBe(12);
    expect(buildingFacadeFaces(a, 500)[0]!.outward).toBe(14);
    for (const face of buildingFacadeFaces(box(0, 0, 80))) {
      expect(face.inward).toBe(80);
      expect(face.bounds.containsPoint(face.center.clone().addScaledVector(face.normal, -79))).toBe(true);
      expect(face.bounds.containsPoint(face.center.clone().addScaledVector(face.normal, 13))).toBe(false);
      expect(face.bounds.containsPoint(face.center.clone().addScaledVector(face.normal, -81))).toBe(false);
    }
  });

  it('rejects props and invalid or degenerate boxes', () => {
    expect(buildingFacadeFaces({ ...box(), kind: 'prop' })).toEqual([]);
    expect(buildingFacadeFaces(box(0, 0, 0))).toEqual([]);
    expect(buildingFacadeFaces(box(0, 0, 20, -1))).toEqual([]);
    expect(buildingFacadeFaces(box(NaN))).toEqual([]);
  });
});

describe('FacadeBaker', () => {
  it('allocates one bounded atlas only on the first eligible update and submits one capture per interval', () => {
    const { gl, renderer, state } = rendererFixture();
    const baker = new FacadeBaker(gl);
    const root = new Group().add(source());
    baker.setSources(root);
    baker.setBuildings([box()]);
    expect(overlay(baker).material.map).toBeNull();
    expect(renderer.setRenderTarget).not.toHaveBeenCalled();
    renderer.render.mockImplementation(() => {
      expect(state.target).toMatchObject({ width: 2048, height: 2048, depthBuffer: true, stencilBuffer: false, samples: 0 });
      expect(state.target!.texture).toMatchObject({ format: RGBAFormat, type: UnsignedByteType,
        minFilter: LinearFilter, magFilter: LinearFilter, colorSpace: LinearSRGBColorSpace, generateMipmaps: false });
      expect(state.currentViewport.z).toBe(252);
      expect(state.currentScissor.z).toBe(256);
      expect(state.currentScissorTest).toBe(true);
      expect(state.clearAlpha).toBe(0);
      expect(renderer.autoClear).toBe(true);
      expect([renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil]).toEqual([true, true, false]);
      expect(renderer.toneMapping).toBe(NoToneMapping);
    });
    const camera = cameraAt();
    baker.update(camera, 0);
    const atlasMap = overlay(baker).material.map;
    expect(atlasMap).not.toBeNull();
    expect(baker.stats).toMatchObject({ faces: 4, bakedFaces: 1, captures: 1, pending: 3, sourceMeshes: 1 });
    baker.update(camera, 79);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    for (const time of [80, 160, 240, 800, 1600]) baker.update(camera, time);
    expect(renderer.render).toHaveBeenCalledTimes(4);
    expect(baker.stats.pending).toBe(0);
    expect(overlay(baker).material.map).toBe(atlasMap);
    expect(baker.group.children).toHaveLength(1);
    expect(overlay(baker).material).toMatchObject({ transparent: false, depthWrite: true,
      toneMapped: false, alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -1 });
    expect(overlay(baker).geometry.drawRange.count).toBe(24);
    const shader = compile(overlay(baker).material);
    expect(shader.fragmentShader).toContain('photo.rgb / max(photo.a, 0.0001)');
    expect(shader.fragmentShader).toContain('if (photo.a < 0.5) discard');
    baker.dispose();
  });

  it('captures all four fixed orientations and maps face corners to their atlas texel centers', () => {
    const { gl, renderer, state } = rendererFixture();
    const baker = new FacadeBaker(gl);
    const root = new Group().add(source());
    const bounds = box();
    const faces = buildingFacadeFaces(bounds);
    const visited = new Set<string>();
    renderer.render.mockImplementation((scene, camera) => {
      expect(camera).toBeInstanceOf(OrthographicCamera);
      const material = (scene.children[0] as Mesh).material as MeshBasicMaterial;
      const shader = compile(material);
      const normal = shader.uniforms.uFacadeNormal!.value as Vector3;
      const face = faces.find(f => f.normal.equals(normal))!;
      visited.add(face.key);
      expect(camera.position.clone().sub(face.center).normalize().distanceTo(normal)).toBeLessThan(1e-10);
      expect(camera.up.toArray()).toEqual([0, 1, 0]);
      for (const u of [-0.5, 0.5]) for (const v of [-0.5, 0.5]) {
        const point = face.center.clone().addScaledVector(face.right, u * face.width);
        point.y += v * face.height;
        point.project(camera);
        expect(point.x).toBeCloseTo(2 * u * 251 / 252, 10);
        expect(point.y).toBeCloseTo(2 * v * 251 / 252, 10);
        const pixelX = state.currentViewport.x + (point.x + 1) * state.currentViewport.z / 2;
        const pixelY = state.currentViewport.y + (point.y + 1) * state.currentViewport.w / 2;
        expect(pixelX % 256).toBeCloseTo(u < 0 ? 2.5 : 253.5, 9);
        expect(pixelY % 256).toBeCloseTo(v < 0 ? 2.5 : 253.5, 9);
      }
      expect(shader.fragmentShader).toContain('abs(wallDistance) / max(uFacadeSlab.x, uFacadeSlab.y)');
      expect(shader.fragmentShader).toContain('!gl_FrontFacing');
      expect(shader.fragmentShader).toContain('abs(geometricNormal.y) > 0.55');
      expect(shader.fragmentShader).not.toContain('uClutter');
      expect(shader.fragmentShader).not.toContain('uGrain');
    });
    baker.setSources(root);
    baker.setBuildings([bounds]);
    const camera = cameraAt();
    for (let i = 0; i < 4; i++) baker.update(camera, i * 80);
    expect(visited.size).toBe(4);
    for (const uv of bindings(baker).values()) for (const value of uv) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(1);
      expect((value * 2048) % 256).toBeCloseTo(value * 2048 % 256 < 128 ? 2.5 : 253.5, 6);
    }
    baker.dispose();
  });

  it('preserves source groups, UV channels/transforms, factors and full hierarchy transforms in clean proxies', () => {
    const { gl, renderer } = rendererFixture();
    const baker = new FacadeBaker(gl);
    const mesh = source();
    const geometry = mesh.geometry;
    geometry.setAttribute('uv1', geometry.getAttribute('uv').clone());
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(24 * 3).fill(0.7), 3));
    geometry.clearGroups();
    geometry.addGroup(0, 12, 0);
    geometry.addGroup(12, 12, 1);
    geometry.addGroup(24, 12, 2);
    const map = mesh.material.map!;
    map.channel = 1;
    map.offset.set(0.2, 0.3);
    map.repeat.set(0.6, 0.8);
    const first = new MeshStandardMaterial({ map, color: 0x8f6e4c, vertexColors: true, alphaTest: 0.35, opacity: 0.8 });
    const patch = vi.fn();
    first.onBeforeCompile = patch;
    const second = new MeshBasicMaterial({ map: map.clone(), color: 0xffbbaa });
    const originalMaterials = [first, second, new MeshNormalMaterial()];
    const multiMesh = new Mesh(geometry, originalMaterials);
    multiMesh.position.set(5, 8, 9);
    const parent = new Group().add(multiMesh);
    parent.position.set(10, 7, 12);
    parent.scale.set(1, 1.5, 1);
    parent.rotation.y = 0.2;
    const root = new Group().add(parent);
    root.position.set(3, 0, -4);
    root.visible = false;
    root.traverse(object => object.layers.set(1));
    root.updateWorldMatrix(true, true);
    const worldMatrix = multiMesh.matrixWorld.clone();
    let checked = false;
    renderer.render.mockImplementation((scene, _camera) => {
      scene.updateMatrixWorld(true);
      const proxy = scene.children[0] as Mesh<BufferGeometry, MeshBasicMaterial[]>;
      expect(proxy.geometry).toBe(geometry);
      expect(proxy.matrixWorld.elements).toEqual(worldMatrix.elements);
      expect(proxy.material).toHaveLength(3);
      const copied = proxy.material[0]!;
      expect(copied).toBeInstanceOf(MeshBasicMaterial);
      expect(copied).not.toBe(first);
      expect(copied.map).toBe(map);
      expect(copied.map!.channel).toBe(1);
      expect(copied.map!.offset.toArray()).toEqual([0.2, 0.3]);
      expect(copied.color.equals(first.color)).toBe(true);
      expect(copied).toMatchObject({ alphaTest: 0.35, opacity: 0.8, vertexColors: true, fog: false, toneMapped: false, side: DoubleSide });
      expect(proxy.material[1]!.map).toBe(second.map);
      expect(proxy.material[2]!.visible).toBe(false);
      compile(copied);
      expect(patch).not.toHaveBeenCalled();
      checked = true;
    });
    baker.setSources(root);
    baker.setBuildings([box(0, 0, 45, 60)]);
    baker.update(cameraAt(), 0);
    expect(checked).toBe(true);
    expect(root.visible).toBe(false);
    expect(root.layers.mask).toBe(2);
    expect(multiMesh.parent).toBe(parent);
    expect(multiMesh.material).toBe(originalMaterials);
    expect(multiMesh.layers.mask).toBe(2);
    expect(multiMesh.matrixWorld.elements).toEqual(worldMatrix.elements);
    baker.dispose();
  });

  it('does not rebake or remap completed faces during camera motion or collider reordering', () => {
    const { gl } = rendererFixture();
    const baker = new FacadeBaker(gl);
    const root = new Group().add(source(), source(60));
    const a = box(), b = box(60);
    const matrices = [a.min.toArray(), a.max.toArray(), b.min.toArray(), b.max.toArray()];
    baker.setSources(root);
    baker.setBuildings([a, b]);
    const camera = cameraAt();
    for (let i = 0; i < 8; i++) baker.update(camera, i * 80);
    expect(baker.stats.captures).toBe(8);
    const before = bindings(baker);
    const texture = overlay(baker).material.map;
    baker.setBuildings([b, { min: a.min.clone(), max: a.max.clone() }]);
    camera.position.set(-25, 25, -25);
    camera.fov = 95;
    camera.aspect = 0.5;
    camera.updateProjectionMatrix();
    baker.update(camera, 1200);
    expect(bindings(baker)).toEqual(before);
    expect(baker.stats.captures).toBe(8);
    expect(overlay(baker).material.map).toBe(texture);
    expect([a.min.toArray(), a.max.toArray(), b.min.toArray(), b.max.toArray()]).toEqual(matrices);
    baker.setBuildings([b]);
    expect(bindings(baker).size).toBe(4);
    for (const [key, uv] of bindings(baker)) expect(uv).toEqual(before.get(key));
    baker.dispose();
  });

  it('limits residency to 64 stable slots, evicts by distance, and clears a reused slot before rendering', () => {
    const { gl, renderer, state } = rendererFixture();
    const baker = new FacadeBaker(gl);
    const root = new Group().add(source(-100, -100, 400, 100));
    const boxes = Array.from({ length: 25 }, (_, i) => box((i % 5) * 30, Math.floor(i / 5) * 30));
    baker.setSources(root);
    baker.setBuildings(boxes);
    const camera = cameraAt(50, 10, 50);
    const cleared: number[] = [];
    renderer.clear.mockImplementation(() => { cleared.push(state.currentScissor.x + state.currentScissor.y * 2048); });
    for (let i = 0; i < 70; i++) baker.update(camera, i * 80);
    expect(baker.stats).toMatchObject({ faces: 64, bakedFaces: 64, captures: 64, pending: 0 });
    expect(new Set(cleared).size).toBe(64);
    expect(overlay(baker).geometry.drawRange.count).toBe(64 * 6);
    const before = bindings(baker);
    baker.setBuildings([...boxes].reverse());
    baker.update(camera, 6000);
    expect(bindings(baker)).toEqual(before);
    expect(baker.stats.captures).toBe(64);
    camera.position.set(2000, 10, 2000);
    baker.update(camera, 6500);
    expect(baker.stats.faces).toBe(0);
    expect(overlay(baker).visible).toBe(false);
    camera.position.set(50, 10, 50);
    baker.update(camera, 7000);
    expect(baker.stats.bakedFaces).toBe(1);
    expect(cleared).toHaveLength(65);
    expect(cleared[64]).toBe(cleared[0]);
    expect(renderer.clear.mock.invocationCallOrder[64]!).toBeLessThan(renderer.draw.mock.invocationCallOrder[64]!);
    baker.dispose();
  });

  it('refreshes only affected source candidates and retains completed images while replacements wait', () => {
    const { gl } = rendererFixture();
    const baker = new FacadeBaker(gl);
    const a = source(), b = source(180);
    const root = new Group().add(a, b);
    baker.setSources(root);
    baker.setBuildings([box(), box(180)]);
    const camera = cameraAt(90, 10, 40);
    for (let i = 0; i < 8; i++) baker.update(camera, i * 80);
    const before = bindings(baker);
    expect(baker.stats.captures).toBe(8);
    root.remove(a);
    root.add(source());
    baker.update(camera, 1200);
    expect(baker.stats).toMatchObject({ sourceMeshes: 2, bakedFaces: 8, captures: 9, pending: 3 });
    expect(bindings(baker)).toEqual(before);
    for (const time of [1280, 1360, 1440, 2000]) baker.update(camera, time);
    expect(baker.stats).toMatchObject({ captures: 12, pending: 0 });
    b.position.x += 1;
    baker.update(camera, 2600);
    expect(baker.stats).toMatchObject({ captures: 13, pending: 3, bakedFaces: 8 });
    baker.dispose();
  });

  it('checks committed membership before using a removed source between scheduled scans', () => {
    const { gl, renderer } = rendererFixture();
    const baker = new FacadeBaker(gl);
    const mesh = source();
    const root = new Group().add(mesh);
    baker.setSources(root);
    baker.setBuildings([box()]);
    baker.update(cameraAt(), 0);
    root.remove(mesh);
    baker.update(cameraAt(), 80);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(baker.stats.sourceMeshes).toBe(0);
    expect(baker.stats.bakedFaces).toBe(1);
    baker.dispose();
  });

  it('updates source materials and UV transforms without mistaking source identity for content', () => {
    const { gl } = rendererFixture();
    const baker = new FacadeBaker(gl);
    const mesh = source();
    const root = new Group().add(mesh);
    baker.setSources(root);
    baker.setBuildings([box()]);
    const camera = cameraAt();
    for (let i = 0; i < 4; i++) baker.update(camera, i * 80);
    mesh.name = 'different-fixture-label';
    baker.update(camera, 600);
    expect(baker.stats.captures).toBe(4);
    mesh.material.map!.offset.x = 0.5;
    baker.update(camera, 1200);
    expect(baker.stats).toMatchObject({ captures: 5, pending: 3 });
    for (const time of [1280, 1360, 1440]) baker.update(camera, time);
    mesh.material.map!.needsUpdate = true;
    baker.update(camera, 1800);
    expect(baker.stats.captures).toBe(9);
    baker.dispose();
  });

  it.each(['triangles', 'draws'])('leaves fallback rather than partially capturing over-budget %s', budget => {
    const { gl, renderer } = rendererFixture();
    const baker = new FacadeBaker(gl);
    const root = new Group();
    if (budget === 'draws') {
      for (let i = 0; i < 25; i++) root.add(source());
    } else {
      const mesh = source();
      const geometry = new BufferGeometry();
      const positions = new Float32Array(360_003 * 3);
      positions.set([0, 0, 0, 20, 0, 0, 0, 20, 20]);
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new BufferAttribute(new Float32Array(360_003 * 2), 2));
      root.add(new Mesh(geometry, mesh.material));
    }
    baker.setSources(root);
    baker.setBuildings([box()]);
    baker.update(cameraAt(), 0);
    expect(baker.stats.budgetSkipped).toBeGreaterThan(0);
    expect(baker.stats.bakedFaces).toBe(0);
    expect(overlay(baker).material.map).toBeNull();
    expect(renderer.render).not.toHaveBeenCalled();
    baker.dispose();
  });

  it('requires the base photograph and its selected UV channel, excluding props and unsupported sources', () => {
    const { gl, renderer } = rendererFixture();
    const baker = new FacadeBaker(gl);
    const missingUv = source();
    missingUv.material.map!.channel = 1;
    const untextured = source();
    untextured.material.map = null;
    const blended = source();
    blended.material.transparent = true;
    const root = new Group().add(missingUv, untextured, blended);
    baker.setSources(root);
    baker.setBuildings([box()]);
    baker.update(cameraAt(), 0);
    expect(baker.stats.sourceMeshes).toBe(0);
    expect(renderer.render).not.toHaveBeenCalled();
    root.add(source());
    baker.setBuildings([{ ...box(), kind: 'prop' }]);
    baker.update(cameraAt(), 600);
    expect(baker.stats.sourceMeshes).toBe(1);
    expect(renderer.render).not.toHaveBeenCalled();
    baker.setBuildings([box()]);
    baker.update(cameraAt(), 601);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    baker.dispose();
  });

  it.each([false, true])('restores complete renderer state and scene ownership (draw throws: %s)', throws => {
    const { gl, renderer, state } = rendererFixture();
    const previous = new WebGLRenderTarget(128, 128);
    previous.viewport.set(2, 4, 100, 110);
    previous.scissor.set(3, 5, 90, 95);
    previous.scissorTest = true;
    renderer.setRenderTarget(previous, 4, 2);
    const saved = {
      viewport: state.viewport.clone(), scissor: state.scissor.clone(), scissorTest: state.scissorTest,
      currentViewport: state.currentViewport.clone(), currentScissor: state.currentScissor.clone(),
      currentScissorTest: state.currentScissorTest, color: state.clearColor.clone(), alpha: state.clearAlpha
    };
    const baker = new FacadeBaker(gl);
    const root = new Group().add(source());
    root.visible = false;
    root.updateMatrixWorld(true);
    const matrix = root.children[0]!.matrix.clone();
    let bakeScene: Scene | null = null;
    renderer.render.mockImplementation(scene => {
      bakeScene = scene;
      renderer.autoClearColor = true;
      renderer.autoClearDepth = false;
      renderer.autoClearStencil = true;
      renderer.toneMappingExposure = 10;
      renderer.outputColorSpace = LinearSRGBColorSpace;
      if (throws) throw new Error('injected draw failure');
    });
    baker.setSources(root);
    baker.setBuildings([box()]);
    expect(() => baker.update(cameraAt(), 0)).not.toThrow();
    expect(state.target).toBe(previous);
    expect([state.cube, state.mip]).toEqual([4, 2]);
    expect(state.viewport).toEqual(saved.viewport);
    expect(state.scissor).toEqual(saved.scissor);
    expect(state.scissorTest).toBe(saved.scissorTest);
    expect(state.currentViewport).toEqual(saved.currentViewport);
    expect(state.currentScissor).toEqual(saved.currentScissor);
    expect(state.currentScissorTest).toBe(saved.currentScissorTest);
    expect(state.clearColor).toEqual(saved.color);
    expect(state.clearAlpha).toBe(saved.alpha);
    expect(renderer).toMatchObject({ autoClear: true, autoClearColor: false, autoClearDepth: true,
      autoClearStencil: false, toneMapping: ACESFilmicToneMapping, toneMappingExposure: 1.7, outputColorSpace: SRGBColorSpace });
    expect(bakeScene).not.toBeNull();
    expect((bakeScene! as Scene).children).toHaveLength(0);
    expect(root.visible).toBe(false);
    expect(root.children).toHaveLength(1);
    expect(root.children[0]!.parent).toBe(root);
    expect(root.children[0]!.matrix.elements).toEqual(matrix.elements);
    expect(baker.stats.captureErrors).toBe(throws ? 1 : 0);
    expect(baker.stats.bakedFaces).toBe(throws ? 0 : 1);
    if (throws) {
      expect(baker.stats.lastError).toBe('injected draw failure');
      expect(overlay(baker).visible).toBe(false);
      renderer.render.mockImplementation(() => {});
      baker.update(cameraAt(), 1200);
      expect(baker.stats.bakedFaces).toBe(1);
    }
    baker.dispose();
    previous.dispose();
  });

  it('disposes only owned proxy materials/atlas and remains reusable after clear', () => {
    const { gl, renderer } = rendererFixture();
    const baker = new FacadeBaker(gl);
    const mesh = source();
    const geometryDispose = vi.spyOn(mesh.geometry, 'dispose');
    const textureDispose = vi.spyOn(mesh.material.map!, 'dispose');
    const materialDispose = vi.spyOn(mesh.material, 'dispose');
    const root = new Group().add(mesh);
    const proxies: MeshBasicMaterial[] = [];
    renderer.render.mockImplementation(scene => { proxies.push((scene.children[0] as Mesh).material as MeshBasicMaterial); });
    baker.setSources(root);
    baker.setBuildings([box()]);
    baker.update(cameraAt(), 0);
    const proxyDispose = vi.spyOn(proxies[0]!, 'dispose');
    const atlas = renderer.setRenderTarget.mock.calls.find(([target]) => target?.width === 2048)![0]!;
    const atlasDispose = vi.spyOn(atlas, 'dispose');
    baker.clear();
    expect(proxyDispose).toHaveBeenCalledTimes(1);
    expect(atlasDispose).toHaveBeenCalledTimes(1);
    expect(baker.stats).toMatchObject({ faces: 0, bakedFaces: 0, captures: 0, pending: 0, sourceMeshes: 0 });
    expect(overlay(baker).material.map).toBeNull();
    expect(overlay(baker).geometry.drawRange.count).toBe(0);
    baker.setBuildings([box()]);
    baker.setSources(root);
    baker.update(cameraAt(), 0);
    expect(baker.stats.bakedFaces).toBe(1);
    expect(proxies[1]).not.toBe(proxies[0]);
    expect(baker.group.children).toHaveLength(1);
    baker.setSources(null);
    expect(baker.stats.sourceMeshes).toBe(0);
    expect(baker.stats.bakedFaces).toBe(0);
    expect(overlay(baker).material.map).toBeNull();
    baker.dispose();
    baker.dispose();
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(textureDispose).not.toHaveBeenCalled();
    expect(materialDispose).not.toHaveBeenCalled();
    expect(mesh.parent).toBe(root);
  });

  it('releases replaced proxy materials, including material arrays, without disposing shared assets', () => {
    const { gl, renderer } = rendererFixture();
    const baker = new FacadeBaker(gl);
    const original = source();
    const mesh = new Mesh(original.geometry, [original.material, new MeshNormalMaterial()]);
    const root = new Group().add(mesh);
    const materials: MeshBasicMaterial[] = [];
    renderer.render.mockImplementation(scene => { materials.push(...(scene.children[0] as Mesh).material as MeshBasicMaterial[]); });
    baker.setSources(root);
    baker.setBuildings([box()]);
    baker.update(cameraAt(), 0);
    const disposals = materials.map(material => vi.spyOn(material, 'dispose'));
    const geometryDispose = vi.spyOn(mesh.geometry, 'dispose');
    const textureDispose = vi.spyOn(original.material.map!, 'dispose');
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(new Matrix4().makeTranslation(1, 10, 10));
    baker.update(cameraAt(), 600);
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(textureDispose).not.toHaveBeenCalled();
    baker.dispose();
  });

  it.skipIf(process.env.FACADE_GPU !== '1')('renders photographic pixels, nearest surfaces, coverage edges and camera-stable detail on WebGL', async () => {
    const { chromium } = await import('playwright-core');
    const { readFile } = await import('node:fs/promises');
    const { transpileModule, ScriptTarget, ModuleKind } = await import('typescript');
    const [sourceText, three] = await Promise.all([
      readFile(new URL('../src/render/FacadeBaker.ts', import.meta.url), 'utf8'),
      readFile(new URL('../node_modules/three/build/three.module.js', import.meta.url), 'utf8')
    ]);
    const bakerModule = transpileModule(sourceText, { compilerOptions: {
      target: ScriptTarget.ES2022, module: ModuleKind.ESNext, verbatimModuleSyntax: true
    } }).outputText;
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.route('http://facade.test/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/three.js' || path === '/baker.js') {
          await route.fulfill({ contentType: 'text/javascript', body: path === '/three.js' ? three : bakerModule });
        } else {
          await route.fulfill({ contentType: 'text/html', body: '<script type="importmap">{"imports":{"three":"/three.js"}}</script>' });
        }
      });
      await page.goto('http://facade.test/');
      const result = await page.evaluate(async urls => {
        // Vitest rewrites dynamic imports to server-only helpers before Playwright serializes this function
        // Construct the browser import here so the evaluated code uses native ES modules
        const importModule = new Function('url', 'return import(url)') as (url: string) => Promise<any>;
        const T = await importModule(urls.three);
        const { FacadeBaker: Baker } = await importModule(urls.baker);
        const renderer = new T.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
        renderer.setSize(512, 512);
        renderer.outputColorSpace = T.SRGBColorSpace;
        renderer.toneMapping = T.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 0.3;
        const scene = new T.Scene();
        const camera = new T.PerspectiveCamera(45, 1, 0.1, 200);
        camera.position.set(0, 10, 45);
        camera.lookAt(0, 10, 0);
        camera.updateMatrixWorld(true);
        const fallback = new T.Mesh(new T.BoxGeometry(20, 20, 20), new T.MeshBasicMaterial({ color: 0x303030, toneMapped: false }));
        fallback.position.y = 10;
        scene.add(fallback);
        const root = new T.Group();
        root.visible = false;
        const data = new Uint8Array([210, 60, 30, 255, 0, 0, 0, 0, 240, 220, 40, 255, 30, 100, 220, 255]);
        const photo = new T.DataTexture(data, 2, 2);
        photo.colorSpace = T.SRGBColorSpace;
        photo.channel = 1;
        photo.needsUpdate = true;
        const facadeGeometry = new T.PlaneGeometry(20, 20);
        facadeGeometry.setAttribute('uv1', facadeGeometry.getAttribute('uv').clone());
        const wrongUv = facadeGeometry.getAttribute('uv');
        for (let i = 0; i < wrongUv.count; i++) wrongUv.setXY(i, 0.75, 0.75);
        const front = new T.Mesh(facadeGeometry, new T.MeshBasicMaterial({ map: photo, alphaTest: 0.5 }));
        front.position.set(0, 10, 10.6);
        root.add(front);
        const solidMap = (rgb: number[]) => {
          const map = new T.DataTexture(new Uint8Array([...rgb, 255]), 1, 1);
          map.colorSpace = T.SRGBColorSpace;
          map.needsUpdate = true;
          return map;
        };
        const farther = new T.Mesh(new T.PlaneGeometry(10, 20), new T.MeshBasicMaterial({ map: solidMap([0, 255, 0]) }));
        farther.position.set(-5, 10, 13);
        root.add(farther);
        const backwards = new T.Mesh(new T.PlaneGeometry(20, 20), new T.MeshBasicMaterial({ map: solidMap([255, 0, 255]) }));
        backwards.position.set(0, 10, 10.2);
        backwards.rotation.y = Math.PI;
        root.add(backwards);
        const roof = new T.Mesh(new T.PlaneGeometry(20, 20), new T.MeshBasicMaterial({ map: solidMap([0, 255, 255]) }));
        roof.rotation.x = -Math.PI / 3;
        roof.position.set(0, 18, 10);
        root.add(roof);
        const baker = new Baker(renderer);
        scene.add(baker.group);
        baker.group.visible = true;
        baker.setSources(root);
        baker.setBuildings([{ min: new T.Vector3(-10, 0, -10), max: new T.Vector3(10, 20, 10) }]);
        renderer.state.buffers.depth.setMask(false);
        renderer.state.buffers.color.setMask(false);
        baker.update(camera, 0);
        const firstCaptures = baker.stats.captures;
        const context = renderer.getContext();
        const pixel = (x: number, y: number, z = 10) => {
          const p = new T.Vector3(x, y, z).project(camera);
          const bytes = new Uint8Array(4);
          context.readPixels(Math.floor((p.x + 1) * 256), Math.floor((p.y + 1) * 256), 1, 1, context.RGBA, context.UNSIGNED_BYTE, bytes);
          return Array.from(bytes).slice(0, 3);
        };
        const draw = () => {
          renderer.render(scene, camera);
          return { red: pixel(-5, 5), yellow: pixel(-5, 15), blue: pixel(5, 15), roofOverlap: pixel(5, 18), hole: pixel(5, 5) };
        };
        const first = draw();
        const edges = Array.from({ length: 21 }, (_, i) => pixel((i - 10) * 0.04, 5));
        for (const time of [80, 160, 240]) baker.update(camera, time);
        const captures = baker.stats.captures;
        const views = [];
        for (const [index, x] of [25, -25].entries()) {
          camera.position.set(x, 18, 45);
          camera.lookAt(0, 10, 0);
          camera.updateMatrixWorld(true);
          baker.update(camera, 800 + index * 600);
          views.push(draw());
        }
        const stableCaptures = baker.stats.captures;
        data.set([210, 20, 200, 255], 0);
        photo.needsUpdate = true;
        baker.update(camera, 2000);
        const changed = draw();
        const stats = baker.stats;
        const obliqueRoot = new T.Group();
        const obliqueGeometry = new T.PlaneGeometry(40 * Math.SQRT2, 20);
        obliqueGeometry.setAttribute('uv1', obliqueGeometry.getAttribute('uv').clone());
        const oblique = new T.Mesh(obliqueGeometry, new T.MeshBasicMaterial({ map: photo, alphaTest: 0.5 }));
        oblique.rotation.y = Math.PI / 4;
        oblique.position.set(0, 10, -20);
        obliqueRoot.add(oblique);
        for (const z of [12.05, -40.05]) {
          const neighbor = new T.Mesh(new T.PlaneGeometry(40, 40), new T.MeshBasicMaterial({ map: solidMap([0, 255, 0]) }));
          neighbor.position.set(0, 20, z);
          obliqueRoot.add(neighbor);
        }
        const wrongSide = new T.Mesh(new T.PlaneGeometry(40, 40), new T.MeshBasicMaterial({ map: solidMap([255, 0, 255]) }));
        wrongSide.position.set(0, 20, -4);
        wrongSide.rotation.y = Math.PI;
        obliqueRoot.add(wrongSide);
        const deepBase = new T.Mesh(new T.BoxGeometry(40, 40, 40), fallback.material);
        deepBase.position.set(0, 20, -20);
        scene.remove(fallback);
        scene.add(deepBase);
        camera.position.set(0, 20, 75);
        camera.lookAt(0, 20, 0);
        camera.updateMatrixWorld(true);
        baker.setSources(obliqueRoot);
        baker.setBuildings([{ min: new T.Vector3(-20, 0, -40), max: new T.Vector3(20, 40, 0) }]);
        baker.update(camera, 3000);
        renderer.render(scene, camera);
        const interior = {
          near: pixel(-15, 15, 0), middle: pixel(-5, 15, 0), deep: pixel(15, 15, 0),
          missingUpperFloor: pixel(15, 30, 0), hole: pixel(15, 5, 0),
          captures: baker.stats.captures, errors: baker.stats.captureErrors
        };
        const error = context.getError();
        baker.dispose();
        deepBase.geometry.dispose();
        fallback.geometry.dispose();
        fallback.material.dispose();
        for (const sourceRoot of [root, obliqueRoot]) sourceRoot.traverse((object: any) => {
          if (object.isMesh) { object.geometry.dispose(); object.material.map.dispose(); object.material.dispose(); }
        });
        renderer.dispose();
        return { firstCaptures, first, edges, captures, stableCaptures, views, changed, stats, interior, error };
      }, { three: 'http://facade.test/three.js', baker: 'http://facade.test/baker.js' });
      expect(errors).toEqual([]);
      expect(result.firstCaptures).toBe(1);
      expect(result.stats.captureErrors).toBe(0);
      expect(result.error).toBe(0);
      const close = (a: number[], b: number[]) => a.every((value, i) => Math.abs(value - b[i]!) <= 4);
      for (const view of [result.first, ...result.views]) {
        expect(close(view.red, [210, 60, 30]), JSON.stringify(view)).toBe(true);
        expect(close(view.yellow, [240, 220, 40]), JSON.stringify(view)).toBe(true);
        expect(close(view.blue, [30, 100, 220]), JSON.stringify(view)).toBe(true);
        expect(close(view.roofOverlap, [30, 100, 220]), JSON.stringify(view)).toBe(true);
        expect(close(view.hole, [48, 48, 48]), JSON.stringify(view)).toBe(true);
      }
      expect(result.edges.every(rgb => close(rgb, [210, 60, 30]) || close(rgb, [48, 48, 48])), JSON.stringify(result.edges)).toBe(true);
      expect(result.stableCaptures).toBe(result.captures);
      expect(close(result.changed.red, [210, 20, 200]), JSON.stringify(result.changed)).toBe(true);
      expect(result.interior.errors).toBe(0);
      expect(close(result.interior.near, [240, 220, 40]), JSON.stringify(result.interior)).toBe(true);
      expect(close(result.interior.middle, [240, 220, 40]), JSON.stringify(result.interior)).toBe(true);
      expect(close(result.interior.deep, [30, 100, 220]), JSON.stringify(result.interior)).toBe(true);
      expect(close(result.interior.missingUpperFloor, [48, 48, 48]), JSON.stringify(result.interior)).toBe(true);
      expect(close(result.interior.hole, [48, 48, 48]), JSON.stringify(result.interior)).toBe(true);
    } finally {
      await browser.close();
    }
  }, 30_000);
});
