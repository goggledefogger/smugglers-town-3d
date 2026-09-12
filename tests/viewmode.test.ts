import { describe, it, expect } from 'vitest';
import { Vector3, Matrix4, Quaternion } from 'three';
import { BuildingMeshView } from '../src/render/BuildingMeshView.ts';
import { Bindings } from '../src/input/bindings.ts';
import { TerrainMesh } from '../src/render/TerrainMesh.ts';
import { createDesertTerrain } from '../src/core/terrain/ProceduralTerrain.ts';
import { Heightfield } from '../src/core/heightfield.ts';
import type { BuildingCollider } from '../src/core/physics/VehicleBody.ts';
import type { Grid } from '../src/services/tiles/tileColliders.ts';
import { NO_DATA } from '../src/services/tiles/tileColliders.ts';

describe('BuildingMeshView', () => {
  it('instantiates hidden and toggles visibility', () => {
    const view = new BuildingMeshView();
    expect(view.visible).toBe(false);
    expect(view.group.visible).toBe(false);

    view.visible = true;
    expect(view.visible).toBe(true);
    expect(view.group.visible).toBe(true);

    view.visible = false;
    expect(view.visible).toBe(false);
  });

  it('builds instanced meshes from active colliders and deckGrid', () => {
    const view = new BuildingMeshView();
    const mockColliders: BuildingCollider[] = [
      {
        min: new Vector3(10, 0, 10),
        max: new Vector3(30, 50, 30)
      },
      {
        min: new Vector3(-20, 0, -20),
        max: new Vector3(-10, 15, -10)
      },
      {
        min: new Vector3(50, 0, 50),
        max: new Vector3(55, 4, 55),
        kind: 'prop'
      }
    ];

    const mockGrid: Grid = {
      n: 4,
      cell: 10,
      half: 20
    };
    const mockDeckGrid = new Float32Array(16).fill(NO_DATA);
    mockDeckGrid[5] = 12.5; // elevated deck cell

    view.update(mockColliders, mockDeckGrid, mockGrid);
    expect(view.group.children.length).toBe(2); // 1 building mesh + 1 deck mesh
    expect((view as any).buildingMesh.castShadow).toBe(false);
    expect((view as any).buildingMesh.receiveShadow).toBe(true);
    expect((view as any).deckMesh.castShadow).toBe(false);
    expect((view as any).deckMesh.receiveShadow).toBe(true);

    view.clear();
    expect(view.group.children.length).toBe(0);
  });

  it('supports switching between arcade and textured modes and styles', () => {
    const view = new BuildingMeshView();
    expect(view.getMode()).toBe('arcade');
    expect(view.getTextureStyle()).toBe('planar');

    view.setMode('textured');
    expect(view.getMode()).toBe('textured');

    view.setTextureStyle('hybrid');
    expect(view.getTextureStyle()).toBe('hybrid');

    view.setTextureStyle('planar');
    expect(view.getTextureStyle()).toBe('planar');

    view.setMode('arcade');
    expect(view.getMode()).toBe('arcade');

    // Setting texture and mapSize works safely without error
    view.setTexture(null, 5600);
  });

  it('firmly anchors building foundations into steep hillside slopes across entire footprint', () => {
    const view = new BuildingMeshView();
    // 40m x 40m building on a steep San Francisco hill
    const mockColliders: BuildingCollider[] = [
      {
        min: new Vector3(0, 40, 0),
        max: new Vector3(40, 65, 40)
      }
    ];

    // Sloped terrain: uphill x=0 is 50m, center x=20 is 40m, downhill x=40 is 30m
    const slopeGround = (x: number, _z: number) => 50 - (x / 40) * 20;

    view.update(mockColliders, undefined, undefined, slopeGround);

    const instMesh = (view as any).buildingMesh as any;
    expect(instMesh).toBeDefined();

    const mat = new Matrix4();
    instMesh.getMatrixAt(0, mat);
    const pos = new Vector3();
    const quat = new Quaternion();
    const scale = new Vector3();
    mat.decompose(pos, quat, scale);

    const bottomY = pos.y - scale.y / 2;
    // Downhill ground is 30m, so foundation must penetrate at least to 30 - 2.5 = 27.5m
    expect(bottomY).toBeLessThanOrEqual(27.5);
    expect(pos.y + scale.y / 2).toBe(65); // Top height preserved

    // Refreshing heights with refined terrain updates instances
    const refinedSlopeGround = (x: number, _z: number) => 48 - (x / 40) * 22; // downhill is 26m
    view.refreshHeights(refinedSlopeGround);
    const refinedMesh = (view as any).buildingMesh as any;
    refinedMesh.getMatrixAt(0, mat);
    mat.decompose(pos, quat, scale);
    const refinedBottomY = pos.y - scale.y / 2;
    expect(refinedBottomY).toBeLessThanOrEqual(23.5); // 26 - 2.5
  });
});

describe('ViewMode input bindings', () => {
  it('binds KeyV and KeyG to viewMode by default', () => {
    const b = new Bindings();
    const k = b.table('keyboard');
    expect(k.viewMode).toEqual([
      { kind: 'key', code: 'KeyV' },
      { kind: 'key', code: 'KeyG' }
    ]);
  });
});

describe('TerrainMesh visual modes', () => {
  it('switches between photoreal, game3d, and textured modes seamlessly', () => {
    const tm = new TerrainMesh();
    const hf = new Heightfield(100, 4, new Float32Array(5 * 5));
    const terrain = createDesertTerrain(hf);
    const mesh = tm.build(terrain, 1);

    expect(mesh).toBeDefined();
    const initialMat = mesh.material;

    tm.setMode('game3d');
    expect(mesh.material).not.toBe(initialMat);

    // Textured and masked modes use the photoreal terrain surface for satellite ground
    tm.setMode('game3d-textured');
    expect(mesh.material).toBe(initialMat);

    tm.setMode('masked-tiles');
    expect(mesh.material).toBe(initialMat);

    tm.setMode('game3d-planar');
    expect(mesh.material).toBe(initialMat);

    tm.setMode('game3d-hybrid');
    expect(mesh.material).toBe(initialMat);

    tm.setMode('photoreal');
    expect(mesh.material).toBe(initialMat);

    tm.dispose();
  });
});

describe('TileClutterFilter modes for Real 3D vs Masked 3D Tiles', () => {
  it('correctly maps off for Real 3D and hidden for Masked 3D Tiles', async () => {
    const { TileClutterFilter } = await import('../src/render/TileClutterFilter.ts');
    const hf = new Heightfield(100, 4, new Float32Array(5 * 5));
    const structure = new Uint8Array(16);
    const filter = new TileClutterFilter(hf, structure, 4);

    expect(filter.mode).toBe('off');

    filter.mode = 'hidden';
    expect(filter.mode).toBe('hidden');
    expect((filter as any).uMode.value).toBe(2);

    filter.mode = 'off';
    expect(filter.mode).toBe('off');
    expect((filter as any).uMode.value).toBe(0);

    filter.dispose();
  });
});

