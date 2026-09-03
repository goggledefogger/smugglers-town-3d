/**
 * Procedural vehicle textures drawn on canvases at startup, cached per
 * (type, team). Liveries carry the team paint color, so materials that use
 * them keep a white base color. All textures are sRGB.
 */
import { CanvasTexture, SRGBColorSpace, RepeatWrapping } from 'three';
import { VEHICLE_TYPES, type VehicleStats } from '../core/physics/vehicleStats.ts';

const cache = new Map<string, CanvasTexture>();

function texture(key: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): CanvasTexture {
  let t = cache.get(key);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  cache.set(key, t);
  return t;
}

const hex = (c: number): string => '#' + c.toString(16).padStart(6, '0');

/** Tiny deterministic PRNG so scuffs are the same every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const NUMBERS = [7, 22, 11, 55, 88];

function raceNumber(stats: VehicleStats): number {
  return NUMBERS[VEHICLE_TYPES.indexOf(stats)] ?? 1;
}

/**
 * Side panel, 4:1. `mirror` flips the shapes for the left side (box UVs put
 * the front at opposite ends of the two sides) while the number stays legible.
 */
export function liverySide(stats: VehicleStats, teamColor: number, mirror: boolean): CanvasTexture {
  const n = raceNumber(stats);
  return texture(`side:${n}:${teamColor}:${mirror}`, 512, 128, ctx => {
    const W = 512, H = 128;
    const X = (x: number): number => (mirror ? W - x : x);
    ctx.fillStyle = hex(teamColor);
    ctx.fillRect(0, 0, W, H);
    // panel shading: lighter shoulder, darker sill
    const shade = ctx.createLinearGradient(0, 0, 0, H);
    shade.addColorStop(0, 'rgba(255,255,255,0.18)');
    shade.addColorStop(0.55, 'rgba(255,255,255,0)');
    shade.addColorStop(1, 'rgba(0,0,0,0.25)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, W, H);
    // rocker band
    ctx.fillStyle = '#1c1c20';
    ctx.fillRect(0, 104, W, 24);
    // swept accent stripe
    ctx.fillStyle = hex(stats.color);
    ctx.beginPath();
    ctx.moveTo(X(0), 44);
    ctx.lineTo(X(400), 44);
    ctx.lineTo(X(440), 68);
    ctx.lineTo(X(0), 68);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(mirror ? W - 400 : 0, 70, 400, 4);
    // door seams + handle
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 2;
    for (const x of [170, 330]) {
      ctx.beginPath();
      ctx.moveTo(X(x), 12);
      ctx.lineTo(X(x), 104);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(X(215) - 12, 84, 24, 5);
    // number roundel
    ctx.fillStyle = '#f4ead8';
    ctx.beginPath();
    ctx.arc(X(300), 52, 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a1410';
    ctx.font = '900 44px Inter, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), X(300), 54);
    // grime and scuffs low on the panel
    const dirt = ctx.createLinearGradient(0, 80, 0, H);
    dirt.addColorStop(0, 'rgba(70,50,30,0)');
    dirt.addColorStop(1, 'rgba(70,50,30,0.55)');
    ctx.fillStyle = dirt;
    ctx.fillRect(0, 80, W, H - 80);
    const r = rng(n * 7919 + teamColor);
    for (let i = 0; i < 40; i++) {
      const x = r() * W, y = 60 + r() * 68, s = 2 + r() * 10;
      ctx.fillStyle = r() < 0.6 ? `rgba(0,0,0,${0.12 + r() * 0.2})` : `rgba(255,255,255,${0.1 + r() * 0.15})`;
      ctx.beginPath();
      ctx.ellipse(x, y, s, s * 0.35, r() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

/** Roof/hood panel, 1:2 with the front at the top. */
export function liveryTop(stats: VehicleStats, teamColor: number): CanvasTexture {
  const n = raceNumber(stats);
  return texture(`top:${n}:${teamColor}`, 256, 512, ctx => {
    const W = 256, H = 512;
    ctx.fillStyle = hex(teamColor);
    ctx.fillRect(0, 0, W, H);
    const shade = ctx.createLinearGradient(0, 0, W, 0);
    shade.addColorStop(0, 'rgba(0,0,0,0.18)');
    shade.addColorStop(0.5, 'rgba(255,255,255,0.12)');
    shade.addColorStop(1, 'rgba(0,0,0,0.18)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, W, H);
    // twin racing stripes down the length
    ctx.fillStyle = hex(stats.color);
    ctx.fillRect(96, 0, 22, H);
    ctx.fillRect(138, 0, 22, H);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(120, 0, 4, H);
    ctx.fillRect(132, 0, 4, H);
    // hood vents near the front
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    for (let i = 0; i < 4; i++) ctx.fillRect(40, 40 + i * 14, 176, 5);
    // roof number
    ctx.fillStyle = 'rgba(244,234,216,0.9)';
    ctx.font = '900 96px Inter, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), W / 2, H * 0.62);
    // panel seams
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 2;
    for (const y of [150, 330]) {
      ctx.beginPath();
      ctx.moveTo(8, y);
      ctx.lineTo(W - 8, y);
      ctx.stroke();
    }
  });
}

/** Tire tread, repeated around the circumference. */
export function tread(): CanvasTexture {
  const t = texture('tread', 128, 64, ctx => {
    ctx.fillStyle = '#141414';
    ctx.fillRect(0, 0, 128, 64);
    ctx.fillStyle = '#2a2a2a';
    // chevron lugs
    for (let x = 0; x < 128; x += 32) {
      ctx.beginPath();
      ctx.moveTo(x + 4, 4);
      ctx.lineTo(x + 20, 4);
      ctx.lineTo(x + 30, 32);
      ctx.lineTo(x + 20, 60);
      ctx.lineTo(x + 4, 60);
      ctx.lineTo(x + 14, 32);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 30, 128, 4);
  });
  t.wrapS = RepeatWrapping;
  t.repeat.set(8, 1);
  return t;
}

/** Tire sidewall with a spoked rim in the middle, mapped onto the wheel caps. */
export function sidewall(): CanvasTexture {
  return texture('sidewall', 256, 256, ctx => {
    const c = 128;
    ctx.fillStyle = '#151515';
    ctx.beginPath();
    ctx.arc(c, c, 128, 0, Math.PI * 2);
    ctx.fill();
    // sidewall lettering ticks
    ctx.strokeStyle = '#2e2e2e';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(c, c, 104, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#3a3a3a';
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      ctx.fillRect(c + Math.cos(a) * 112 - 2, c + Math.sin(a) * 112 - 5, 4, 10);
    }
    // rim
    const rim = ctx.createRadialGradient(c - 20, c - 20, 10, c, c, 80);
    rim.addColorStop(0, '#e8ecef');
    rim.addColorStop(1, '#8e969c');
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.arc(c, c, 78, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1e2124';
    for (let i = 0; i < 6; i++) {
      const a0 = (i / 6) * Math.PI * 2 + 0.18, a1 = ((i + 1) / 6) * Math.PI * 2 - 0.18;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a0) * 30, c + Math.sin(a0) * 30);
      ctx.arc(c, c, 66, a0, a1);
      ctx.lineTo(c + Math.cos(a1) * 30, c + Math.sin(a1) * 30);
      ctx.closePath();
      ctx.fill();
    }
    // hub + bolts
    ctx.fillStyle = '#44494e';
    ctx.beginPath();
    ctx.arc(c, c, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d8dde0';
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(c + Math.cos(a) * 13, c + Math.sin(a) * 13, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}
