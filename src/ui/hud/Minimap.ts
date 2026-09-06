import { html, css } from 'lit';
import { HudComponent } from './HudComponent.ts';
import { hillshade, radarProject, headingOf } from './radar.ts';
import { MINIMAP_COLORS } from '../../core/theme.ts';
import type { Heightfield } from '../../core/heightfield.ts';
import type { MatchState } from '../../core/gameplay/MatchRules.ts';
import type { VehicleActor } from '../../app/Game.ts';
import type { NavGoal } from '../../app/navTarget.ts';

/**
 * The tactical radar: shaded terrain relief under live blips, heading-up.
 *
 * Smuggler's Run split navigation in two, and this is the half the direction
 * arrow deliberately cannot do. The arrow gives a bearing and knows nothing
 * about the ground — it will happily point you straight through a ridge — so
 * the map is what you read to pick a line around one. That makes the relief
 * the substance here, not decoration: a flat brown square with dots on it
 * tells you where things are but not how to get to them.
 *
 * Heading-up rather than north-up, so "left around that hill" on the radar is
 * left on the screen too; a north tick on the rim keeps you oriented while it
 * spins. Anything past the radar's range is pinned to the rim keeping its
 * bearing, so an objective is never simply absent.
 *
 * Relief is rasterised once per terrain (`setTerrain`) into an offscreen
 * canvas and merely rotated per frame — a real place is a 313k-vertex
 * heightfield and reshading it at 60 Hz is not affordable.
 */

/** World units from the player to the rim. About a third of the field. */
const RANGE = 1750;
/** Relief raster resolution. 256 is one texel per ~3 m of a 840-unit field. */
const RELIEF_N = 256;
/**
 * Vertical exaggeration for the shading only, never for anything you drive on.
 * Real dunes are gentle enough that honest gradients render as one flat brown;
 * the map exists to make a ridge legible, so tune this by eye if the terrain
 * changes scale.
 */
const RELIEF_EXAGGERATION = 3;

interface Blip {
  readonly x: number;
  readonly z: number;
  readonly fill: string;
  readonly r: number;
  readonly ring?: string;
}

export class Minimap extends HudComponent {
  static override styles = css`
    :host {
      --radar-size: clamp(104px, 13vw + 4vh, 170px);
      --radar-rim: rgba(56, 189, 248, 0.35);
      display: block;
      width: var(--radar-size);
      height: var(--radar-size);
      position: relative;
    }
    canvas {
      width: 100%;
      height: 100%;
      display: block;
      border-radius: 50%;
      border: var(--border) solid var(--radar-rim);
      background: var(--panel);
      box-sizing: border-box;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    }
    /* the goal tints the rim, the same one property the nav chevron keys off,
       so the radar and the arrow never disagree about what you are doing */
    :host(.goal-deliver) { --radar-rim: var(--hot); }
    :host(.goal-chase) { --radar-rim: var(--accent); }
    :host(.goal-escort) { --radar-rim: var(--cool); }
    :host(.goal-collect) { --radar-rim: var(--sand); }
  `;

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  /** Shaded relief for the current terrain, in world-aligned north-up pixels. */
  private relief: HTMLCanvasElement | null = null;
  private mapHalf = 2800;

  override firstUpdated(): void {
    this.canvas = this.renderRoot.querySelector('canvas');
    if (!this.canvas) return;
    // draw at device resolution: a blurry map is an unreadable map
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const css = this.canvas.getBoundingClientRect().width || 170;
    this.canvas.width = Math.round(css * dpr);
    this.canvas.height = Math.round(css * dpr);
    this.ctx = this.canvas.getContext('2d');
  }

