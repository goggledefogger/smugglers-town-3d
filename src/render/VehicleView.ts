/**
 * Vehicle mesh + binding to a physics body. One view per actor; the view
 * reads body state each frame and writes it to the mesh (never the reverse).
 */
import {
  Group, Mesh, BoxGeometry, CylinderGeometry, MeshLambertMaterial,
  MeshStandardMaterial, Sprite, SpriteMaterial, CanvasTexture
} from 'three';
import type { VehicleActor } from '../app/Game.ts';

const TEAM_COLORS = [0x44ff66, 0xff5544] as const;

export class VehicleView {
  readonly group = new Group();
  private readonly healthBar: Sprite;
  private readonly barCanvas: HTMLCanvasElement;
  private readonly barTexture: CanvasTexture;
  private readonly team: number;
  private carScale = 1;

  constructor(private readonly actor: VehicleActor) {
    const body = actor.body;
    const stats = body.stats;
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
    void stats;

    this.group.add(g);

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

  setCarScale(s: number): void {
    this.carScale = s;
    this.group.scale.setScalar(s);
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
    this.group.quaternion.copy(body.quat);
    void this.carScale;
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
