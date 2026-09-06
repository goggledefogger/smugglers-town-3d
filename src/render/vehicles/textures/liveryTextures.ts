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
  drawStickerSlapGraffiti,
  drawComplexWildstyleBurner,
  drawChicanoGothicScript,
  drawKawaiiBubbleGraffiti,
  drawBarcodeGlitchTag,
  drawStickerBombCluster,
  drawRibbonSplitMarkerTag
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
 * Side panel (512x128). Beautifully spreads out multiple graffiti styles
 * across 4 distinct vehicle zones:
 * - Zone 1: Front Fender Tag
 * - Zone 2: Main Door / Mid-Body Centerpiece Art
 * - Zone 3: Racing Number Roundel
 * - Zone 4: Rear Quarter Panel / Bed Art & Sticker Slaps
 * - Zone 5: Lower Rocker Sill Running Stencil
 */
export function liverySide(stats: VehicleStats, teamColor: number, mirror: boolean): CanvasTexture {
  const n = raceNumber(stats);
  return texture(`side:${stats.name}:${n}:${teamColor}:${mirror}:v2`, 512, 128, ctx => {
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
    ctx.fillStyle = '#18181c';
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

    // Door seams & handle
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 2;
    for (const x of [160, 310]) {
      ctx.beginPath();
      ctx.moveTo(X(x), 12);
      ctx.lineTo(X(x), 104);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(X(205) - 12, 84, 24, 5);

    // Race number roundel at X(320)
    ctx.fillStyle = '#f4ead8';
    ctx.beginPath();
    ctx.arc(X(320), 52, 28, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a1410';
    ctx.font = '900 38px Inter, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), X(320), 54);

    // ==============================================================
    // MULTI-ZONE GRAFFITI DISTRIBUTION (FRONT, MID, REAR, SILL)
    // ==============================================================

    // ZONE 1: FRONT FENDER (X ~ 10-110)
    ctx.save();
    const fenderX = mirror ? W - 110 : 10;
    ctx.translate(fenderX, 16);
    if (stats.name === 'Dune Buggy') {
      drawPunkDripTagGraffiti(ctx, 95, 48, stats.color);
    } else if (stats.name === 'Rally Car') {
      drawDriftTagGraffiti(ctx, 95, 46, stats.color);
    } else if (stats.name === 'SUV') {
      drawChicanoGothicScript(ctx, 95, 48, stats.color);
    } else if (stats.name === 'Trophy Truck') {
      drawMilitaryStencilGraffiti(ctx, 95, 45, stats.color);
    } else {
      drawBarcodeGlitchTag(ctx, 95, 46, stats.color);
    }
    ctx.restore();

    // ZONE 2: CENTER DOOR / MAIN BODY (X ~ 130-290)
    ctx.save();
    const doorX = mirror ? W - 295 : 135;
    ctx.translate(doorX, 14);
    if (stats.name === 'Dune Buggy') {
      drawMopDripGraffiti(ctx, 150, 88, stats.color);
    } else if (stats.name === 'Rally Car') {
      drawComplexWildstyleBurner(ctx, 155, 82, stats.color);
    } else if (stats.name === 'SUV') {
      drawBlockbusterGraffiti(ctx, 155, 84, stats.color);
    } else if (stats.name === 'Trophy Truck') {
      drawMilitaryStencilGraffiti(ctx, 155, 80, stats.color);
    } else {
      drawAcidPsychedelicGraffiti(ctx, 155, 86, stats.color);
    }
    ctx.restore();

    // ZONE 3: REAR QUARTER PANEL / TRUCK BED (X ~ 360-500)
    ctx.save();
    const rearQtrX = mirror ? 10 : W - 145;
    ctx.translate(rearQtrX, 20);
    if (stats.name === 'Dune Buggy') {
      drawRibbonSplitMarkerTag(ctx, 135, 72, stats.color);
    } else if (stats.name === 'Rally Car') {
      drawCyberpunkNeonTag(ctx, 135, 66, stats.color);
    } else if (stats.name === 'SUV') {
      drawKawaiiBubbleGraffiti(ctx, 135, 70, stats.color);
    } else if (stats.name === 'Trophy Truck') {
      drawStickerBombCluster(ctx, 135, 70);
    } else {
      drawChromeWildstyleGraffiti(ctx, 135, 72, stats.color);
    }
    ctx.restore();

    // ZONE 4: PRIORITY STICKER SLAP (on rear window corner or wheel arch)
    ctx.save();
    const stickerX = mirror ? 65 : W - 80;
    ctx.translate(stickerX, 72);
    drawStickerSlapGraffiti(ctx, 68, 46);
    ctx.restore();

    // ZONE 5: LOWER ROCKER SILL RUNNER STENCIL (repeating along running board)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.font = '900 12px "Impact", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let x = 40; x < W; x += 110) {
      ctx.fillText('★ TOWN ★', X(x), 116);
    }

    // Dirt and weathering
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
 * Multi-zone spread across:
 * - Zone 1: Hood Artwork (Y ~ 20-140)
 * - Zone 2: Windshield Visor Banner (Y ~ 150-180)
 * - Zone 3: Main Roof Burner (Y ~ 210-380)
 * - Zone 4: Rear Decklid / Spoiler Tag (Y ~ 410-495)
 */
export function liveryTop(stats: VehicleStats, teamColor: number): CanvasTexture {
  const n = raceNumber(stats);
  return texture(`top:${stats.name}:${n}:${teamColor}:v2`, 256, 512, ctx => {
    const W = 256, H = 512;
    ctx.fillStyle = hex(teamColor);
    ctx.fillRect(0, 0, W, H);
    const shade = ctx.createLinearGradient(0, 0, W, 0);
    shade.addColorStop(0, 'rgba(0,0,0,0.18)');
    shade.addColorStop(0.5, 'rgba(255,255,255,0.12)');
    shade.addColorStop(1, 'rgba(0,0,0,0.18)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, W, H);

    // Twin racing stripes down the length
    ctx.fillStyle = hex(stats.color);
    ctx.fillRect(96, 0, 22, H);
    ctx.fillRect(138, 0, 22, H);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(120, 0, 4, H);
    ctx.fillRect(132, 0, 4, H);

    // ==========================================
    // ZONE 1: FRONT HOOD (Y ~ 25-135)
    // ==========================================
    ctx.save();
    ctx.translate(0, 25);
    if (stats.name === 'Dune Buggy') {
      drawPunkDripTagGraffiti(ctx, W, 95, stats.color);
    } else if (stats.name === 'Rally Car') {
      drawDriftTagGraffiti(ctx, W, 90, stats.color);
    } else if (stats.name === 'SUV') {
      drawBlockbusterGraffiti(ctx, W, 95, stats.color);
    } else if (stats.name === 'Trophy Truck') {
      drawMilitaryStencilGraffiti(ctx, W, 90, stats.color);
    } else {
      drawChicanoGothicScript(ctx, W, 95, stats.color);
    }
    ctx.restore();

    // ==========================================
    // ZONE 2: WINDSHIELD SUN VISOR BANNER (Y ~ 152-180)
    // ==========================================
    ctx.fillStyle = '#08080a';
    ctx.fillRect(16, 152, W - 32, 28);
    ctx.strokeStyle = hex(stats.color);
    ctx.lineWidth = 2;
    ctx.strokeRect(16, 152, W - 32, 28);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'italic 900 16px "Impact", "Arial Black", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⚡ TOWN ⚡', W / 2, 166);

    // ==========================================
    // ZONE 3: MAIN ROOF BURNER (Y ~ 210-380)
    // ==========================================
    ctx.save();
    ctx.translate(0, 220);
    if (stats.name === 'Monster Truck') {
      drawChromeWildstyleGraffiti(ctx, W, 160, stats.color);
    } else if (stats.name === 'Rally Car') {
      drawComplexWildstyleBurner(ctx, W, 150, stats.color);
    } else if (stats.name === 'SUV') {
      drawKawaiiBubbleGraffiti(ctx, W, 150, stats.color);
    } else if (stats.name === 'Trophy Truck') {
      drawRibbonSplitMarkerTag(ctx, W, 145, stats.color);
    } else {
      drawMopDripGraffiti(ctx, W, 145, stats.color);
    }
    ctx.restore();

    // ==========================================
    // ZONE 4: REAR DECKLID / TRUNK (Y ~ 410-495)
    // ==========================================
    ctx.save();
    ctx.translate(0, 410);
    if (stats.name === 'Rally Car' || stats.name === 'SUV') {
      drawBarcodeGlitchTag(ctx, W, 75, stats.color);
    } else {
      drawStickerBombCluster(ctx, W, 75);
    }
    ctx.restore();

    // Panel seams
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 2;
    for (const y of [148, 184, 395]) {
      ctx.beginPath();
      ctx.moveTo(8, y);
      ctx.lineTo(W - 8, y);
      ctx.stroke();
    }
  });
}

/**
 * Rear panel (+Z face) of the vehicle body box (512x256).
 * Spreads graffiti across:
 * - Upper window / pillar area: Sticker slaps & mini-tags
 * - Center trunk / tailgate: Large feature throw-up / drift tag
 * - Lower bumper / diffuser: Micro-tag runner & exhaust soot
 */
export function liveryRear(stats: VehicleStats, teamColor: number): CanvasTexture {
  return texture(`rear:${stats.name}:${teamColor}:v2`, 512, 256, ctx => {
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

    // 1. Center Trunk / Tailgate: Primary Street Art Piece
    if (stats.name === 'SUV') {
      // NYC Subway Bubble Throw-Up
      drawSubwayBubbleGraffiti(ctx, W, H - 55, stats.color);
    } else if (stats.name === 'Rally Car') {
      // Speed Drift Chisel Tag
      drawDriftTagGraffiti(ctx, W, H - 50, stats.color);
    } else {
      // Complex Wildstyle Burner
      drawComplexWildstyleBurner(ctx, W, H - 55, stats.color);
    }

    // 2. Upper Corner Decals & Sticker Slaps
    ctx.save();
    ctx.translate(W - 85, 20);
    drawStickerSlapGraffiti(ctx, 75, 50);
    ctx.restore();

    ctx.save();
    ctx.translate(20, 16);
    drawBarcodeGlitchTag(ctx, 90, 45, stats.color);
    ctx.restore();

    // 3. Lower Bumper Stencil Runner
    ctx.fillStyle = hex(stats.color);
    ctx.font = '900 13px "Impact", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('/// TOWN SPEED LABS /// TOWN STREET ///', W / 2, H - 24);

    // Exhaust soot
    const soot = ctx.createRadialGradient(W * 0.82, H - 20, 10, W * 0.82, H - 20, 70);
    soot.addColorStop(0, 'rgba(10,10,10,0.65)');
    soot.addColorStop(1, 'rgba(10,10,10,0)');
    ctx.fillStyle = soot;
    ctx.fillRect(0, 0, W, H);
  });
}

/**
 * Tailgate panel for trucks (Trophy Truck and Monster Truck) (512x128).
 * Multi-zone spread across tailgate surface:
 * - Center: Primary Stencil or Industrial Block "TOWN"
 * - Corners: Sticker slap & hazard stripes
 */
export function liveryTailgate(stats: VehicleStats, teamColor: number): CanvasTexture {
  return texture(`tailgate:${stats.name}:${teamColor}:v2`, 512, 128, ctx => {
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

    // Hazard caution stripes along lower lip
    ctx.fillStyle = '#ffaa00';
    for (let x = 0; x < W; x += 32) {
      ctx.beginPath();
      ctx.moveTo(x, H - 14);
      ctx.lineTo(x + 14, H - 14);
      ctx.lineTo(x + 6, H);
      ctx.lineTo(x - 8, H);
      ctx.closePath();
      ctx.fill();
    }

    if (stats.name === 'Monster Truck') {
      // Heavy Industrial Block "TOWN"
      drawBlockbusterGraffiti(ctx, W * 0.72, H - 12, stats.color);
    } else {
      // Desert Wasteland Military Stencil "T O W N"
      drawMilitaryStencilGraffiti(ctx, W * 0.78, H, stats.color);
    }

    // Corner Sticker Slap
    ctx.save();
    ctx.translate(W - 65, 36);
    drawStickerSlapGraffiti(ctx, 62, 42);
    ctx.restore();

    // Weathering dirt
    ctx.fillStyle = 'rgba(40,30,15,0.35)';
    ctx.fillRect(0, H - 24, W, 24);
  });
}

/**
 * Front sloped hood/nose panel for Dune Buggy (256x128).
 * Features Skate-Punk Fat-Cap Drip Tag + punk crossbones & twin fender tags.
 */
export function liveryHood(stats: VehicleStats, teamColor: number): CanvasTexture {
  return texture(`hood:${stats.name}:${teamColor}:v2`, 256, 128, ctx => {
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
      ctx.fillRect(24, 14 + i * 8, W - 48, 3);
    }

    // Primary: Skate-Punk Fat-Cap Drip Tag "TOWN"
    drawPunkDripTagGraffiti(ctx, W, H - 22, stats.color);

    // Corner micro-tag
    ctx.save();
    ctx.translate(28, 92);
    ctx.font = 'italic 900 12px "Impact", sans-serif';
    ctx.fillStyle = '#000000';
    ctx.fillText('TOWN', 0, 0);
    ctx.restore();
  });
}
