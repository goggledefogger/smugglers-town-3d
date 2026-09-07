/**
 * SPIKE: Recast navigation mesh generation from Google 3D Tiles.
 * Produces a single connected drivable surface across streets,
 * pruning disjoint rooftop polygons via floodFillPruneNavMesh.
 */
import {
  Box3, Vector3, Mesh, type Object3D,
  MeshBasicMaterial, DoubleSide, BufferAttribute
} from 'three';
import { init, NavMeshQuery, type NavMesh } from 'recast-navigation';
import { threeToSoloNavMesh, NavMeshHelper } from '@recast-navigation/three';
import { getNavMeshPositionsAndIndices } from '@recast-navigation/core';

export class ConnectedNavMeshHelper extends NavMeshHelper {
  override update(): void {
    // Flag 1 ensures only active polygons connected to the spawn are rendered;
    // floodFillPruneNavMesh disabled unvisited rooftop polygons by setting their flag to 0.
    const [positions, indices] = getNavMeshPositionsAndIndices(this.navMesh, 1);
    this.navMeshGeometry.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3));
    this.navMeshGeometry.setIndex(new BufferAttribute(Uint32Array.from(indices), 1));
    this.navMeshGeometry.computeVertexNormals();
  }
}

export interface SpikeParams {
  /** Recast cell size in metres: 1.0 - 2.0 m. */
  cs: number;
  /** Recast cell height in metres: 0.2 - 0.4 m. */
  ch: number;
  /** Max drivable incline in degrees. SF steep hills are ~18-30 deg. */
  walkableSlopeAngle: number;
  /** Half-radius in meters of the box around the centre to build. */
  radiusM: number;
  centre: { x: number; y: number; z: number };
  /** Curb / step climb height in metres. Default 0.8m. */
  walkableClimbM?: number;
  /** Vehicle half-width radius for wall erosion. Default 1.4m. */
  carRadiusM?: number;
  /** Vehicle clearance height in metres. Default 2.5m. */
  carHeightM?: number;
}

export interface SpikeResult {
  params: SpikeParams;
  meshesUsed: number;
  trisUsed: number;
  totalPolys?: number;
  connectedPolys?: number;
  prunedPolys?: number;
  buildMs: number;
  queryMs: number;
  ok: boolean;
  error?: string;
  navmeshBytes: number;
  sampled: number;
  onSurface: number;
  reachable: number;
  reachablePctOfSurface: number;
  startPoint?: { x: number; y: number; z: number };
  navMesh?: NavMesh;
  helper?: NavMeshHelper;
}

const CAR_HEIGHT_M = 2.5;
const CAR_RADIUS_M = 1.4;
// Curb / clutter height: 0.8m allows the navmesh to climb over street curbs
// and melted photogrammetry car bumps without blocking the roadway
const CLIMB_M = 0.8;

let activeNavMesh: NavMesh | null = null;
let activeNavMeshHelper: NavMeshHelper | null = null;

export function getActiveNavMeshHelper(): NavMeshHelper | null {
  return activeNavMeshHelper;
}

export function disposeActiveNavMesh(): void {
  if (activeNavMeshHelper) {
    activeNavMeshHelper.parent?.remove(activeNavMeshHelper);
    activeNavMeshHelper = null;
  }
  if (activeNavMesh) {
    try {
      activeNavMesh.destroy();
    } catch {}
    activeNavMesh = null;
  }
}

