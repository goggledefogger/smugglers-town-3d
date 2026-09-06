import { html, css } from 'lit';
import { HudComponent } from './HudComponent.ts';

export class ObjectiveBar extends HudComponent {
  static override styles = css`
    :host { display: block; }
    .panel { padding:8px 14px; background:rgba(15,22,34,.86); border:1px solid var(--line);
      border-radius:10px; backdrop-filter:blur(8px); box-shadow:0 4px 14px rgba(0,0,0,.4);
      font-size:12px; letter-spacing:.08em; }
    .obj { font-weight:600; }
    .obj.find { color:var(--good); }
    .obj.deliver { color:var(--accent); }
    .carrier { font-size:11px; color:var(--muted); margin-top:3px; }
  `;

  override render() {
    const s = this.snapshot;
    const delivering = s?.navGoal === 'deliver';
    const carrierText = s?.carrierName
      ? `Held by: ${s.carrierName}${s.carrierIsAlly ? ' (ally)' : s.carrierIsPlayer ? '' : ' (foe)'}`
      : '';
    return html`
      <div class="panel">
        <div class="obj ${delivering ? 'deliver' : 'find'}">${s?.objective ?? ''}</div>
        <div class="carrier">${carrierText}</div>
        <div class="carrier">Distance: ${Math.round(s?.distanceToTargetM ?? 0)} m</div>
      </div>
    `;
  }
}
customElements.define('sr-objective', ObjectiveBar);
