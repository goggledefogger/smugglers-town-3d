import { describe, it, expect } from 'vitest';
import { config } from '../src/app/config.ts';
import { DEFAULT_PHYSICS } from '../src/core/physics/VehicleBody.ts';
import { DEFAULT_DRIVER } from '../src/core/ai/DriverBrain.ts';

describe('speedMultiplier', () => {
  const S = config.speedMultiplier;

  it('is between 0 and 1', () => {
    expect(S).toBeGreaterThan(0);
    expect(S).toBeLessThanOrEqual(1);
  });

  it('scales config.physics speed constants from their base values', () => {
    expect(config.physics.driveForce).toBeCloseTo(62 * S, 6);
    expect(config.physics.maxSpeed).toBeCloseTo(78 * S, 6);
    expect(config.physics.brakeForce).toBeCloseTo(80 * S, 6);
  });

  it('does not affect handling constants', () => {
    expect(config.physics.turnRate).toBe(2.6);
    expect(config.physics.jumpBoost).toBe(1.55);
    expect(config.physics.airControl).toBe(2.1);
    expect(config.physics.gravity).toBe(22);
  });

  it('propagates to DEFAULT_PHYSICS', () => {
    expect(DEFAULT_PHYSICS.driveForce).toBeCloseTo(62 * S, 6);
    expect(DEFAULT_PHYSICS.maxSpeed).toBeCloseTo(78 * S, 6);
    expect(DEFAULT_PHYSICS.brakeForce).toBeCloseTo(80 * S, 6);
  });

  it('propagates to DEFAULT_DRIVER.slowTurnSpeed', () => {
    expect(DEFAULT_DRIVER.slowTurnSpeed).toBeCloseTo(45 * S, 6);
  });

  it('preserves the drive-force / max-speed ratio (drag coefficient)', () => {
    const ratio = config.physics.driveForce / config.physics.maxSpeed;
    expect(ratio).toBeCloseTo(62 / 78, 6);
  });
});
