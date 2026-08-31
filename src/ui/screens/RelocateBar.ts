import { html, css, LitElement } from 'lit';

/**
 * Top-bar relocate controls: Google Maps API key + place search. Errors
 * surface inline as status text — never alert().
 */
export class RelocateBar extends LitElement {
  static override styles = css`
    :host { position:fixed; top:12px; left:50%; transform:translateX(-50%); z-index:20;
      display:flex; gap:6px; align-items:center; }
    input { padding:8px 10px; background:rgba(0,0,0,.6); border:2px solid var(--line);
      border-radius:6px; color:var(--ink); font-family:inherit; font-size:13px; outline:none; }
    input:focus { border-color:var(--accent); }
    input::placeholder { color:var(--muted); }
    #key { width:180px; font-size:12px; }
    #q { width:260px; }
    button { padding:8px 14px; background:var(--panel2); color:var(--ink); border:2px solid var(--line);
      border-radius:6px; font-family:inherit; font-weight:600; cursor:pointer; }
    button:hover { border-color:var(--accent); color:var(--accent); }
    button:disabled { opacity:.5; cursor:wait; }
    .status { position:absolute; top:calc(100% + 6px); left:0; right:0; font-size:11px;
      color:var(--hot); text-align:center; pointer-events:none; }
  `;

  static override properties = { busy: { type: Boolean }, status: { type: String } };
  declare busy: boolean;
  declare status: string;

  constructor() {
    super();
    this.busy = false;
    this.status = '';
  }

  onSearch?: (query: string, key: string) => void;

  private submit(): void {
    const q = (this.renderRoot.querySelector('#q') as HTMLInputElement).value.trim();
    const key = (this.renderRoot.querySelector('#key') as HTMLInputElement).value.trim();
    if (q && this.onSearch) this.onSearch(q, key);
  }

  override render() {
    return html`
      <input id="key" type="password" placeholder="Google API key (optional)"
        @change=${(e: Event) => localStorage.setItem('gmap_key', (e.target as HTMLInputElement).value.trim())} />
      <input id="q" type="text" placeholder="Search any place on Earth…"
        @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') this.submit(); }} />
      <button ?disabled=${this.busy} @click=${() => this.submit()}>RELOCATE</button>
      ${this.status ? html`<div class="status">${this.status}</div>` : ''}
    `;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // restore saved key once inputs exist
    queueMicrotask(() => {
      const k = localStorage.getItem('gmap_key');
      const keyEl = this.renderRoot.querySelector('#key') as HTMLInputElement | null;
      if (k && keyEl) keyEl.value = k;
    });
  }
}
customElements.define('sr-relocate', RelocateBar);
