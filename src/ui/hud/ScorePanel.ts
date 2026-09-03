import { html, css } from 'lit';
import { HudComponent } from './HudComponent.ts';

/** Scores with the round clock between them; the clock goes hot in the final minute. */
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
    .clock { font-family:'JetBrains Mono',monospace; font-size:18px; color:var(--ink); min-width:58px; text-align:center; }
    .clock.low { color:var(--hot); }
    .clock.sudden { font-family:'Russo One',sans-serif; font-size:11px; color:var(--hot); letter-spacing:.08em; }
    .pips { display:flex; gap:4px; margin-left:10px; }
    .pip { width:10px; height:10px; border-radius:3px; }
    .pip.t0 { background:#3f3; } .pip.t1 { background:#f33; }
    .pip.me { border:2px solid #fff; }

    /* on a phone the full-size panel spans the whole top row, leaving nothing
       for anything else up there; the pips are the first thing to go, since
       the scores above them say the same in fewer pixels */
    @media (max-width: 40rem) {
      .panel { gap: var(--space-sm); padding: var(--space-xs) var(--space-sm); }
      .team { min-width: 2.5rem; }
      .team .name { font-size: var(--text-2xs); letter-spacing: .08em; }
      .team .val { font-size: 1.15rem; }
      .clock { font-size: var(--text-md); min-width: 3rem; }
      .pips { display: none; }
    }
  `;

  override render() {
    const s = this.snapshot;
    const pips = (s?.teamPips ?? []).map(
      p => html`<span class="pip ${p.team === 0 ? 't0' : 't1'} ${p.isPlayer ? 'me' : ''}"></span>`
    );
    const sudden = s?.phase === 'suddenDeath';
    const t = Math.max(0, Math.ceil(s?.timeLeftS ?? 0));
    const clock = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    return html`
      <div class="panel">
        <div class="team you"><span class="name">Your Crew</span><span class="val">${s?.scores[0] ?? 0}</span></div>
        <span class="clock ${sudden ? 'sudden' : t <= 60 ? 'low' : ''}">${sudden ? 'SUDDEN DEATH' : clock}</span>
        <div class="team opp"><span class="name">Rivals</span><span class="val">${s?.scores[1] ?? 0}</span></div>
        <div class="pips">${pips}</div>
      </div>
    `;
  }
}
customElements.define('sr-score', ScorePanel);
