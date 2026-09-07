import { describe, it, expect } from 'vitest';
import { PerspectiveCamera, Vector3, Quaternion } from 'three';
import { CameraRig } from '../src/render/CameraRig.ts';
import { Heightfield } from '../src/core/heightfield.ts';
import type { Pose } from '../src/render/VehicleView.ts';

function makeRig(): { rig: CameraRig; camera: PerspectiveCamera } {
  const camera = new PerspectiveCamera(62, 1, 0.1, 1000);
  const hf = new Heightfield(840, 1, new Float32Array([0, 0, 0, 0]));
  const rig = new CameraRig(camera, () => hf);
  return { rig, camera };
}

describe('CameraRig', () => {
  it('snaps immediately to chase position behind player without frame lag', () => {
    const { rig, camera } = makeRig();
    camera.position.set(0, 0, 0);

    const player: Pose = {
      pos: new Vector3(100, 65, 200),
      quat: new Quaternion() // facing -z
    };

    rig.snap(player);

    // mode 0 (chase): +14 in z, +6 in y
    expect(camera.position.x).toBeCloseTo(100, 1);
    expect(camera.position.y).toBeCloseTo(71, 1);
    expect(camera.position.z).toBeCloseTo(214, 1);
  });

  it('intro begins at a high oblique angle, sweeps through a horizontal 3D view, and settles into chase pose', () => {
    const { rig, camera } = makeRig();
    const player: Pose = { pos: new Vector3(100, 65, 200), quat: new Quaternion() };
    rig.intro(6, player);
    expect(rig.introActive).toBe(true);

    // Initial frame (t ~ 0): high oblique shot (~80m height, ~85m radius, not 90-degree zenith)
    rig.update(0.01, player);
    expect(camera.position.y).toBeGreaterThan(60);
    // pulled back horizontally from player (x:100, z:200)
    const initDist = Math.hypot(camera.position.x - 100, camera.position.z - 200);
    expect(initDist).toBeGreaterThan(70);

    // After ~2 seconds (t ~ 0.35): rapidly reaches near-horizontal sweep altitude (~22m)
    for (let i = 0; i < 20; i++) rig.update(0.1, player);
    expect(camera.position.y).toBeLessThan(35);
    expect(camera.position.y).toBeGreaterThan(15);

    // Complete the rest of the intro (up to 6s)
    for (let i = 0; i < 40; i++) rig.update(0.1, player);
    expect(rig.introActive).toBe(false);
    expect(camera.position.x).toBeCloseTo(100, 0);
    expect(camera.position.y).toBeCloseTo(71, 0);
    expect(camera.position.z).toBeCloseTo(214, 0);
  });

  it('intro with no countdown is just a snap', () => {
    const { rig, camera } = makeRig();
    const player: Pose = { pos: new Vector3(0, 0, 0), quat: new Quaternion() };
    rig.intro(0, player);
    expect(rig.introActive).toBe(false);
    expect(camera.position.z).toBeCloseTo(14, 1);
  });

  it('skipIntro immediately ends the intro and snaps behind player', () => {
    const { rig, camera } = makeRig();
    const player: Pose = { pos: new Vector3(100, 65, 200), quat: new Quaternion() };
    rig.intro(6, player);
    expect(rig.introActive).toBe(true);
    rig.skipIntro(player);
    expect(rig.introActive).toBe(false);
    expect(camera.position.x).toBeCloseTo(100, 1);
    expect(camera.position.y).toBeCloseTo(71, 1);
    expect(camera.position.z).toBeCloseTo(214, 1);
  });

  it('cycles camera modes and updates zoom', () => {
    const { rig, camera } = makeRig();
    expect(rig.mode).toBe(0);
    rig.cycleMode();
    expect(rig.mode).toBe(1);
    rig.cycleMode();
    expect(rig.mode).toBe(2);
    rig.cycleMode();
    expect(rig.mode).toBe(0);

    rig.setZoom(1.5);
    expect(rig.zoom).toBe(1.5);
    expect(camera.fov).toBeCloseTo(62 + 0.5 * 2.4, 2);
  });
});
