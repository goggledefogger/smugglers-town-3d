/**
 * Seeded randomness for the simulation.
 *
 * Everything the sim decides at random — spawn jitter, AI choices, landing
 * tumbles — draws from an injected `Rng` rather than `Math.random`, so a
 * match can be replayed from a seed. That is what lets a future server (or
 * a peer) reproduce the same world from the same inputs; see
 * docs/MULTIPLAYER.md.
 */
export type Rng = () => number;

/** mulberry32: small, fast, good enough for gameplay, identical across engines. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
