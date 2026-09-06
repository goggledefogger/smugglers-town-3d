import { html, css } from 'lit';
import { HudComponent } from './HudComponent.ts';

export class SpeedGauge extends HudComponent {
  static override styles = css`
    :host { display: block; }
    .panel { display:flex; align-items:baseline; gap:6px; padding:8px 12px;
      background:rgba(15,22,34,.86); border:1px solid var(--line); border-radius:10px;
      backdrop-filter:blur(8px); box-shadow:0 4px 14px rgba(0,0,0,.4); }
    .num { font-family:'Russo One',sans-serif; font-size:34px; line-height:1; color:var(--accent); }
    .unit { font-size:11px; color:var(--muted); letter-spacing:.14em; text-transform:uppercase; }
    .veh { font-size:11px; color:var(--muted); margin-left:8px; letter-spacing:.08em; }
  `;

  override render() {
    const s = this.snapshot;
    return html`
      <div class="panel">
        <span class="num">${Math.round((s?.speed ?? 0) * 3.6)}</span>
        <span class="unit">km/h</span>
        <span class="veh">${s?.vehicleName ?? ''}</span>
      </div>
    `;
  }
}
customElements.define('sr-speed', SpeedGauge);
