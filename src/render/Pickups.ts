/**
 * Contraband crate + drop zone smoke marker visuals, driven by MatchRules
 * state each frame.
 */
import {
  Mesh, IcosahedronGeometry, CylinderGeometry, MeshStandardMaterial,
  MeshBasicMaterial, PointLight, Vector3, DoubleSide
} from 'three';
import type { MatchState } from '../core/gameplay/MatchRules.ts';
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
  private readonly dropMarker = new Mesh(
    new CylinderGeometry(
      config.scoring.deliveryRadius, config.scoring.deliveryRadius, 20, 24, 1, true
    ),
    new MeshBasicMaterial({
      color: 0x44ff66, transparent: true, opacity: 0.22, side: DoubleSide
    })
  );
  private readonly dropLight = new PointLight(0x44ff66, 1.5, 80);
  private readonly _back = new Vector3();

  constructor(scene: { add(m: Mesh): void }) {
    this.contraband.add(this.contrabandLight);
    this.dropMarker.add(this.dropLight);
    scene.add(this.contraband);
    scene.add(this.dropMarker);
  }

  sync(state: MatchState, timeS: number, dt: number): void {
    const carrier = state.carrier;
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
    this.dropMarker.position.set(
      state.dropZonePos.x,
      state.dropZonePos.y + 10,
      state.dropZonePos.z
    );
  }

  dispose(): void {
    this.contraband.geometry.dispose();
    (this.contraband.material as MeshStandardMaterial).dispose();
    this.dropMarker.geometry.dispose();
    (this.dropMarker.material as MeshBasicMaterial).dispose();
  }
}
