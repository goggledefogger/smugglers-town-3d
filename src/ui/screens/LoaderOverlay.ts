import { html, css, LitElement } from 'lit';

/**
 * Full-screen loading overlay shown while a relocation is in flight.
 */
export class LoaderOverlay extends LitElement {
  static override styles = css`
    :host { position:fixed; inset:0; background:rgba(10,7,5,.78); display:flex;
      flex-direction:column; align-items:center; justify-content:center; z-index:30; backdrop-filter:blur(4px); }
    :host([hidden]) { display:none; }
    .spin { width:48px; height:48px; border:5px solid #444; border-top-color:var(--accent);
      border-radius:50%; animation:sp .8s linear infinite; }
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
