import { html, css, LitElement } from 'lit';

/**
 * Start screen: title, premise, controls, and the path into the game.
 * Shows on boot; hidden once the player starts.
 */
export class IntroScreen extends LitElement {
  static override styles = css`
    :host { position:fixed; inset:0; display:flex; flex-direction:column; align-items:center;
      justify-content:center; background:radial-gradient(120% 90% at 50% 20%, #2a201800, rgba(26,20,16,.92));
      z-index:40; padding:20px; }
    h1 { font-family:'Russo One',sans-serif; font-size:clamp(40px,8vw,86px); line-height:.92;
      margin:0; text-align:center; text-shadow:0 4px 0 #0006; }
    .ac { color:var(--accent); }
    .sub { color:var(--muted); margin:12px 0 0; font-size:14px; max-width:540px; text-align:center; line-height:1.5; }
    .controls { margin:18px 0; font-size:14px; color:#9e9; text-align:center; line-height:1.8; }
    .controls kbd { background:var(--panel2); border:1px solid var(--line); border-bottom-width:2px;
      border-radius:4px; padding:1px 6px; font-family:'JetBrains Mono',monospace; font-size:12px; color:var(--ink); }
    .play { margin-top:18px; padding:14px 42px; background:var(--accent); color:#1a1410;
      font-family:'Russo One',sans-serif; font-size:18px; border:none; border-radius:10px; cursor:pointer;
      box-shadow:0 6px 0 #b0390f; transition:transform .08s, box-shadow .2s; }
    .play:hover { transform:translateY(-2px); box-shadow:0 8px 0 #b0390f; }
    .play:active { transform:translateY(4px); box-shadow:0 2px 0 #b0390f; }
  `;

  onStart?: () => void;

  override render() {
    return html`
      <h1>SMUGGLERS <span class="ac">TOWN 3D</span></h1>
      <p class="sub">Turf Wars — a single piece of contraband spawns on the map. Grab it, rush it back to
      your crew's base. Get rammed and it transfers to the attacker. First team to 5 deliveries wins.</p>
      <div class="controls">
        <kbd>W</kbd>/<kbd>↑</kbd> accelerate · <kbd>S</kbd>/<kbd>↓</kbd> brake/reverse ·
        <kbd>A</kbd><kbd>D</kbd>/<kbd>←</kbd><kbd>→</kbd> steer · <kbd>Space</kbd> jump-boost<br>
        <kbd>R</kbd> reset car · <kbd>C</kbd> camera · <kbd>1-5</kbd> switch vehicle
      </div>
      <button class="play" @click=${() => this.onStart?.()}>START ENGINE</button>
    `;
  }
}
customElements.define('sr-intro', IntroScreen);
