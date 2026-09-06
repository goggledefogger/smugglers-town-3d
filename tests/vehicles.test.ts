import { describe, it, expect } from 'vitest';
import { VEHICLE_TYPES } from '../src/core/physics/vehicleStats.ts';
import {
  buildVehicle,
  VEHICLE_BUILDERS,
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
  drawRibbonSplitMarkerTag,
  liverySide,
  liveryTop,
  liveryRear,
  liveryTailgate,
  liveryHood
} from '../src/render/vehicleMeshes.ts';

describe('Modular Vehicles Architecture', () => {
  it('registers all five canonical vehicle archetypes', () => {
    expect(Object.keys(VEHICLE_BUILDERS)).toEqual([
      'Dune Buggy',
      'Rally Car',
      'SUV',
      'Trophy Truck',
      'Monster Truck'
    ]);
  });

  for (const stats of VEHICLE_TYPES) {
    it(`builds a valid VehicleMesh for ${stats.name}`, () => {
      const mesh = buildVehicle(stats, 0x3366cc);
      expect(mesh.root).toBeDefined();
      expect(mesh.wheels.length).toBe(4);
      expect(mesh.frontPivots.length).toBe(2);
      expect(mesh.wheelR).toBeGreaterThan(0.3);
      expect(mesh.tail).toBeDefined();
      expect(mesh.tail.emissive).toBeDefined();

      // Ensure root contains body and wheel pivots
      expect(mesh.root.children.length).toBeGreaterThan(4);
    });
  }

  it('procedural liveries instantiate without throwing in headless mode', () => {
    const buggy = VEHICLE_TYPES[0]!;
    const rally = VEHICLE_TYPES[1]!;
    const suv = VEHICLE_TYPES[2]!;
    const trophy = VEHICLE_TYPES[3]!;
    const monster = VEHICLE_TYPES[4]!;

    expect(liverySide(buggy, 0xffcc33, false)).toBeDefined();
    expect(liverySide(buggy, 0xffcc33, true)).toBeDefined();
    expect(liverySide(rally, 0xff4444, false)).toBeDefined();
    expect(liverySide(suv, 0x3399ff, false)).toBeDefined();
    expect(liverySide(trophy, 0x33cc66, false)).toBeDefined();
    expect(liverySide(monster, 0xaa55ff, false)).toBeDefined();

    expect(liveryTop(monster, 0xaa55ff)).toBeDefined();
    expect(liveryTop(rally, 0xff4444)).toBeDefined();
    expect(liveryTop(suv, 0x3399ff)).toBeDefined();

    expect(liveryRear(suv, 0x3399ff)).toBeDefined();
    expect(liveryRear(rally, 0xff4444)).toBeDefined();
    expect(liveryTailgate(trophy, 0x33cc66)).toBeDefined();
    expect(liveryTailgate(monster, 0xaa55ff)).toBeDefined();
    expect(liveryHood(buggy, 0xffcc33)).toBeDefined();
  });
});

