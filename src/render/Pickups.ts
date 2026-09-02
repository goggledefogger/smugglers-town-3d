/**
 * Contraband crate + the two team-base smoke markers, driven by MatchRules
 * state each frame.
 */
import {
  Mesh, IcosahedronGeometry, CylinderGeometry, MeshStandardMaterial,
  MeshBasicMaterial, PointLight, Vector3, DoubleSide
} from 'three';
import type { MatchState } from '../core/gameplay/MatchRules.ts';
import { TEAM_COLORS, type Pose } from './VehicleView.ts';
import { config } from '../app/config.ts';

export class Pickups {
  private readonly contraband = new Mesh(
    new IcosahedronGeometry(1.6, 0),
    new MeshStandardMaterial({
      color: 0xffcc00, emissive: 0xff8800, emissiveIntensity: 0.6,
      metalness: 0.3, roughness: 0.4
    })
  );
  private readonly contrabandLight = new PointLight(0xffaa00, 2, 40);
  private readonly bases: readonly [Mesh, Mesh];
  private readonly _back = new Vector3();

  constructor(scene: { add(m: Mesh): void }) {
    this.contraband.add(this.contrabandLight);
    scene.add(this.contraband);
    this.bases = [this.makeBase(TEAM_COLORS[0]), this.makeBase(TEAM_COLORS[1])];
    for (const b of this.bases) scene.add(b);
  }

  private makeBase(color: number): Mesh {
    const r = config.scoring.deliveryRadius;
    const m = new Mesh(
      new CylinderGeometry(r, r, 20, 24, 1, true),
      new MeshBasicMaterial({ color, transparent: true, opacity: 0.22, side: DoubleSide })
    );
    m.add(new PointLight(color, 1.5, 80));
    return m;
  }

  /** carrier: the carrier's rendered pose, so the crate rides the interpolated car. */
  sync(state: MatchState, timeS: number, dt: number, carrier: Pose | null): void {
    if (carrier) {
      // attach behind the carrier
      this._back.set(0, 2, 2.2).applyQuaternion(carrier.quat);
      this.contraband.position.copy(carrier.pos).add(this._back);
    } else {
      const bob = Math.sin(timeS * 3.3) * 0.4;
      this.contraband.position.set(
        state.contrabandPos.x,
        state.contrabandPos.y + bob,
        state.contrabandPos.z
      );
      this.contraband.rotation.y += dt * 2;
    }
    for (const team of [0, 1] as const) {
      const b = state.bases[team];
      this.bases[team].position.set(b.x, b.y + 10, b.z);
    }
  }

  dispose(): void {
    this.contraband.geometry.dispose();
    (this.contraband.material as MeshStandardMaterial).dispose();
    for (const b of this.bases) {
      b.geometry.dispose();
      (b.material as MeshBasicMaterial).dispose();
    }
  }
}
