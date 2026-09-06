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
    expect(liveryTop(monster, 0xaa55ff)).toBeDefined();
    expect(liveryRear(suv, 0x3399ff)).toBeDefined();
    expect(liveryRear(rally, 0xff4444)).toBeDefined();
    expect(liveryTailgate(trophy, 0x33cc66)).toBeDefined();
    expect(liveryHood(buggy, 0xffcc33)).toBeDefined();
  });
});

describe('TOWN Procedural Graffiti Renderers', () => {
  function createMockCtx() {
    const calls: string[] = [];
    return {
      calls,
      save: () => calls.push('save'),
      restore: () => calls.push('restore'),
      translate: () => calls.push('translate'),
      transform: () => calls.push('transform'),
      scale: () => calls.push('scale'),
      beginPath: () => calls.push('beginPath'),
      closePath: () => calls.push('closePath'),
      moveTo: () => calls.push('moveTo'),
      lineTo: () => calls.push('lineTo'),
      arc: () => calls.push('arc'),
      ellipse: () => calls.push('ellipse'),
      fill: () => calls.push('fill'),
      stroke: () => calls.push('stroke'),
      fillRect: () => calls.push('fillRect'),
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
      miterLimit: 10,
      shadowColor: '',
      shadowBlur: 0,
      textAlign: 'left',
      textBaseline: 'alphabetic'
    } as unknown as CanvasRenderingContext2D & { calls: string[] };
  }

  it('drawSubwayBubbleGraffiti draws NYC throwie letters and drips for SUV', () => {
    const ctx = createMockCtx();
    drawSubwayBubbleGraffiti(ctx, 512, 256, 0x3399ff);
    expect(ctx.calls).toContain('fillText:TOWN');
    expect(ctx.calls).toContain('strokeText:TOWN');
    expect(ctx.calls).toContain('ellipse');
  });

  it('drawDriftTagGraffiti applies aerodynamic skew and speed flourish for Rally Car', () => {
    const ctx = createMockCtx();
    drawDriftTagGraffiti(ctx, 512, 256, 0xff4444);
    expect(ctx.calls).toContain('transform');
    expect(ctx.calls).toContain('fillText:TOWN');
    expect(ctx.calls).toContain('fillRect');
  });

  it('drawMilitaryStencilGraffiti renders corner brackets and bridge cuts for Trophy Truck', () => {
    const ctx = createMockCtx();
    drawMilitaryStencilGraffiti(ctx, 512, 128, 0x33cc66);
    expect(ctx.calls).toContain('fillText:T O W N');
    expect(ctx.calls).toContain('fillRect');
  });

  it('drawChromeWildstyleGraffiti draws flame glow and star glints for Monster Truck', () => {
    const ctx = createMockCtx();
    drawChromeWildstyleGraffiti(ctx, 256, 512, 0xaa55ff);
    expect(ctx.calls).toContain('fillText:TOWN');
    expect(ctx.calls).toContain('strokeText:TOWN');
  });

  it('drawPunkDripTagGraffiti draws halo and drip trails for Dune Buggy', () => {
    const ctx = createMockCtx();
    drawPunkDripTagGraffiti(ctx, 256, 128, 0xffcc33);
    expect(ctx.calls).toContain('fillText:TOWN');
    expect(ctx.calls).toContain('ellipse');
  });
});