describe('TOWN Procedural Graffiti Renderers Suite (16 Styles)', () => {
  function createMockCtx() {
    const calls: string[] = [];
    return {
      calls,
      save: () => calls.push('save'),
      restore: () => calls.push('restore'),
      translate: () => calls.push('translate'),
      transform: () => calls.push('transform'),
      rotate: () => calls.push('rotate'),
      scale: () => calls.push('scale'),
      beginPath: () => calls.push('beginPath'),
      closePath: () => calls.push('closePath'),
      moveTo: () => calls.push('moveTo'),
      lineTo: () => calls.push('lineTo'),
      quadraticCurveTo: () => calls.push('quadraticCurveTo'),
      bezierCurveTo: () => calls.push('bezierCurveTo'),
      arc: () => calls.push('arc'),
      ellipse: () => calls.push('ellipse'),
      fill: () => calls.push('fill'),
      stroke: () => calls.push('stroke'),
      fillRect: () => calls.push('fillRect'),
      strokeRect: () => calls.push('strokeRect'),
      strokeText: (t: string) => calls.push(`strokeText:${t}`),
      fillText: (t: string) => calls.push(`fillText:${t}`),
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      measureText: (text: string) => ({ width: text.length * 20 }),
      font: '',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      lineJoin: 'miter',
      lineCap: 'butt',
      miterLimit: 10,
      shadowColor: '',
      shadowBlur: 0,
      textAlign: 'left',
      textBaseline: 'alphabetic'
    } as unknown as CanvasRenderingContext2D & { calls: string[] };
  }

  it('1. drawSubwayBubbleGraffiti: NYC throwie letters and drips for SUV tailgate', () => {
    const ctx = createMockCtx();
    drawSubwayBubbleGraffiti(ctx, 512, 256, 0x3399ff);
    expect(ctx.calls).toContain('fillText:TOWN');
    expect(ctx.calls).toContain('strokeText:TOWN');
    expect(ctx.calls).toContain('ellipse');
  });

  it('2. drawDriftTagGraffiti: Aerodynamic skew and speed flourish for Rally Car rear', () => {
    const ctx = createMockCtx();
    drawDriftTagGraffiti(ctx, 512, 256, 0xff4444);
    expect(ctx.calls).toContain('transform');
    expect(ctx.calls).toContain('fillText:TOWN');
    expect(ctx.calls).toContain('fillRect');
  });

  it('3. drawMilitaryStencilGraffiti: Stencil bridges & corner brackets for Trophy Truck', () => {
    const ctx = createMockCtx();
    drawMilitaryStencilGraffiti(ctx, 512, 128, 0x33cc66);
    expect(ctx.calls).toContain('fillText:T O W N');
    expect(ctx.calls).toContain('fillRect');
  });

  it('4. drawChromeWildstyleGraffiti: Chrome horizon reflection & star flares for Monster Truck', () => {
    const ctx = createMockCtx();
    drawChromeWildstyleGraffiti(ctx, 256, 512, 0xaa55ff);
    expect(ctx.calls).toContain('fillText:TOWN');
    expect(ctx.calls).toContain('strokeText:TOWN');
  });

  it('5. drawPunkDripTagGraffiti: Punk halo and drip runs for Dune Buggy hood', () => {
    const ctx = createMockCtx();
    drawPunkDripTagGraffiti(ctx, 256, 128, 0xffcc33);
    expect(ctx.calls).toContain('fillText:TOWN');
    expect(ctx.calls).toContain('ellipse');
  });

  it('6. drawBlockbusterGraffiti: Massive architectural block 3D letters', () => {
    const ctx = createMockCtx();
    drawBlockbusterGraffiti(ctx, 256, 128, 0xffffff);
    expect(ctx.calls).toContain('fillText:T O W N');
    expect(ctx.calls).toContain('strokeText:T O W N');
  });

  it('7. drawMopDripGraffiti: Wet dripping squeezer mop tag for Buggy side', () => {
    const ctx = createMockCtx();
    drawMopDripGraffiti(ctx, 160, 94, 0x00ffff);
    expect(ctx.calls).toContain('fillText:TOWN');
    expect(ctx.calls).toContain('arc');
  });

  it('8. drawAcidPsychedelicGraffiti: Melting liquid flame contours for Monster Truck side', () => {
    const ctx = createMockCtx();
    drawAcidPsychedelicGraffiti(ctx, 180, 90, 0xff00ff);
    expect(ctx.calls).toContain('fillText:TOWN');
    expect(ctx.calls).toContain('strokeText:TOWN');
  });

  it('9. drawCyberpunkNeonTag: Chromatic split and circuit tick lines for Rally Car side', () => {
    const ctx = createMockCtx();
    drawCyberpunkNeonTag(ctx, 160, 68, 0x00f0ff);
    expect(ctx.calls).toContain('fillText:TOWN');
    expect(ctx.calls).toContain('stroke');
  });

  it('10. drawStickerSlapGraffiti: Priority "HELLO" sticker slap decal', () => {
    const ctx = createMockCtx();
    drawStickerSlapGraffiti(ctx, 90, 60);
    expect(ctx.calls).toContain('fillText:HELLO');
    expect(ctx.calls).toContain('fillText:TOWN');
    expect(ctx.calls).toContain('fillRect');
  });

  it('11. drawComplexWildstyleBurner: Extreme interlocking wildstyle with arrowheads', () => {
    const ctx = createMockCtx();
    drawComplexWildstyleBurner(ctx, 180, 90, 0xff3366);
    expect(ctx.calls).toContain('fillText:TOWN');
    expect(ctx.calls).toContain('strokeText:TOWN');
  });

  it('12. drawChicanoGothicScript: Lowrider Old English calligraphy with diamond serifs', () => {
    const ctx = createMockCtx();
    drawChicanoGothicScript(ctx, 160, 80, 0xe0e0e0);
    expect(ctx.calls).toContain('fillText:Town');
    expect(ctx.calls).toContain('stroke');
  });

  it('13. drawKawaiiBubbleGraffiti: Pastel bubblegum letters with star flares', () => {
    const ctx = createMockCtx();
    drawKawaiiBubbleGraffiti(ctx, 160, 80, 0xff66cc);
    expect(ctx.calls).toContain('fillText:TOWN');
    expect(ctx.calls).toContain('strokeText:TOWN');
  });

  it('14. drawBarcodeGlitchTag: Cyber-industrial stencil with barcode lines', () => {
    const ctx = createMockCtx();
    drawBarcodeGlitchTag(ctx, 160, 70, 0x00ff88);
    expect(ctx.calls).toContain('fillText:TOWN');
    expect(ctx.calls).toContain('strokeRect');
  });

  it('15. drawStickerBombCluster: Collage of multiple overlapping mini-tags', () => {
    const ctx = createMockCtx();
    drawStickerBombCluster(ctx, 120, 80);
    expect(ctx.calls).toContain('fillText:TOWN');
  });

  it('16. drawRibbonSplitMarkerTag: Split-nib two-tone calligraphy stroke', () => {
    const ctx = createMockCtx();
    drawRibbonSplitMarkerTag(ctx, 160, 75, 0xffaa00);
    expect(ctx.calls).toContain('fillText:TOWN');
    expect(ctx.calls).toContain('stroke');
  });
});
