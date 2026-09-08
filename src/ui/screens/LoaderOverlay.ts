import { html, css, LitElement } from 'lit';

/**
 * Full-screen loading overlay shown while a relocation is in flight.
 */
export class LoaderOverlay extends LitElement {
  static override styles = css`
    :host { position:fixed; inset:0; background:rgba(7,11,18,.85); display:flex;
      flex-direction:column; align-items:center; justify-content:center; z-index:45; backdrop-filter:blur(8px); }
    :host([hidden]) { display:none; }
    .spin { width:48px; height:48px; border:5px solid #1a2536; border-top-color:var(--accent);
      border-radius:50%; animation:sp .8s linear infinite; box-shadow:0 0 16px rgba(255,85,0,.25); }
    @keyframes sp { to { transform:rotate(360deg); } }
    .msg { font-size:15px; color:var(--muted); margin-top:16px; text-align:center; max-width:420px; }
  `;

  static override properties = { message: { type: String } };
  declare message: string;

  constructor() {
    super();
    this.message = '';
  }

  override render() {
    return html`<div class="spin"></div><div class="msg">${this.message}</div>`;
  }
}
customElements.define('sr-loader', LoaderOverlay);
