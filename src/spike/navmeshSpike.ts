/**
 * SPIKE (temporary): can Recast produce a single connected drivable surface from
 * Google 3D Tiles where the 10 m raster pipeline shatters it into ~1000 pockets?
 *
 * Measures on the metric that exposed the problem: from the spawn, what fraction
 * of the surrounding street surface can actually be reached.
 */
import { Box3, Vector3, type Mesh, type Object3D } from 'three';
import { init, NavMeshQuery } from 'recast-navigation';
import { threeToSoloNavMesh } from '@recast-navigation/three';

export interface SpikeParams {
  /** Recast cell size in metres: the knob the 10 m raster could not turn. */
  cs: number;
  ch: number;
  /** Max drivable incline. SF's steepest streets are 31.5% = 17.5 deg. */
  walkableSlopeAngle: number;
  /** Half-radius of the box around the centre that the navmesh is built for. */
  radiusM: number;
  centre: { x: number; y: number; z: number };
}

export interface SpikeResult {
  params: SpikeParams;
  meshesUsed: number; trisUsed: number;
  buildMs: number; queryMs: number;
  ok: boolean; error?: string;
  navmeshBytes: number;
  sampled: number; onSurface: number; reachable: number;
  reachablePctOfSurface: number;
}

const CAR_HEIGHT_M = 2.5, CAR_RADIUS_M = 1.5, CURB_M = 0.4;

export async function runNavmeshSpike(
  root: Object3D,
  p: SpikeParams,
  /** Ground height at a world point, so sampling anchors to street level not rooftops. */
  groundAt: (x: number, z: number) => number
): Promise<SpikeResult> {
  await init();
  const half = p.radiusM;
  const box = new Box3(
    new Vector3(p.centre.x - half, -Infinity, p.centre.z - half),
    new Vector3(p.centre.x + half, Infinity, p.centre.z + half)
  );
  const meshes: Mesh[] = [];
  let tris = 0;
  const mb = new Box3();
  root.traverse(o => {
    const m = o as Mesh;
    if (!m.isMesh || !m.geometry) return;
    mb.setFromObject(m);
    if (mb.max.x < box.min.x || mb.min.x > box.max.x || mb.max.z < box.min.z || mb.min.z > box.max.z) return;
    meshes.push(m);
    tris += (m.geometry.getAttribute('position')?.count ?? 0) / 3;
  });
  const base: SpikeResult = {
    params: p, meshesUsed: meshes.length, trisUsed: Math.round(tris),
    buildMs: 0, queryMs: 0, ok: false, navmeshBytes: 0,
    sampled: 0, onSurface: 0, reachable: 0, reachablePctOfSurface: 0
  };
  if (!meshes.length) return { ...base, error: 'no meshes in region' };

  const t0 = performance.now();
  let navMesh;
  try {
    const r = threeToSoloNavMesh(meshes, {
      cs: p.cs, ch: p.ch,
      walkableSlopeAngle: p.walkableSlopeAngle,
      walkableHeight: Math.ceil(CAR_HEIGHT_M / p.ch),
      walkableClimb: Math.ceil(CURB_M / p.ch),
      walkableRadius: Math.ceil(CAR_RADIUS_M / p.cs),
      maxEdgeLen: Math.round(12 / p.cs),
      maxSimplificationError: 1.3,
      minRegionArea: Math.round(8 / (p.cs * p.cs)),
      mergeRegionArea: Math.round(20 / (p.cs * p.cs)),
      maxVertsPerPoly: 6,
      detailSampleDist: 6, detailSampleMaxError: 1
    });
    if (!r.success || !r.navMesh) return { ...base, buildMs: performance.now() - t0, error: r.error ?? 'generation failed' };
    navMesh = r.navMesh;
  } catch (e) {
    return { ...base, buildMs: performance.now() - t0, error: String(e).slice(0, 200) };
  }
  const buildMs = performance.now() - t0;

  const t1 = performance.now();
  const query = new NavMeshQuery(navMesh);
  // anchor to street level: a wide vertical search snaps samples onto roofs, which
  // Recast rightly calls walkable but which no car can reach
  const EXT = { x: 4, y: 4, z: 4 };
  const start = query.findClosestPoint({ x: p.centre.x, y: p.centre.y, z: p.centre.z }, { halfExtents: EXT });
  if (!start.success) {
    // where did the navmesh actually land vs where the car is?
    const wb = new Box3();
    for (const m of meshes) wb.expandByObject(m);
    const c = wb.getCenter(new Vector3());
    const probe = query.findClosestPoint({ x: c.x, y: c.y, z: c.z }, { halfExtents: { x: 5000, y: 5000, z: 5000 } });
    navMesh.destroy();
    return { ...base, buildMs, error:
      `spawn off navmesh. car=(${p.centre.x.toFixed(0)},${p.centre.y.toFixed(0)},${p.centre.z.toFixed(0)}) ` +
      `meshWorldBox=(${wb.min.x.toFixed(0)},${wb.min.y.toFixed(0)},${wb.min.z.toFixed(0)})-(${wb.max.x.toFixed(0)},${wb.max.y.toFixed(0)},${wb.max.z.toFixed(0)}) ` +
      `wideProbe=${probe.success ? `hit(${probe.point.x.toFixed(0)},${probe.point.y.toFixed(0)},${probe.point.z.toFixed(0)})` : 'MISS'}` };
  }
  let sampled = 0, onSurface = 0, reachable = 0;
  const STEP = Math.max(20, Math.round(half / 12));
  for (let dx = -half; dx <= half; dx += STEP) {
    for (let dz = -half; dz <= half; dz += STEP) {
      sampled++;
      const tx = p.centre.x + dx, tz = p.centre.z + dz;
      const target = { x: tx, y: groundAt(tx, tz) + 1, z: tz };
      const hit = query.findClosestPoint(target, { halfExtents: EXT });
      // findClosestPoint snaps to the navmesh; only count it if it stayed near the sample
      if (!hit.success || Math.hypot(hit.point.x - target.x, hit.point.z - target.z) > STEP * 0.5) continue;
      onSurface++;
      const path = query.computePath(start.point, hit.point);
      if (!path.success || path.path.length === 0) continue;
      const end = path.path[path.path.length - 1]!;
      if (Math.hypot(end.x - hit.point.x, end.z - hit.point.z) < 3) reachable++;
    }
  }
  const queryMs = performance.now() - t1;
  let navmeshBytes = 0;
  try { navmeshBytes = (navMesh as unknown as { getTileCount?: () => number }).getTileCount?.() ?? 0; } catch { /* informational only */ }
  navMesh.destroy();
  return {
    ...base, ok: true, buildMs, queryMs, navmeshBytes,
    sampled, onSurface, reachable,
    reachablePctOfSurface: onSurface ? (reachable / onSurface) * 100 : 0
  };
}
