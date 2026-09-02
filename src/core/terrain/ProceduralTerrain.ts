/**
 * Procedural desert: multi-octave value noise for rolling dunes, one big butte,
 * and a canyon cut. Plays instantly with zero setup — the default match.
 */
import type { Heightfield } from '../heightfield.ts';
import type { TerrainProvider } from './TerrainProvider.ts';

const SEGS = 256;

function hash(i: number, j: number): number {
  let h = (i * 374761393 + j * 668265263) ^ 0x9e3779b9;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) & 0xffff) / 0xffff;
}

function vnoise(x: number, z: number): number {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const a = hash(xi, zi), b = hash(xi + 1, zi);
  const c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
  const sx = xf * xf * (3 - 2 * xf), sz = zf * zf * (3 - 2 * zf);
  const top = a + (b - a) * sx, bot = c + (d - c) * sx;
  return top + (bot - top) * sz;
}

export function generateDesertHeightfieldData(seed = 0): Float32Array {
  const seg = SEGS;
  const data = new Float32Array((seg + 1) * (seg + 1));
  // seed shifts the noise lattice so consecutive matches differ
  const ox = (seed % 97) * 13.7, oz = (seed % 89) * 7.3;
  for (let j = 0; j <= seg; j++) {
    for (let i = 0; i <= seg; i++) {
      const nx = i / seg, nz = j / seg;
      let h = 0, amp = 1, freq = 1, tot = 0;
      for (let o = 0; o < 5; o++) {
        h += vnoise(nx * freq * 4 + ox, nz * freq * 4 + oz) * amp;
        tot += amp; amp *= 0.5; freq *= 2;
      }
      h /= tot;
      h = h * 16;
      const butte = Math.max(0, 1 - Math.abs(nx - 0.5) * 3.5) * Math.max(0, 1 - Math.abs(nz - 0.68) * 3.5);
      h += butte * 40;
      const canyon = (1 - Math.min(1, Math.abs(nz - 0.25) * 6)) * 14;
      h -= canyon;
      data[j * (seg + 1) + i] = h;
    }
  }
  return data;
}

export function createDesertTerrain(heightfield: Heightfield): TerrainProvider {
  return {
    label: 'Procedural Desert',
    isReal: false,
    heightfield,
    satelliteCanvas: null,
    reliefBoost: 1,
    datumAltM: 0
  };
}
