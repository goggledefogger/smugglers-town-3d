import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
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

    view.clear();
    expect(view.group.children.length).toBe(0);
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
  it('switches between photoreal and game3d modes seamlessly', () => {
    const tm = new TerrainMesh();
    const hf = new Heightfield(100, 4, new Float32Array(5 * 5));
    const terrain = createDesertTerrain(hf);
    const mesh = tm.build(terrain, 1);

    expect(mesh).toBeDefined();
    const initialMat = mesh.material;

    tm.setMode('game3d');
    expect(mesh.material).not.toBe(initialMat);

    tm.setMode('photoreal');
    expect(mesh.material).toBe(initialMat);

    tm.dispose();
  });
});
