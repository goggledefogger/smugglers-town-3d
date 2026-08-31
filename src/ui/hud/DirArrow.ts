import { html, css } from 'lit';
import { HudComponent } from './HudComponent.ts';

/** Center-screen direction arrow toward contraband or delivery. */
export class DirArrow extends HudComponent {
  static override styles = css`
    :host { display:block; position:absolute; top:18%; left:50%;
      transform:translateX(-50%); text-align:center; pointer-events:none; }
    .arrow { font-size:64px; color:#3f3; text-shadow:0 0 12px #3f3, 0 0 4px #000;
      transition:color .2s; line-height:1; }
    .arrow.toDelivery { color:#f33; text-shadow:0 0 12px #f33, 0 0 4px #000; }
    .label { font-size:14px; color:#fff; text-shadow:0 0 4px #000; margin-top:4px; font-weight:bold; }
  `;

  override render() {
    const s = this.snapshot;
    const toDelivery = s?.targetIsDelivery ?? false;
    const angle = s?.targetBearingRad ?? 0;
    return html`
      <div class="arrow ${toDelivery ? 'toDelivery' : ''}" style="transform:rotate(${angle}rad)">▲</div>
      <div class="label">${toDelivery ? 'DELIVERY ZONE' : 'CONTRABAND'}</div>
    `;
  }
}
customElements.define('sr-dirarrow', DirArrow);
