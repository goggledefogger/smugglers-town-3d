import { html, css, svg } from 'lit';
import { HudComponent } from './HudComponent.ts';

/**
 * Center-screen direction arrow toward the contraband or your base. The
 * label and color come from the 10 Hz HUD snapshot; the rotation is set
 * every frame through `setBearing`, straight onto the element, so it never
 * steps or lags behind a turn.
 */
export class DirArrow extends HudComponent {
  static override styles = css`
    :host { display:block; position:absolute; top:18%; left:50%;
      transform:translateX(-50%); text-align:center; pointer-events:none; }
    .arrow { display:block; width:34px; height:64px; margin:0 auto; color:#3f3;
      filter:drop-shadow(0 0 10px #3f3) drop-shadow(0 0 3px #000); transition:color .2s; }
    .arrow.toDelivery { color:#f33; filter:drop-shadow(0 0 10px #f33) drop-shadow(0 0 3px #000); }
    .label { font-size:14px; color:#fff; text-shadow:0 0 4px #000; margin-top:4px; font-weight:bold; }
  `;

  private arrowEl: SVGElement | null = null;

  /** Radians clockwise from straight ahead. */
  setBearing(rad: number): void {
    this.arrowEl ??= this.renderRoot.querySelector('.arrow');
    if (this.arrowEl) this.arrowEl.style.transform = `rotate(${rad}rad)`;
  }

  override render() {
    const s = this.snapshot;
    const toDelivery = s?.targetIsDelivery ?? false;
    // a tall notched arrowhead: the tip is unmistakable at any rotation
    return html`
      ${svg`<svg class="arrow ${toDelivery ? 'toDelivery' : ''}" viewBox="0 0 34 64" aria-hidden="true">
        <polygon points="17,0 34,58 17,46 0,58" fill="currentColor" />
      </svg>`}
      <div class="label">${toDelivery ? 'YOUR BASE' : 'CONTRABAND'}</div>
    `;
  }
}
customElements.define('sr-dirarrow', DirArrow);
