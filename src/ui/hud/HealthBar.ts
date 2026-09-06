import { html, css } from 'lit';
import { HudComponent } from './HudComponent.ts';

export class HealthBar extends HudComponent {
  static override styles = css`
    :host { display: block; }
    .panel { padding:8px 12px; background:rgba(15,22,34,.86); border:1px solid var(--line);
      border-radius:10px; backdrop-filter:blur(8px); box-shadow:0 4px 14px rgba(0,0,0,.4); }
    .lab { display:flex; justify-content:space-between; font-size:10px; letter-spacing:.14em;
      text-transform:uppercase; color:var(--muted); margin-bottom:4px; }
    .bar { height:8px; background:#070b12; border-radius:6px; overflow:hidden; border:1px solid var(--line); }
    .fill { display:block; height:100%; border-radius:5px; transition:width .12s linear, background .2s; }
    .fill.ok { background:#7dd87d; }
    .fill.warn { background:#ffb84d; }
    .fill.bad { background:var(--hot); }
  `;

  override render() {
    const s = this.snapshot;
    const dmg = s?.damage ?? 0;
    const pct = Math.round((1 - dmg) * 100);
    const cls = dmg > 0.6 ? 'bad' : dmg > 0.3 ? 'warn' : 'ok';
    return html`
      <div class="panel">
        <div class="lab"><span>Integrity</span><span>${pct}%</span></div>
        <div class="bar"><span class="fill ${cls}" style="width:${pct}%"></span></div>
      </div>
    `;
  }
}
customElements.define('sr-health', HealthBar);
