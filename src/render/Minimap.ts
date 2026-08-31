/**
 * Canvas 2D minimap: drop zone, contraband, and vehicles on the play field.
 */
import type { MatchState } from '../core/gameplay/MatchRules.ts';
import type { VehicleActor } from '../app/Game.ts';
import type { VehicleBody } from '../core/physics/VehicleBody.ts';

export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly mapHalf: number
  ) {
    this.ctx = canvas.getContext('2d')!;
  }

  draw(state: MatchState, actors: readonly VehicleActor[], carrier: VehicleBody | null): void {
    const S = this.canvas.width;
    const hS = S / 2;
    const scale = S / (this.mapHalf * 2);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = '#3a2a1a';
    ctx.fillRect(0, 0, S, S);
    // drop zone
    const dz = this.worldToMM(state.dropZonePos.x, state.dropZonePos.z, hS, scale);
    ctx.fillStyle = 'rgba(0,255,80,0.4)';
    ctx.beginPath();
    ctx.arc(dz.x, dz.y, 8, 0, 7);
    ctx.fill();
    // contraband
    if (!carrier) {
      const c = this.worldToMM(state.contrabandPos.x, state.contrabandPos.z, hS, scale);
      ctx.fillStyle = '#ff0';
      ctx.beginPath();
      ctx.arc(c.x, c.y, 4, 0, 7);
      ctx.fill();
    }
    // vehicles
    for (const a of actors) {
      const p = this.worldToMM(a.body.pos.x, a.body.pos.z, hS, scale);
      ctx.fillStyle = a.team === 0 ? '#3f3' : '#f33';
      ctx.beginPath();
      ctx.arc(p.x, p.y, a.isPlayer ? 4 : 3, 0, 7);
      ctx.fill();
      if (a.body === carrier) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    ctx.strokeStyle = '#6c6';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, S, S);
  }

  private worldToMM(x: number, z: number, hS: number, scale: number): { x: number; y: number } {
    return { x: hS + x * scale, y: hS + z * scale };
  }
}
