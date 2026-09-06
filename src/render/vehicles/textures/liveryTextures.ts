import { CanvasTexture, SRGBColorSpace } from 'three';
import { VEHICLE_TYPES, type VehicleStats } from '../../../core/physics/vehicleStats.ts';
import {
  drawSubwayBubbleGraffiti,
  drawDriftTagGraffiti,
  drawMilitaryStencilGraffiti,
  drawChromeWildstyleGraffiti,
  drawPunkDripTagGraffiti,
  drawBlockbusterGraffiti,
  drawMopDripGraffiti,
  drawAcidPsychedelicGraffiti,
  drawCyberpunkNeonTag,
  drawStickerSlapGraffiti
} from './graffiti.ts';

const cache = new Map<string, CanvasTexture>();

function texture(key: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): CanvasTexture {
  let t = cache.get(key);
  if (t) return t;
  if (typeof document === 'undefined') {
    // Headless / Node vitest fallback
    t = new CanvasTexture({} as HTMLCanvasElement);
    t.colorSpace = SRGBColorSpace;
    cache.set(key, t);
    return t;
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (ctx) draw(ctx);
  t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  cache.set(key, t);
  return t;
}

const hex = (c: number): string => '#' + c.toString(16).padStart(6, '0');

/** Tiny deterministic PRNG so scuffs and splatters are identical across runs. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const NUMBERS = [7, 22, 11, 55, 88];

export function raceNumber(stats: VehicleStats): number {
  return NUMBERS[VEHICLE_TYPES.indexOf(stats)] ?? 1;
}

/**
 * Side panel (512x128). Renders prominent archetype-specific "TOWN" graffiti
 * on the doors and quarter panels alongside the race number.
 * `mirror` places elements on the left side while keeping text legible.
 */
export function liverySide(stats: VehicleStats, teamColor: number, mirror: boolean): CanvasTexture {
  const n = raceNumber(stats);
  return texture(`side:${stats.name}:${n}:${teamColor}:${mirror}`, 512, 128, ctx => {
    const W = 512, H = 128;
    const X = (x: number): number => (mirror ? W - x : x);

    ctx.fillStyle = hex(teamColor);
    ctx.fillRect(0, 0, W, H);

    // Panel shading: lighter shoulder, darker sill
    const shade = ctx.createLinearGradient(0, 0, 0, H);
    shade.addColorStop(0, 'rgba(255,255,255,0.18)');
    shade.addColorStop(0.55, 'rgba(255,255,255,0)');
    shade.addColorStop(1, 'rgba(0,0,0,0.25)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, W, H);

    // Lower rocker band
    ctx.fillStyle = '#1c1c20';
    ctx.fillRect(0, 104, W, 24);

    // Swept accent stripe
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

    // Door seams & door handles
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

    // Race number roundel at X(320)
    ctx.fillStyle = '#f4ead8';
    ctx.beginPath();
    ctx.arc(X(320), 52, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a1410';
    ctx.font = '900 40px Inter, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), X(320), 54);

    // ==========================================
    // SIDE GRAFFITI BY ARCHETYPE
    // ==========================================
    ctx.save();
    const sideGraffitiX = mirror ? W - 180 : 20;

    if (stats.name === 'Dune Buggy') {
      // Buggy Side: Wet Krink Mop Squeezer Tag "TOWN" with dripping paint runs
      ctx.translate(sideGraffitiX, 14);
      drawMopDripGraffiti(ctx, 160, 94, stats.color);
    } else if (stats.name === 'Rally Car') {
      // Rally Side 1: Cyberpunk Neon Drift Tag across door
      ctx.translate(sideGraffitiX, 22);
      drawCyberpunkNeonTag(ctx, 160, 68, stats.color);
      // Rally Side 2: Priority "HELLO" sticker slap on rear quarter panel
      ctx.restore();
      ctx.save();
      const stickerX = mirror ? 20 : W - 110;
      ctx.translate(stickerX, 32);
      drawStickerSlapGraffiti(ctx, 90, 60);
    } else if (stats.name === 'SUV') {
      // SUV Side 1: Bold Urban Blockbuster "TOWN" spanning doors
      ctx.translate(sideGraffitiX, 16);
      drawBlockbusterGraffiti(ctx, 170, 80, stats.color);
      // SUV Side 2: Street sticker slap near rear pillar
      ctx.restore();
      ctx.save();
      const stickerX = mirror ? 24 : W - 105;
      ctx.translate(stickerX, 28);
      drawStickerSlapGraffiti(ctx, 84, 58);
    } else if (stats.name === 'Trophy Truck') {
      // Trophy Truck Side: Stenciled Wasteland "T O W N" along bed
      ctx.translate(sideGraffitiX, 18);
      drawMilitaryStencilGraffiti(ctx, 165, 80, stats.color);
    } else if (stats.name === 'Monster Truck') {
      // Monster Truck Side: Melting Acid Psychedelic "TOWN" flame letters
      ctx.translate(sideGraffitiX, 12);
      drawAcidPsychedelicGraffiti(ctx, 175, 88, stats.color);
    }
    ctx.restore();

    // Grime and scuffs low on the panel
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

/**
 * Roof/hood panel (256x512 with front at top).
 * Features giant rooftop / hood graffiti:
 * - Monster Truck: Heavy-Metal Chrome Wildstyle "TOWN"
 * - Rally Car: Racing Urban Blockbuster "T O W N"
 * - SUV: Architectural Blockbuster "T O W N"
 * - Trophy Truck: Stencil "T O W N"
 * - Dune Buggy: Punk Drip Tag "TOWN"
 */
export function liveryTop(stats: VehicleStats, teamColor: number): CanvasTexture {
  const n = raceNumber(stats);
  return texture(`top:${stats.name}:${n}:${teamColor}`, 256, 512, ctx => {
    const W = 256, H = 512;
    ctx.fillStyle = hex(teamColor);
    ctx.fillRect(0, 0, W, H);
    const shade = ctx.createLinearGradient(0, 0, W, 0);
    shade.addColorStop(0, 'rgba(0,0,0,0.18)');
    shade.addColorStop(0.5, 'rgba(255,255,255,0.12)');
    shade.addColorStop(1, 'rgba(0,0,0,0.18)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, W, H);

    // Twin racing stripes
    ctx.fillStyle = hex(stats.color);
    ctx.fillRect(96, 0, 22, H);
    ctx.fillRect(138, 0, 22, H);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(120, 0, 4, H);
    ctx.fillRect(132, 0, 4, H);

    // Hood vents near the front
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    for (let i = 0; i < 4; i++) ctx.fillRect(40, 40 + i * 14, 176, 5);

    // ==========================================
    // TOP / ROOF GRAFFITI BY ARCHETYPE
    // ==========================================
    ctx.save();
    if (stats.name === 'Monster Truck') {
      // Monster Truck: Chrome Wildstyle graffiti across the cab roof
      ctx.translate(0, 160);
      drawChromeWildstyleGraffiti(ctx, W, 170, stats.color);
    } else if (stats.name === 'Rally Car') {
      // Rally Car: High-contrast racing Urban Blockbuster "T O W N"
      ctx.translate(0, 240);
      drawBlockbusterGraffiti(ctx, W, 120, stats.color);
    } else if (stats.name === 'SUV') {
      // SUV: Rooftop Blockbuster "T O W N"
      ctx.translate(0, 220);
      drawBlockbusterGraffiti(ctx, W, 140, stats.color);
    } else if (stats.name === 'Trophy Truck') {
      // Trophy Truck: Hood Stencil "T O W N"
      ctx.translate(0, 80);
      drawMilitaryStencilGraffiti(ctx, W, 90, stats.color);
    } else {
      // Dune Buggy: Punk Drip Tag
      ctx.translate(0, 220);
      drawPunkDripTagGraffiti(ctx, W, 110, stats.color);
    }
    ctx.restore();

    // Panel seams
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

/**
 * Rear panel (+Z face) of the vehicle body box (512x256).
 * Features back-of-car graffiti:
 * - SUV: NYC Subway Bubble Throw-Up "TOWN" + sticker slap
 * - Rally Car: Speed Drift Chisel Tag "TOWN" + arrow flourish
 */
export function liveryRear(stats: VehicleStats, teamColor: number): CanvasTexture {
  return texture(`rear:${stats.name}:${teamColor}`, 512, 256, ctx => {
    const W = 512, H = 256;
    ctx.fillStyle = hex(teamColor);
    ctx.fillRect(0, 0, W, H);

    // Rear panel ambient shading
    const shade = ctx.createLinearGradient(0, 0, 0, H);
    shade.addColorStop(0, 'rgba(255,255,255,0.15)');
    shade.addColorStop(0.5, 'rgba(0,0,0,0)');
    shade.addColorStop(1, 'rgba(0,0,0,0.4)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, W, H);

    // Lower bumper / diffuser band
    ctx.fillStyle = '#141416';
    ctx.fillRect(0, H - 48, W, 48);

    if (stats.name === 'SUV') {
      // Rear Tailgate: NYC Subway Bubble-Letter Throw-Up "TOWN"
      drawSubwayBubbleGraffiti(ctx, W, H - 40, stats.color);
      // Extra street sticker slap in the corner
      ctx.save();
      ctx.translate(W - 95, 20);
      drawStickerSlapGraffiti(ctx, 80, 54);
      ctx.restore();
    } else if (stats.name === 'Rally Car') {
      // Rear Trunk / Hatch: Speed Drift Chisel Tag "TOWN"
      drawDriftTagGraffiti(ctx, W, H - 36, stats.color);
    } else {
      // General archetype rear styling with drift tag
      drawDriftTagGraffiti(ctx, W, H - 40, stats.color);
    }

    // Dirt and exhaust soot on the rear panel
    const soot = ctx.createRadialGradient(W * 0.82, H - 20, 10, W * 0.82, H - 20, 70);
    soot.addColorStop(0, 'rgba(10,10,10,0.65)');
    soot.addColorStop(1, 'rgba(10,10,10,0)');
    ctx.fillStyle = soot;
    ctx.fillRect(0, 0, W, H);
  });
}

/**
 * Tailgate panel for trucks (Trophy Truck and Monster Truck) (512x128).
 * Features Desert Stencil (Trophy Truck) or Industrial Heavy Block (Monster Truck).
 */
export function liveryTailgate(stats: VehicleStats, teamColor: number): CanvasTexture {
  return texture(`tailgate:${stats.name}:${teamColor}`, 512, 128, ctx => {
    const W = 512, H = 128;
    ctx.fillStyle = hex(teamColor);
    ctx.fillRect(0, 0, W, H);

    // Tailgate handle recess
    ctx.fillStyle = '#111214';
    ctx.fillRect(W / 2 - 32, 12, 64, 16);

    // Panel shading
    const shade = ctx.createLinearGradient(0, 0, 0, H);
    shade.addColorStop(0, 'rgba(255,255,255,0.2)');
    shade.addColorStop(1, 'rgba(0,0,0,0.4)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, W, H);

    if (stats.name === 'Monster Truck') {
      // Heavy Industrial Block "TOWN"
      drawBlockbusterGraffiti(ctx, W, H - 10, stats.color);
    } else {
      // Desert Wasteland Military Stencil "T O W N"
      drawMilitaryStencilGraffiti(ctx, W, H, stats.color);
    }

    // Weathering dirt
    ctx.fillStyle = 'rgba(40,30,15,0.35)';
    ctx.fillRect(0, H - 24, W, 24);
  });
}

/**
 * Front sloped hood/nose panel for Dune Buggy (256x128).
 * Features Skate-Punk Fat-Cap Drip Tag "TOWN".
 */
export function liveryHood(stats: VehicleStats, teamColor: number): CanvasTexture {
  return texture(`hood:${stats.name}:${teamColor}`, 256, 128, ctx => {
    const W = 256, H = 128;
    ctx.fillStyle = hex(teamColor);
    ctx.fillRect(0, 0, W, H);

    // Dipped hood gradient
    const shade = ctx.createLinearGradient(0, 0, 0, H);
    shade.addColorStop(0, 'rgba(255,255,255,0.25)');
    shade.addColorStop(1, 'rgba(0,0,0,0.3)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, W, H);

    // Front cooling louvers
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(24, 16 + i * 8, W - 48, 3);
    }

    // Skate-Punk Fat-Cap Drip Tag "TOWN"
    drawPunkDripTagGraffiti(ctx, W, H - 20, stats.color);
  });
}
