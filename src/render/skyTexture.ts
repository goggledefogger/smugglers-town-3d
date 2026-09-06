/**
 * Equirectangular sky painted once on a canvas: zenith-to-horizon gradient,
 * a sun disc with glow at the light's direction, a soft cloud band just
 * above the horizon and warm haze below it. One texture, no per-frame cost.
 */
import { CanvasTexture, EquirectangularReflectionMapping, SRGBColorSpace, Vector3 } from 'three';
import { SKY_COLORS } from '../core/theme.ts';

export const SKY_ZENITH = SKY_COLORS.zenith;
export const SKY_HORIZON = SKY_COLORS.horizon;
/** Hemisphere-light sky tint: between zenith and horizon. */
export const SKY_MID_LIGHT = SKY_COLORS.midLight;
const SKY_MID = SKY_COLORS.mid;
const HAZE = SKY_COLORS.haze;

const hex = (c: number): string => '#' + c.toString(16).padStart(6, '0');

/** Tiny deterministic PRNG so the sky is the same every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function makeSkyTexture(sunDir: Vector3, w = 2048, h = 1024): CanvasTexture {
  if (typeof document === 'undefined') {
    const t = new CanvasTexture({} as HTMLCanvasElement);
    t.mapping = EquirectangularReflectionMapping;
    t.colorSpace = SRGBColorSpace;
    return t;
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  // canvas top = zenith (v = 1), bottom = nadir; the horizon is the middle row
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, hex(SKY_ZENITH));
  sky.addColorStop(0.3, hex(SKY_MID));
  sky.addColorStop(0.5, hex(SKY_HORIZON));
  sky.addColorStop(0.53, hex(HAZE));
  sky.addColorStop(1, '#182436');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // anything near the left/right edge is drawn again one width over, so the
  // equirect wrap (u = 0/1) has no seam
  const wrapped = (x: number, rad: number, draw: (x: number) => void): void => {
    draw(x);
    if (x - rad < 0) draw(x + w);
    if (x + rad > w) draw(x - w);
  };
  /** Soft radial blob squashed vertically by `squash`. */
  const blob = (x: number, y: number, rad: number, squash: number, stops: [number, string][]): void => {
    wrapped(x, rad, cx => {
      const g = ctx.createRadialGradient(cx, y, 0, cx, y, rad);
      for (const [o, c] of stops) g.addColorStop(o, c);
      ctx.save();
      ctx.translate(cx, y);
      ctx.scale(1, squash);
      ctx.translate(-cx, -y);
      ctx.fillStyle = g;
      ctx.fillRect(cx - rad, y - rad, rad * 2, rad * 2);
      ctx.restore();
    });
  };

  // sun: equirect u from azimuth, v from elevation (three's mapping convention)
  const d = sunDir.clone().normalize();
  const u = Math.atan2(d.z, d.x) / (2 * Math.PI) + 0.5;
  const v = Math.asin(d.y) / Math.PI + 0.5;
  const sx = (1 - u) * w, sy = (1 - v) * h;
  blob(sx, sy, 260, 1, [
    [0, 'rgba(255,246,220,0.95)'], [0.12, 'rgba(255,236,190,0.55)'],
    [0.5, 'rgba(255,225,170,0.12)'], [1, 'rgba(255,225,170,0)']
  ]);
  ctx.fillStyle = '#fff9e6';
  wrapped(sx, 22, cx => {
    ctx.beginPath();
    ctx.arc(cx, sy, 22, 0, Math.PI * 2);
    ctx.fill();
  });

  // clouds: soft flattened blobs in a band 4-25° above the horizon, brighter
  // toward the sun side
  const r = rng(7);
  const band0 = h * (0.5 - 25 / 180), band1 = h * (0.5 - 4 / 180);
  for (let i = 0; i < 90; i++) {
    const x = r() * w, y = band0 + r() * (band1 - band0);
    const rad = 40 + r() * 110;
    const sunny = 0.75 + 0.25 * Math.cos(((x - sx) / w) * 2 * Math.PI);
    blob(x, y, rad, 0.42 + r() * 0.2, [
      [0, `rgba(255,255,255,${0.42 * sunny})`], [0.55, `rgba(245,248,252,${0.2 * sunny})`], [1, 'rgba(240,245,250,0)']
    ]);
  }
  // a few high wisps
  for (let i = 0; i < 14; i++) {
    const x = r() * w, y = h * (0.5 - (30 + r() * 25) / 180);
    blob(x, y, 120 + r() * 160, 0.18, [[0, 'rgba(255,255,255,0.16)'], [1, 'rgba(255,255,255,0)']]);
  }

  const t = new CanvasTexture(c);
  t.mapping = EquirectangularReflectionMapping;
  t.colorSpace = SRGBColorSpace;
  return t;
}
