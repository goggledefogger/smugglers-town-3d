import { html, css, LitElement } from 'lit';

/**
 * End screen: winner, final score, and a rematch button.
 */
export class EndScreen extends LitElement {
  static override styles = css`
    :host { position:fixed; inset:0; background:rgba(11,15,23,.92); backdrop-filter:blur(8px); display:flex;
      flex-direction:column; align-items:center; justify-content:center; z-index:35; }
    :host([hidden]) { display:none; }
    h2 { font-family:'Russo One',sans-serif; font-size:clamp(36px,7vw,72px); margin:0; }
    h2.win { color:var(--accent); text-shadow:0 0 30px rgba(255,85,0,.4); }
    h2.lose { color:var(--cool); text-shadow:0 0 30px rgba(56,189,248,.4); }
    p { color:var(--muted); margin:8px 0 24px; font-size:15px; }
    .rematch { padding:12px 40px; background:var(--accent); color:#0b0f17;
      font-family:'Russo One',sans-serif; font-size:18px; border:none; border-radius:10px; cursor:pointer;
      box-shadow:0 6px 0 #c23800, 0 10px 24px rgba(255,85,0,.35); transition:transform .08s, box-shadow .2s; }
    .rematch:hover { transform:translateY(-2px); box-shadow:0 8px 0 #c23800, 0 14px 28px rgba(255,85,0,.45); }
    .rematch[data-focused] { box-shadow:0 6px 0 #c23800, 0 0 0 3px color-mix(in srgb, var(--accent) 40%, transparent); }
  `;

  static override properties = {
    winner: { type: Number },
    scores: { type: Object }
  };
  declare winner: 0 | 1 | null;
  declare scores: Record<number, number>;

  constructor() {
    super();
    this.winner = null;
    this.scores = { 0: 0, 1: 0 };
  }

  onRematch?: () => void;

  /** Handle a UI action: confirm rematches, back does too. */
  handleUiAction(action: 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back' | 'tab' | 'pause'): boolean {
    if (action === 'confirm' || action === 'back') { this.onRematch?.(); return true; }
    return false;
  }

  override updated(): void {
    // the rematch button is the only focusable; mark it on first render
    const btn = this.renderRoot.querySelector('.rematch');
    if (btn) btn.setAttribute('data-focused', '');
  }

  override render() {
    const won = this.winner === 0;
    return html`
      <h2 class="${won ? 'win' : 'lose'}">${won ? 'YOUR CREW WINS' : 'RIVALS WIN'}</h2>
      <p>Final score ${this.scores[0] ?? 0} — ${this.scores[1] ?? 0}</p>
      <button class="rematch" data-focusable @click=${() => this.onRematch?.()}>REMATCH</button>
    `;
  }
}
customElements.define('sr-end', EndScreen);
