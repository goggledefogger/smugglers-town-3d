import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { VehicleBody, type BuildingCollider } from '../src/core/physics/VehicleBody.ts';
import { VEHICLE_TYPES } from '../src/core/physics/vehicleStats.ts';
import { Heightfield } from '../src/core/heightfield.ts';

function makeGround(height = 0.8, size = 200, segs = 16): Heightfield {
  const cells = new Float32Array((segs + 1) * (segs + 1)).fill(height);
  return new Heightfield(size, segs, cells);
}

describe('Option 2: Multi-Deck Bridge Driving & Surface Elevation', () => {
  it('VehicleBody stays on elevated bridge deck when surfaceProvider returns bridge deck height', () => {
    const stats = VEHICLE_TYPES[2]!; // pickup
    const body = new VehicleBody(stats);
    body.pos.set(0, 21.0, 0); // on bridge at Y=20 with 1.0m clearance
    body.snapPrev();

    const ground = makeGround(0.8); // riverbed at Y=0.8
    const bridgeHeight = 20.0;
    const surfaceProvider = (x: number, z: number, _currentY: number, _groundY: number) => {
      // Simulate bridge deck across -50 < x < 50, -200 < z < 200 at Y=20
      if (Math.abs(x) < 50 && Math.abs(z) < 200) return bridgeHeight;
      return null;
    };

    // Step physics forward with throttle
    for (let i = 0; i < 30; i++) {
      body.step(1 / 60, { throttle: 1, steer: 0, brake: 0, handbrake: false, jump: false }, ground, [], surfaceProvider);
    }

    // Car should remain on the bridge deck at Y ~= bridgeHeight + clearance (21.0m), not falling to riverbed (1.8m)
    expect(body.pos.y).toBeGreaterThan(19.0);
    expect(body.groundY).toBeCloseTo(bridgeHeight, 1);
    expect(body.onGround).toBe(true);
  });

  it('Vehicle falls down toward riverbed when driving off the bridge into open air', () => {
    const stats = VEHICLE_TYPES[2]!;
    const body = new VehicleBody(stats);
    body.pos.set(0, 21.0, 0);
    body.snapPrev();

    const ground = makeGround(0.8); // riverbed at Y=0.8
    // Surface provider returns null everywhere (car drove into open air)
    const surfaceProvider = () => null;

    // Simulate falling for 1.5 seconds
    for (let i = 0; i < 90; i++) {
      body.step(1 / 60, { throttle: 0, steer: 0, brake: 0, handbrake: false, jump: false }, ground, [], surfaceProvider);
    }

    // Car should have fallen down close to the riverbed
    expect(body.pos.y).toBeLessThan(10.0);
    expect(body.groundY).toBeCloseTo(0.8, 1);
  });

  it('Building collider representing the bridge deck beneath wheels does not block driving', () => {
    const stats = VEHICLE_TYPES[2]!;
    const body = new VehicleBody(stats);
    body.pos.set(0, 21.0, 0);
    body.vel.set(0, 0, -20); // driving forward at 20 m/s
    body.snapPrev();

    const ground = makeGround(0.8);
    // Collider for the bridge deck itself: max.y is 20.0m (at or below driving surface)
    const bridgeDeckCollider: BuildingCollider = {
      min: new Vector3(-20, 0, -50),
      max: new Vector3(20, 20.0, 50)
    };

    const surfaceProvider = () => 20.0;

    body.step(1 / 60, { throttle: 1, steer: 0, brake: 0, handbrake: false, jump: false }, ground, [bridgeDeckCollider], surfaceProvider);

    // Car velocity should not be reflected or stopped by the deck beneath it
    expect(body.vel.z).toBeLessThan(-15);
  });

  it('Tall building/tower collider rising above the bridge deck blocks the vehicle', () => {
    const stats = VEHICLE_TYPES[2]!;
    const body = new VehicleBody(stats);
    body.pos.set(0, 21.0, 0);
    body.vel.set(0, 0, -20); // driving forward directly into tower at Z = -1
    body.snapPrev();

    const ground = makeGround(0.8);
    // Tower collider rising to Y = 50m across Z in [-5, -1]
    const towerCollider: BuildingCollider = {
      min: new Vector3(-5, 0, -5),
      max: new Vector3(5, 50.0, -1)
    };

    const surfaceProvider = () => 20.0;

    body.step(1 / 60, { throttle: 1, steer: 0, brake: 0, handbrake: false, jump: false }, ground, [towerCollider], surfaceProvider);

    // Car should collide and rebound from the tower
    expect(body.vel.z).toBeGreaterThan(-5);
  });
});
