/**
 * Runs collidersFromRasters off the main thread. A city rebuild is ~30 ms of
 * pure CPU over the tile rasters every 1.5 s while tiles stream, which was a
 * dropped frame or two each time; here it costs the game loop a ~4 ms
 * structured clone of the rasters and nothing else.
 */
import { collidersFromRasters, type Grid, type TileRaster, type ColliderThresholds, DEFAULT_COLLIDER_THRESHOLDS } from './tileColliders.ts';
import type { RoadGrid } from '../osm/roads.ts';

export interface ColliderJob {
  readonly rasters: readonly (TileRaster | null)[];
  readonly grid: Grid;
  readonly terrainTop: Float32Array;
  readonly reliefBoost: number;
  /** OSM road mask, n*n; null when the fetch failed or has not landed yet. */
  readonly roadMask: Uint8Array | null;
  /** Optional collider thresholds/experiment configuration. */
  readonly thresholds?: ColliderThresholds;
}

/** Vector3s do not survive the clone as Vector3s, so the boxes come back plain. */
export interface ColliderResult {
  readonly boxes: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }[];
  readonly deckGrid: Float32Array;
  readonly structureGrid: Uint8Array;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ColliderJob>) => void) | null;
  postMessage: (msg: ColliderResult, transfer: Transferable[]) => void;
};

ctx.onmessage = e => {
  const { rasters, grid, terrainTop, reliefBoost, roadMask, thresholds } = e.data;
  const deckGrid = new Float32Array(grid.n * grid.n);
  const structureGrid = new Uint8Array(grid.n * grid.n);
  const roads: RoadGrid | null = roadMask ? { cell: grid.cell, half: grid.half, n: grid.n, mask: roadMask } : null;
  const activeThresholds = thresholds ?? DEFAULT_COLLIDER_THRESHOLDS;
  const boxes = collidersFromRasters(rasters, grid, terrainTop, reliefBoost, deckGrid, activeThresholds, structureGrid, roads)
    .map(b => ({ min: { x: b.min.x, y: b.min.y, z: b.min.z }, max: { x: b.max.x, y: b.max.y, z: b.max.z } }));
  ctx.postMessage({ boxes, deckGrid, structureGrid }, [deckGrid.buffer, structureGrid.buffer]);
};