  /**
   * Rasterise the relief for a terrain. Call on every terrain change — a
   * relocation, or the ground sharpening as tiles stream in.
   */
  setTerrain(heightfield: Heightfield, mapHalf: number): void {
    this.mapHalf = mapHalf;
    const cv = document.createElement('canvas');
    cv.width = RELIEF_N;
    cv.height = RELIEF_N;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(RELIEF_N, RELIEF_N);
    const step = (mapHalf * 2) / RELIEF_N;
    let lo = Infinity;
    let hi = -Infinity;
    const h = new Float32Array(RELIEF_N * RELIEF_N);
    for (let j = 0; j < RELIEF_N; j++) {
      const z = -mapHalf + j * step;
      for (let i = 0; i < RELIEF_N; i++) {
        const y = heightfield.sample(-mapHalf + i * step, z);
        h[j * RELIEF_N + i] = y;
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
    }
    const span = Math.max(1e-3, hi - lo);
    const { lowGround, highRidge } = MINIMAP_COLORS;
    for (let j = 0; j < RELIEF_N; j++) {
      for (let i = 0; i < RELIEF_N; i++) {
        const k = j * RELIEF_N + i;
        const ie = Math.min(RELIEF_N - 1, i + 1);
        const je = Math.min(RELIEF_N - 1, j + 1);
        const gx = ((h[j * RELIEF_N + ie]! - h[k]!) / step) * RELIEF_EXAGGERATION;
        const gz = ((h[je * RELIEF_N + i]! - h[k]!) / step) * RELIEF_EXAGGERATION;
        const shade = hillshade(gx, gz);
        // height tints low ground dark slate and ridges crisp illuminated steel/cyan
        const t = (h[k]! - lo) / span;
        const lum = 0.35 + 0.65 * shade;
        const o = k * 4;
        img.data[o] = Math.round((lowGround.r + (highRidge.r - lowGround.r) * t) * lum);
        img.data[o + 1] = Math.round((lowGround.g + (highRidge.g - lowGround.g) * t) * lum);
        img.data[o + 2] = Math.round((lowGround.b + (highRidge.b - lowGround.b) * t) * lum);
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.relief = cv;
  }

  /** Per frame, from the frame loop — never at the 10 Hz snapshot cadence. */
  draw(
    state: MatchState,
    actors: readonly VehicleActor[],
    player: VehicleActor | undefined,
    target: { x: number; z: number } | null
  ): void {
    const ctx = this.ctx;
    const cv = this.canvas;
    if (!ctx || !cv) return;
    const size = cv.width;
    const radius = size / 2;
    const px = player?.body.pos.x ?? 0;
    const pz = player?.body.pos.z ?? 0;
    let yaw = 0;
    if (player) {
      const f = player.body.forward();
      yaw = headingOf(f.x, f.z);
    }

    ctx.save();
    ctx.clearRect(0, 0, size, size);
    ctx.beginPath();
    ctx.arc(radius, radius, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(radius, radius);

    this.drawRelief(ctx, px, pz, yaw, radius);
    this.drawRangeRings(ctx, radius);

    const blips: Blip[] = [];
    for (const team of [0, 1] as const) {
      const b = state.bases[team];
      blips.push({
        x: b.x, z: b.z, r: radius * 0.055,
        fill: team === 0 ? 'rgba(125,216,125,.55)' : 'rgba(79,195,247,.55)',
        ring: team === 0 ? '#7dd87d' : '#4fc3f7'
      });
    }
    // every loose crate of the wave; a carried one shows on its carrier instead
    for (const crate of state.contraband) {
      if (crate.delivered || crate.carrier) continue;
      blips.push({ x: crate.pos.x, z: crate.pos.z, r: radius * 0.032, fill: '#ffd54a', ring: '#fff' });
    }
    const carrying = new Set(state.contraband.filter(c => c.carrier).map(c => c.carrier));
    for (const a of actors) {
      if (a === player) continue;
      const loaded = carrying.has(a.body);
      blips.push({
        x: a.body.pos.x, z: a.body.pos.z,
        r: radius * (loaded ? 0.036 : 0.026),
        fill: a.team === 0 ? '#7dd87d' : '#ff5a4a',
        ...(loaded ? { ring: '#ffd54a' } : {})
      });
    }
    for (const b of blips) this.drawBlip(ctx, b, px, pz, yaw, radius);
    if (target) this.drawTarget(ctx, target, px, pz, yaw, radius);

    ctx.restore();
    this.drawNorth(ctx, yaw, radius);
    this.drawPlayer(ctx, radius);
  }

  private drawRelief(ctx: CanvasRenderingContext2D, px: number, pz: number, yaw: number, radius: number): void {
    if (!this.relief) return;
    const perWorld = radius / RANGE;
    ctx.save();
    ctx.rotate(-yaw);
    ctx.scale(perWorld, perWorld);
    // the relief is north-up over the whole field; place it so the player sits
    // at the origin we just translated to
    const span = this.mapHalf * 2;
    ctx.drawImage(this.relief, -this.mapHalf - px, -this.mapHalf - pz, span, span);
    ctx.restore();
  }

  private drawRangeRings(ctx: CanvasRenderingContext2D, radius: number): void {
    ctx.strokeStyle = MINIMAP_COLORS.rings;
    ctx.lineWidth = Math.max(1, radius * 0.008);
    for (const f of [0.33, 0.66]) {
      ctx.beginPath();
      ctx.arc(0, 0, radius * f, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawBlip(
    ctx: CanvasRenderingContext2D, b: Blip, px: number, pz: number, yaw: number, radius: number
  ): void {
    const p = radarProject(b.x - px, b.z - pz, yaw, RANGE, radius * 0.94);
    ctx.globalAlpha = p.clamped ? 0.55 : 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, b.r, 0, Math.PI * 2);
    ctx.fillStyle = b.fill;
    ctx.fill();
    if (b.ring) {
      ctx.strokeStyle = b.ring;
      ctx.lineWidth = Math.max(1, radius * 0.014);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** The objective gets a chevron on the rim, not a dot, so it reads as "that way". */
  private drawTarget(
    ctx: CanvasRenderingContext2D, target: { x: number; z: number },
    px: number, pz: number, yaw: number, radius: number
  ): void {
    const p = radarProject(target.x - px, target.z - pz, yaw, RANGE, radius * 0.88);
    const a = Math.atan2(p.y, p.x);
    const s = radius * 0.075;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(a + Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.lineTo(s * 0.8, s * 0.6);
    ctx.lineTo(-s * 0.8, s * 0.6);
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.globalAlpha = p.clamped ? 0.95 : 0.65;
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  private drawNorth(ctx: CanvasRenderingContext2D, yaw: number, radius: number): void {
    ctx.save();
    ctx.translate(radius, radius);
    ctx.rotate(-yaw);
    ctx.translate(0, -radius * 0.9);
    ctx.rotate(yaw);
    ctx.fillStyle = MINIMAP_COLORS.north;
    ctx.font = `700 ${Math.round(radius * 0.17)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', 0, 0);
    ctx.restore();
  }

  private drawPlayer(ctx: CanvasRenderingContext2D, radius: number): void {
    const s = radius * 0.1;
    ctx.save();
    ctx.translate(radius, radius);
    ctx.beginPath();
    ctx.moveTo(0, -s * 1.3);
    ctx.lineTo(s * 0.85, s);
    ctx.lineTo(0, s * 0.45);
    ctx.lineTo(-s * 0.85, s);
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,.65)';
    ctx.lineWidth = Math.max(1, radius * 0.012);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  override render() {
    const goal: NavGoal = this.snapshot?.navGoal ?? 'collect';
    for (const g of ['collect', 'deliver', 'chase', 'escort'] as NavGoal[]) {
      this.classList.toggle(`goal-${g}`, g === goal);
    }
    return html`<canvas></canvas>`;
  }
}
customElements.define('sr-minimap', Minimap);
