import { describe, it, expect } from 'vitest';
import { Group, Mesh, PlaneGeometry, BoxGeometry, MeshBasicMaterial } from 'three';
import {
  runNavmeshSpike,
  getActiveNavMeshHelper,
  disposeActiveNavMesh,
  ConnectedNavMeshHelper
} from '../src/spike/navmeshSpike.ts';

describe('Recast Navmesh Spike', () => {
  it('snaps spawn point to street, prunes isolated rooftop, and extracts connected ribbon', async () => {
    const root = new Group();

    // 1. Street road mesh (100m long, 20m wide street at Y = 0)
    const streetGeo = new PlaneGeometry(100, 20, 10, 2);
    streetGeo.rotateX(-Math.PI / 2); // face up
    const streetMesh = new Mesh(streetGeo, new MeshBasicMaterial());
    streetMesh.position.set(0, 0, 0);
    root.add(streetMesh);

    // 2. Disconnected isolated rooftop (20m high box, 25m away from street)
    const roofGeo = new BoxGeometry(20, 20, 20);
    const roofMesh = new Mesh(roofGeo, new MeshBasicMaterial());
    roofMesh.position.set(0, 10, 30); // roof top is at Y = 20
    root.add(roofMesh);

    // Car spawns at (0, 1.2, 0) - hovering 1.2m above street
    const res = await runNavmeshSpike(
      root,
      {
        cs: 1.0,
        ch: 0.2,
        walkableSlopeAngle: 30,
        radiusM: 60,
        centre: { x: 0, y: 1.2, z: 0 }
      },
      () => 0 // ground level
    );

    expect(res.ok).toBe(true);
    expect(res.meshesUsed).toBe(2);
    expect(res.helper).toBeInstanceOf(ConnectedNavMeshHelper);

    // Verify navmesh helper geometry only contains the connected street, NOT the rooftop (Y = 20)
    const posAttr = res.helper!.navMeshGeometry.getAttribute('position');
    expect(posAttr).toBeDefined();
    expect(posAttr.count).toBeGreaterThan(0);

    let maxNavmeshY = -Infinity;
    for (let i = 0; i < posAttr.count; i++) {
      const y = posAttr.getY(i);
      if (y > maxNavmeshY) maxNavmeshY = y;
    }

    // Rooftop was at Y = 20. The street is at Y = 0.
    // Connected navmesh must have pruned the rooftop, so max Y is near street level (< 2m), never rooftop height (~20m).
    expect(maxNavmeshY).toBeLessThan(5.0);

    // Verify active helper getter and disposal
    expect(getActiveNavMeshHelper()).toBe(res.helper);
    disposeActiveNavMesh();
    expect(getActiveNavMeshHelper()).toBeNull();
  });

  it('snaps cleanly even when car elevation has a large datum offset', async () => {
    const root = new Group();
    const streetGeo = new PlaneGeometry(80, 20, 8, 2);
    streetGeo.rotateX(-Math.PI / 2);
    const streetMesh = new Mesh(streetGeo, new MeshBasicMaterial());
    streetMesh.position.set(0, 15, 0); // street sits at Y = 15m
    root.add(streetMesh);

    // Car spawn query provided at Y = 25m (10m above street due to datum shift)
    const res = await runNavmeshSpike(
      root,
      {
        cs: 1.0,
        ch: 0.2,
        walkableSlopeAngle: 30,
        radiusM: 50,
        centre: { x: 0, y: 25, z: 0 }
      },
      () => 15
    );

    expect(res.ok).toBe(true);
    expect(res.helper).toBeDefined();
    disposeActiveNavMesh();
  });
});
