import { html, css } from 'lit';
import { HudComponent } from './HudComponent.ts';
import { navOrientation, navTransform } from './navArrow.ts';
import type { NavGoal } from '../../app/navTarget.ts';

/** One face colour per goal; the shaded back and edge mix themselves from it. */
const GOAL_LABEL: Record<NavGoal, string> = {
  collect: 'CONTRABAND',
  deliver: 'YOUR BASE',
  chase: 'CHASE',
  escort: 'ESCORT'
};

/**
 * 3D navigation chevron toward the contraband or your base. Unlike a flat
 * compass arrow it lies in the world's ground plane, so "ahead and far" reads
 * differently from "behind and over your shoulder." Built with CSS 3D
 * transforms (preserve-3d + perspective) so the HUD stays in Lit and never
 * touches three.js for this.
 *
 * The chevron is an extruded plate — front face, back face, and an edge slab
 * between them — lying on a ground plane leaned away from the camera, the way
 * a racer paints a turn arrow on the road. navArrow.ts owns the orientation;
 * see it for why the rotation order matters. Per frame the frame loop calls
 * setNav() which writes the transform straight to the element — it never steps
 * at the 10 Hz snapshot cadence or lags behind a turn.
 */
export class DirArrow extends HudComponent {
  static override styles = css`
    /*
     * Two knobs. --chev-size drives every length below as a ratio of itself,
     * so the marker scales to a phone or a 4K panel from one value. --chev-face
     * drives every colour: the shaded back and edge are mixed from it, so the
     * delivery state overrides that one property and the whole plate follows.
     *
     * The host is a full-width, zero-height strip rather than a left:50% anchor
     * point. Chrome clamps margin:auto to zero when the container is narrower
     * than the child, which parked the chevron half its width off the point it
     * spins and projects about, so it orbited instead of turning in place.
     */
    :host {
      --chev-size: clamp(48px, 5vw, 72px);
      --chev-depth: calc(var(--chev-size) * 0.11);
      --chev-centre: calc(var(--chev-size) / 2);
      --chev-glow: calc(var(--chev-size) * 0.22);
      --chev-face: var(--good);
      --chev-back: color-mix(in srgb, var(--chev-face) 55%, #000);
      --chev-edge: color-mix(in srgb, var(--chev-face) 28%, #000);
      --chev-label: var(--ink);

      display: block;
      position: absolute;
      top: 16%;
      left: 0;
      right: 0;
      height: 0;
      text-align: center;
      pointer-events: none;
      perspective: calc(var(--chev-size) * 5.3);
      perspective-origin: 50% var(--chev-centre);
    }
    /* each goal is one property; every mix above re-derives from it */
    :host(.goal-deliver) { --chev-face: var(--hot); --chev-label: var(--sand); }
    :host(.goal-chase) { --chev-face: var(--accent); --chev-label: var(--sand); }
    :host(.goal-escort) { --chev-face: var(--cool); }

    .stage { transform-style: preserve-3d; will-change: transform; }

    /* the lean lives on .stage with the yaw, in one chain: a lean applied here
       would multiply in after the yaw and become roll */
    .plate {
      transform-style: preserve-3d;
      position: relative;
      width: var(--chev-size);
      height: var(--chev-size);
      margin: 0 auto;
    }
    /* no backface-visibility: the three faces all point the same way, so
       hiding backfaces could only ever make the chevron vanish */
    .face {
      position: absolute;
      inset: 0;
      clip-path: polygon(50% 0, 100% 60%, 66% 60%, 66% 100%, 34% 100%, 34% 60%, 0 60%);
    }
    /* drop-shadow, not box-shadow: clip-path clips a box-shadow away with the
       rest of the box, so the glow never drew. A filter follows the clipped
       silhouette instead — dark rim first to hold the shape against a bright
       sky, then the colour bloom */
    .front {
      background: var(--chev-face);
      filter: drop-shadow(0 0 calc(var(--chev-glow) / 4) rgb(0 0 0 / .75))
              drop-shadow(0 0 var(--chev-glow) var(--chev-face));
      transition: background .2s, filter .2s;
    }
    .back {
      background: var(--chev-back);
      transform: translateZ(calc(var(--chev-depth) * -1));
      opacity: .55;
    }
    /* a thin slab between the faces, read as thickness */
    .edge {
      background: var(--chev-edge);
      transform: translateZ(calc(var(--chev-depth) / -2));
      opacity: .4;
      filter: blur(0.6px);
    }
    .label {
      margin-top: calc(var(--chev-size) * 0.12);
      white-space: nowrap;
      color: var(--chev-label);
      font-size: calc(var(--chev-size) * 0.2);
      font-weight: 700;
      letter-spacing: .04em;
      text-shadow: 0 0 4px #000, 0 0 8px #000;
      transition: color .2s;
    }
  `;

  private stageEl: HTMLElement | null = null;

  /**
   * Orient the chevron each frame. Only the transform and opacity are written
   * here — both land on the .stage element's style, never on Lit-managed
   * children, so this can run every frame without fighting re-renders. Color
   * and label come from the 10 Hz snapshot via render().
   * yaw: radians clockwise from straight ahead (horizontal bearing)
   * distance: planar world distance to the target (for the closeness cue)
   */
  setNav(yaw: number, distance: number): void {
    this.stageEl ??= this.renderRoot.querySelector('.stage');
    if (!this.stageEl) return;
    const o = navOrientation(yaw, distance);
    this.stageEl.style.transform = navTransform(o);
    this.stageEl.style.opacity = String(o.opacity);
  }

  override render() {
    const goal: NavGoal = this.snapshot?.navGoal ?? 'collect';
    // the goal is a host class so one custom property retints the whole marker
    for (const g of Object.keys(GOAL_LABEL) as NavGoal[]) this.classList.toggle(`goal-${g}`, g === goal);
    // naming the car you are chasing beats a bare verb when four of them are on screen
    const who = this.snapshot?.carrierName;
    const label = (goal === 'chase' || goal === 'escort') && who ? `${GOAL_LABEL[goal]} ${who}` : GOAL_LABEL[goal];
    return html`
      <div class="stage">
        <div class="plate">
          <div class="face edge"></div>
          <div class="face back"></div>
          <div class="face front"></div>
        </div>
      </div>
      <div class="label">${label}</div>
    `;
  }
}
customElements.define('sr-dirarrow', DirArrow);