export async function runNavmeshSpike(
  root: Object3D,
  p: SpikeParams,
  /** Ground height at a world point, so sampling anchors to street level not rooftops. */
  groundAt: (x: number, z: number) => number
): Promise<SpikeResult> {
  await init();

  // 1. Ensure world matrices are completely updated throughout the tile hierarchy
  root.updateMatrixWorld(true);

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
    m.updateMatrixWorld(true);
    mb.setFromObject(m);
    if (mb.max.x < box.min.x || mb.min.x > box.max.x || mb.max.z < box.min.z || mb.min.z > box.max.z) return;
    meshes.push(m);
    tris += (m.geometry.getAttribute('position')?.count ?? 0) / 3;
  });

  const base: SpikeResult = {
    params: p,
    meshesUsed: meshes.length,
    trisUsed: Math.round(tris),
    buildMs: 0,
    queryMs: 0,
    ok: false,
    navmeshBytes: 0,
    sampled: 0,
    onSurface: 0,
    reachable: 0,
    reachablePctOfSurface: 0
  };

  if (!meshes.length) return { ...base, error: 'no meshes in region' };

  // 2. Build the Solo NavMesh at 1-2m resolution
  const t0 = performance.now();
  let navMesh: NavMesh;
  try {
    const r = threeToSoloNavMesh(meshes, {
      cs: p.cs,
      ch: p.ch,
      walkableSlopeAngle: p.walkableSlopeAngle,
      walkableHeight: Math.ceil((p.carHeightM ?? CAR_HEIGHT_M) / p.ch),
      walkableClimb: Math.ceil((p.walkableClimbM ?? CLIMB_M) / p.ch),
      walkableRadius: p.carRadiusM !== undefined ? Math.ceil(p.carRadiusM / p.cs) : Math.ceil(CAR_RADIUS_M / p.cs),
      maxEdgeLen: Math.round(12 / p.cs),
      maxSimplificationError: 1.3,
      minRegionArea: 2,
      mergeRegionArea: 6,
      maxVertsPerPoly: 6,
      detailSampleDist: 6,
      detailSampleMaxError: 1
    });
    if (!r.success || !r.navMesh) {
      return { ...base, buildMs: performance.now() - t0, error: r.error ?? 'generation failed' };
    }
    navMesh = r.navMesh;
  } catch (e) {
    return { ...base, buildMs: performance.now() - t0, error: String(e).slice(0, 200) };
  }
  const buildMs = performance.now() - t0;

  // 3. Query spawn location across vehicle footprint candidates to snap cleanly to the street
  const t1 = performance.now();
  const query = new NavMeshQuery(navMesh);

  // Broad vertical halfExtents (+/- 35m) so datum offset / hill elevation differences find the street
  const spawnExtents = { x: 8, y: 35, z: 8 };

  const footprintOffsets = [
    { x: 0, z: 0 },
    { x: -1.5, z: 0 },
    { x: 1.5, z: 0 },
    { x: 0, z: 2.0 },
    { x: 0, z: -2.0 },
    { x: -3.0, z: 0 },
    { x: 3.0, z: 0 }
  ];

  interface Candidate {
    ref: number;
    point: Vector3;
    islandSize: number;
  }

  const candidates: Candidate[] = [];
  const seenRefs = new Set<number>();

  for (const off of footprintOffsets) {
    const qx = p.centre.x + off.x;
    const qz = p.centre.z + off.z;
    const probe = query.findNearestPoly(
      { x: qx, y: p.centre.y, z: qz },
      { halfExtents: spawnExtents }
    );
    if (probe.success && probe.nearestRef && !seenRefs.has(probe.nearestRef)) {
      seenRefs.add(probe.nearestRef);
      // Fast BFS to measure island size
      const visited = new Set<number>();
      const open = [probe.nearestRef];
      visited.add(probe.nearestRef);
      while (open.length > 0) {
        const ref = open.pop()!;
        const { poly, tile } = navMesh.getTileAndPolyByRefUnsafe(ref);
        for (let i = poly.firstLink(); i !== -1 && i !== 4294967295; i = tile.links(i).next()) {
          const nei = tile.links(i).ref();
          if (!nei || visited.has(nei)) continue;
          visited.add(nei);
          open.push(nei);
        }
      }
      candidates.push({
        ref: probe.nearestRef,
        point: new Vector3(probe.nearestPoint.x, probe.nearestPoint.y, probe.nearestPoint.z),
        islandSize: visited.size
      });
    }
  }

  // If center queries failed, fallback to groundAt elevation
  if (candidates.length === 0) {
    const gY = groundAt(p.centre.x, p.centre.z);
    const probe = query.findNearestPoly(
      { x: p.centre.x, y: gY, z: p.centre.z },
      { halfExtents: { x: 12, y: 50, z: 12 } }
    );
    if (probe.success && probe.nearestRef) {
      candidates.push({
        ref: probe.nearestRef,
        point: new Vector3(probe.nearestPoint.x, probe.nearestPoint.y, probe.nearestPoint.z),
        islandSize: 1
      });
    }
  }

  // Enumerate all connected islands in the navmesh and compute their average elevation relative to ground
  interface IslandInfo {
    startRef: number;
    size: number;
    refs: number[];
    avgElevationDelta: number;
  }

  const allVisited = new Set<number>();
  const islands: IslandInfo[] = [];

  for (let tileIndex = 0; tileIndex < navMesh.getMaxTiles(); tileIndex++) {
    const tile = navMesh.getTile(tileIndex);
    const header = tile?.header();
    if (!tile || !header) continue;
    const base = navMesh.getPolyRefBase(tile);
    for (let i = 0; i < header.polyCount(); i++) {
      const ref = base | i;
      if (allVisited.has(ref)) continue;
      const refs: number[] = [];
      let totalElevDiff = 0;
      const q = [ref];
      allVisited.add(ref);
      while (q.length > 0) {
        const curr = q.pop()!;
        refs.push(curr);
        const { poly: pObj, tile: tObj } = navMesh.getTileAndPolyByRefUnsafe(curr);
        const vertCount = pObj.vertCount();
        let cx = 0, cy = 0, cz = 0;
        for (let v = 0; v < vertCount; v++) {
          const vi = pObj.verts(v);
          cx += tObj.verts(vi * 3);
          cy += tObj.verts(vi * 3 + 1);
          cz += tObj.verts(vi * 3 + 2);
        }
        cx /= vertCount;
        cy /= vertCount;
        cz /= vertCount;
        const gY = groundAt(cx, cz);
        totalElevDiff += (cy - gY);

        for (let l = pObj.firstLink(); l !== -1 && l !== 4294967295; l = tObj.links(l).next()) {
          const nei = tObj.links(l).ref();
          if (!nei || allVisited.has(nei)) continue;
          allVisited.add(nei);
          q.push(nei);
        }
      }
      islands.push({
        startRef: ref,
        size: refs.length,
        refs,
        avgElevationDelta: totalElevDiff / refs.length
      });
    }
  }

  islands.sort((a, b) => b.size - a.size);
  console.log(`[navmesh] Total islands: ${islands.length}. Top 10 sizes:`, islands.slice(0, 10).map(x => x.size));

  // Sort candidates by islandSize descending, then distance to center ascending
  candidates.sort((a, b) => {
    if (b.islandSize !== a.islandSize) return b.islandSize - a.islandSize;
    const distA = Math.hypot(a.point.x - p.centre.x, a.point.y - p.centre.y, a.point.z - p.centre.z);
    const distB = Math.hypot(b.point.x - p.centre.x, b.point.y - p.centre.y, b.point.z - p.centre.z);
    return distA - distB;
  });

  let startPolyRef = 0;
  const startPoint = new Vector3();

  if (candidates.length > 0) {
    startPolyRef = candidates[0]!.ref;
    startPoint.copy(candidates[0]!.point);
  }

  // Fallback: If candidate island is tiny but there is an enormous street island, find the closest poly on the main island
  if (islands.length > 0 && islands[0]!.size > 50 && (!candidates[0] || candidates[0].islandSize < 50)) {
    let closestRef = 0;
    let minDist = Infinity;
    const closestPt = new Vector3();
    for (const ref of islands[0]!.refs) {
      const { poly: pObj, tile: tObj } = navMesh.getTileAndPolyByRefUnsafe(ref);
      const vertCount = pObj.vertCount();
      let cx = 0, cy = 0, cz = 0;
      for (let v = 0; v < vertCount; v++) {
        const vi = pObj.verts(v);
        cx += tObj.verts(vi * 3);
        cy += tObj.verts(vi * 3 + 1);
        cz += tObj.verts(vi * 3 + 2);
      }
      cx /= vertCount;
      cy /= vertCount;
      cz /= vertCount;
      const d = Math.hypot(cx - p.centre.x, cy - p.centre.y, cz - p.centre.z);
      if (d < minDist) {
        minDist = d;
        closestRef = ref;
        closestPt.set(cx, cy, cz);
      }
    }
    if (closestRef) {
      startPolyRef = closestRef;
      startPoint.copy(closestPt);
    }
  }

  if (!startPolyRef) {
    const wb = new Box3();
    for (const m of meshes) wb.expandByObject(m);
    const wide = query.findClosestPoint(
      { x: p.centre.x, y: p.centre.y, z: p.centre.z },
      { halfExtents: { x: 5000, y: 5000, z: 5000 } }
    );
    navMesh.destroy();
    return {
      ...base,
      buildMs,
      error: `spawn off navmesh at (${p.centre.x.toFixed(1)}, ${p.centre.y.toFixed(1)}, ${p.centre.z.toFixed(1)}). meshBox=(${wb.min.x.toFixed(1)},${wb.min.y.toFixed(1)},${wb.min.z.toFixed(1)})-(${wb.max.x.toFixed(1)},${wb.max.y.toFixed(1)},${wb.max.z.toFixed(1)}). wideProbe=${wide.success ? `hit(${wide.point.x.toFixed(1)},${wide.point.y.toFixed(1)},${wide.point.z.toFixed(1)}) dist=${Math.hypot(wide.point.x - p.centre.x, wide.point.y - p.centre.y, wide.point.z - p.centre.z).toFixed(1)}` : 'MISS'}`
    };
  }

  // 4. Smart Rooftop Pruning:
  // Instead of throwing away all cross streets and adjacent avenues, we:
  // - KEEP the island containing spawn (always)
  // - KEEP any street island close to ground level (avgElevationDelta <= 4.0m) with size >= 6
  // - KEEP any large street network (size >= 25) with avgElevationDelta <= 7.0m
  // - PRUNE isolated high-elevation building rooftops (avgElevationDelta > 4.5m) and tiny debris (< 6 polys)
  let totalPolys = 0;
  let keptPolys = 0;

  for (const isl of islands) {
    totalPolys += isl.size;
    const isSpawnIsland = isl.refs.includes(startPolyRef);
    const isNearGround = isl.avgElevationDelta <= 4.0;
    const isLarge = isl.size >= 25 && isl.avgElevationDelta <= 7.0;
    const isSubstantialGroundStreet = isNearGround && isl.size >= 6;

    const shouldKeep = isSpawnIsland || isSubstantialGroundStreet || isLarge;

    const flag = shouldKeep ? 1 : 0;
    for (const r of isl.refs) {
      navMesh.setPolyFlags(r, flag);
    }
    if (shouldKeep) {
      keptPolys += isl.size;
    }
  }

  console.log(`[navmesh] Polygons: total=${totalPolys}, keptStreets=${keptPolys}, prunedRooftops=${totalPolys - keptPolys}, mainIsland=${islands[0]?.size}`);

  // 5. Measure reachability across the pruned street network
  let sampled = 0, onSurface = 0, reachable = 0;
  const STEP = Math.max(20, Math.round(half / 12));
  const sampleExtents = { x: 6, y: 35, z: 6 };

  for (let dx = -half; dx <= half; dx += STEP) {
    for (let dz = -half; dz <= half; dz += STEP) {
      sampled++;
      const tx = p.centre.x + dx, tz = p.centre.z + dz;
      const target = { x: tx, y: groundAt(tx, tz) + 1, z: tz };
      const hit = query.findNearestPoly(target, { halfExtents: sampleExtents });
      if (
        !hit.success ||
        !hit.nearestRef ||
        Math.hypot(hit.nearestPoint.x - target.x, hit.nearestPoint.z - target.z) > STEP * 0.5
      ) {
        continue;
      }
      // Check if polygon is active (non-zero flag)
      const { poly } = navMesh.getTileAndPolyByRefUnsafe(hit.nearestRef);
      if (poly.flags() === 0) continue;

      onSurface++;
      const path = query.computePath(startPoint, hit.nearestPoint);
      if (!path.success || path.path.length === 0) continue;
      const end = path.path[path.path.length - 1]!;
      if (Math.hypot(end.x - hit.nearestPoint.x, end.z - hit.nearestPoint.z) < 3) {
        reachable++;
      }
    }
  }
  const queryMs = performance.now() - t1;

  // 6. Create Three.js NavMesh visual helper showing only the connected street ribbon
  const helper = new ConnectedNavMeshHelper(navMesh, {
    navMeshMaterial: new MeshBasicMaterial({
      color: 0x00e5ff, // vibrant arcade cyan
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      side: DoubleSide
    })
  });
  // Lift slightly above road pavement to prevent z-fighting
  helper.position.y += 0.25;

  // Add subtle wireframe overlay so polygon tessellation is crisply visible
  const wire = new Mesh(
    helper.navMeshGeometry,
    new MeshBasicMaterial({
      color: 0xffffff,
      wireframe: true,
      transparent: true,
      opacity: 0.35,
      depthWrite: false
    })
  );
  helper.add(wire);

  // Replace active navmesh
  disposeActiveNavMesh();
  activeNavMesh = navMesh;
  activeNavMeshHelper = helper;

  let navmeshBytes = 0;
  try {
    navmeshBytes = (navMesh as unknown as { getTileCount?: () => number }).getTileCount?.() ?? 0;
  } catch {}

  return {
    ...base,
    ok: true,
    totalPolys,
    connectedPolys: keptPolys,
    prunedPolys: totalPolys - keptPolys,
    buildMs,
    queryMs,
    navmeshBytes,
    sampled,
    onSurface,
    reachable,
    reachablePctOfSurface: onSurface ? (reachable / onSurface) * 100 : 0,
    startPoint: { x: startPoint.x, y: startPoint.y, z: startPoint.z },
    navMesh,
    helper
  };
}
