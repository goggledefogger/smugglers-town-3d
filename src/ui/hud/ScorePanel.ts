import { html, css } from 'lit';
import { HudComponent } from './HudComponent.ts';

export class ScorePanel extends HudComponent {
  static override styles = css`
    :host { display: block; }
    .panel { display:flex; gap:14px; align-items:center; padding:8px 14px;
      background:rgba(36,28,22,.82); border:1px solid var(--line); border-radius:10px; }
    .team { display:flex; flex-direction:column; align-items:center; min-width:64px; }
    .team .name { font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); }
    .team .val { font-family:'Russo One',sans-serif; font-size:26px; line-height:1; }
    .you .val { color:var(--accent); }
    .opp .val { color:var(--cool); }
    .vs { font-family:'Russo One',sans-serif; color:var(--muted); font-size:16px; opacity:.7; }
    .pips { display:flex; gap:4px; margin-left:10px; }
    .pip { width:10px; height:10px; border-radius:3px; }
    .pip.t0 { background:#3f3; } .pip.t1 { background:#f33; }
    .pip.me { border:2px solid #fff; }
  `;

  override render() {
    const s = this.snapshot;
    const pips = (s?.teamPips ?? []).map(
      p => html`<span class="pip ${p.team === 0 ? 't0' : 't1'} ${p.isPlayer ? 'me' : ''}"></span>`
    );
    return html`
      <div class="panel">
        <div class="team you"><span class="name">Your Crew</span><span class="val">${s?.scores[0] ?? 0}</span></div>
        <span class="vs">VS</span>
        <div class="team opp"><span class="name">Rivals</span><span class="val">${s?.scores[1] ?? 0}</span></div>
        <div class="pips">${pips}</div>
      </div>
    `;
  }
}
customElements.define('sr-score', ScorePanel);
