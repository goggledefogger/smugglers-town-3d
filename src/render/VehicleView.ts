/**
 * Vehicle mesh + binding to a physics body. One view per actor; the view
 * reads body state each frame and writes it to the mesh (never the reverse).
 *
 * `group` carries only the world position; the car body rotates inside it so
 * the health bar and the blob shadow stay upright when the car rolls.
 */
import {
  Group, Mesh, BoxGeometry, CylinderGeometry, CircleGeometry, MeshLambertMaterial,
  MeshStandardMaterial, MeshBasicMaterial, Sprite, SpriteMaterial, CanvasTexture, MathUtils
} from 'three';
import type { VehicleActor } from '../app/Game.ts';

const TEAM_COLORS = [0x44ff66, 0xff5544] as const;

export class VehicleView {
  readonly group = new Group();
  private readonly carRoot = new Group();
  private readonly healthBar: Sprite;
  private readonly barCanvas: HTMLCanvasElement;
  private readonly barTexture: CanvasTexture;
  private readonly shadow: Mesh<CircleGeometry, MeshBasicMaterial>;
  private readonly team: number;

  constructor(private readonly actor: VehicleActor) {
    const teamColor = actor.team === 0 ? TEAM_COLORS[0] : TEAM_COLORS[1];
    const g = new Group();
    // body
    const bodyMesh = new Mesh(
      new BoxGeometry(2.2, 1, 4),
      new MeshStandardMaterial({ color: teamColor, roughness: 0.6, metalness: 0.3 })
    );
    bodyMesh.position.y = 1.1;
    g.add(bodyMesh);
    // cabin
    const cab = new Mesh(
      new BoxGeometry(1.8, 0.7, 2),
      new MeshLambertMaterial({ color: 0x222831 })
    );
    cab.position.set(0, 1.7, -0.2);
    g.add(cab);
    // wheels
    const wheelGeo = new CylinderGeometry(0.7, 0.7, 0.5, 12);
    const wheelMat = new MeshLambertMaterial({ color: 0x111111 });
    const wp = [
      [0.95, 0.7, 1.3], [-0.95, 0.7, 1.3], [0.95, 0.7, -1.3], [-0.95, 0.7, -1.3]
    ] as const;
    for (const [x, y, z] of wp) {
      const w = new Mesh(wheelGeo, wheelMat);
      w.rotation.z = Math.PI / 2;
      w.position.set(x, y, z);
      g.add(w);
    }
    // roll bar
    const bar = new Mesh(
      new BoxGeometry(2.4, 0.2, 0.2),
      new MeshLambertMaterial({ color: 0x444444 })
    );
    bar.position.set(0, 1.4, 2);
    g.add(bar);
    this.carRoot.add(g);
    this.group.add(this.carRoot);

    // blob shadow on the ground under the car: invisible while planted, fades
    // in with height so a gap between car and shadow reads as "airborne"
    this.shadow = new Mesh(
      new CircleGeometry(2.4, 20),
      new MeshBasicMaterial({
        color: 0x000000, transparent: true, opacity: 0, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4
      })
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.group.add(this.shadow);

    // health bar sprite above the vehicle
    this.barCanvas = document.createElement('canvas');
    this.barCanvas.width = 64;
    this.barCanvas.height = 8;
    this.barTexture = new CanvasTexture(this.barCanvas);
    this.healthBar = new Sprite(new SpriteMaterial({
      map: this.barTexture, depthTest: false, transparent: true
    }));
    this.healthBar.scale.set(4, 0.5, 1);
    this.healthBar.position.set(0, 3.2, 0);
    this.group.add(this.healthBar);
    this.team = actor.team;
    this.updateHealthBar();
    this.sync();
  }

  private updateHealthBar(): void {
    const ctx = this.barCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, 64, 8);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 64, 8);
    const frac = 1 - this.actor.body.damage;
    ctx.fillStyle = this.team === 0 ? '#3f3' : '#f33';
    ctx.fillRect(1, 1, 62 * Math.max(0, frac), 6);
    this.barTexture.needsUpdate = true;
  }

  sync(): void {
    const body = this.actor.body;
    this.group.position.copy(body.pos);
    this.carRoot.quaternion.copy(body.quat);
    const height = Math.max(0, body.pos.y - body.groundY - body.cfg.groundClearance);
    this.shadow.position.y = body.groundY - body.pos.y + 0.15;
    this.shadow.material.opacity = MathUtils.clamp(height * 0.15, 0, 0.45);
    const s = MathUtils.clamp(1 - height * 0.02, 0.5, 1);
    this.shadow.scale.set(s, s, 1);
    this.updateHealthBar();
  }

  dispose(): void {
    this.group.traverse(obj => {
      if (obj instanceof Mesh) {
        obj.geometry.dispose();
        (obj.material as MeshLambertMaterial | MeshStandardMaterial).dispose();
      }
    });
    this.barTexture.dispose();
  }
}
