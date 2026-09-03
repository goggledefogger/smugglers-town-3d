import { html, css } from 'lit';
import { HudComponent } from './HudComponent.ts';

/**
 * 3D navigation chevron toward the contraband or your base. Unlike a flat
 * compass arrow, it points into the world with both yaw and pitch, so "ahead
 * and far" reads differently from "behind and over your shoulder" or "up on
 * the rooftop." Built with CSS 3D transforms (preserve-3d + perspective) so
 * the HUD stays in Lit and never touches three.js for this.
 *
 * The chevron is a folded sign: front face, back face, and an extruded edge,
 * leaned back toward the viewer at a fixed pitch so it reads as a 3D marker
 * floating in space, not a sticker on the screen. Per frame the frame loop
 * calls setNav() which writes the transform straight to the element — it
 * never steps at the 10 Hz snapshot cadence or lags behind a turn.
 */
export class DirArrow extends HudComponent {
  static override styles = css`
    :host { display:block; position:absolute; top:16%; left:50%;
      width:0; height:0; text-align:center; pointer-events:none;
      perspective:340px; }
    .stage {
      transform-style:preserve-3d;
      will-change:transform;
    }
    /* fixed lean toward the viewer: the "nice angle" that makes a flat
       chevron read as a 3D sign pointing into the world */
    .fold {
      transform-style:preserve-3d;
      transform:rotateX(46deg);
      position:relative;
      width:64px; height:64px; margin:0 auto;
    }
    .face {
      position:absolute; inset:0;
      backface-visibility:hidden;
    }
    /* front chevron, facing the viewer */
    .front {
      clip-path:polygon(50% 0, 100% 60%, 66% 60%, 66% 100%, 34% 100%, 34% 60%, 0 60%);
      background:#3f3;
      box-shadow:0 0 14px #3f3, 0 0 5px #0008;
      transition:background .2s, box-shadow .2s;
    }
    /* rear chevron on the back of the folded sign, darker for depth */
    .back {
      transform:translateZ(-7px);
      clip-path:polygon(50% 0, 100% 60%, 66% 60%, 66% 100%, 34% 100%, 34% 60%, 0 60%);
      background:#1a1;
      opacity:0.55;
    }
    /* the extruded edge between the faces, a thin slab read as thickness */
    .edge {
      position:absolute; inset:0;
      transform:translateZ(-3.5px);
      clip-path:polygon(50% 0, 100% 60%, 66% 60%, 66% 100%, 34% 100%, 34% 60%, 0 60%);
      background:#070;
      opacity:0.4;
      filter:blur(0.6px);
    }
    .fold.toDelivery .front { background:#f33; box-shadow:0 0 14px #f33, 0 0 5px #0008; }
    .fold.toDelivery .back { background:#a11; }
    .fold.toDelivery .edge { background:#700; }
    .label {
      font-size:13px; color:#fff; text-shadow:0 0 4px #000, 0 0 8px #000;
      margin-top:8px; font-weight:bold; letter-spacing:.04em;
      transition:color .2s;
    }
    .label.toDelivery { color:#ffd; }
  `;

  private stageEl: HTMLElement | null = null;

  /**
   * Orient the chevron each frame. Only the transform and opacity are written
   * here — both land on the .stage element's style, never on Lit-managed
   * children, so this can run every frame without fighting re-renders. Color
   * and label come from the 10 Hz snapshot via render().
   * yaw: radians clockwise from straight ahead (horizontal bearing)
   * pitch: radians, positive = target above the horizon
   * distance: planar world distance to the target (for the closeness cue)
   */
  setNav(yaw: number, pitch: number, distance: number): void {
    this.stageEl ??= this.renderRoot.querySelector('.stage');
    if (!this.stageEl) return;
    // world-forward is -Z; yaw is clockwise so rotateZ(-yaw) turns the nose
    // left/right to match. clamp pitch so the marker never flips overhead.
    const p = Math.max(-0.9, Math.min(0.9, pitch));
    // the beacon beam takes over near the target: shrink + fade the chevron
    const closeness = 1 - Math.min(1, distance / 40);
    const scale = 1 - closeness * 0.35;
    this.stageEl.style.transform =
      `rotateX(${p}rad) rotateZ(${-yaw}rad) scale(${scale})`;
    this.stageEl.style.opacity = String(1 - closeness * 0.6);
  }

  override render() {
    const s = this.snapshot;
    const toDelivery = s?.targetIsDelivery ?? false;
    return html`
      <div class="stage">
        <div class="fold ${toDelivery ? 'toDelivery' : ''}">
          <div class="face edge"></div>
          <div class="face back"></div>
          <div class="face front"></div>
        </div>
      </div>
      <div class="label ${toDelivery ? 'toDelivery' : ''}">${toDelivery ? 'YOUR BASE' : 'CONTRABAND'}</div>
    `;
  }
}
customElements.define('sr-dirarrow', DirArrow);
