import { html, css, LitElement } from 'lit';

/**
 * Top-bar relocate controls: Google Maps API key + place search. Errors
 * surface inline as status text — never alert().
 */
export class RelocateBar extends LitElement {
  static override styles = css`
    :host {
      position: fixed;
      top: max(var(--space-md), env(safe-area-inset-top));
      left: 50%;
      transform: translateX(-50%);
      z-index: 20;
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: var(--space-xs);
      /* stay clear of the HUD's top corners rather than covering the score */
      max-width: min(38rem, calc(100vw - 22rem));
      width: max-content;
    }
    /* too narrow to sit beside the HUD's top corners: drop below them instead
       of covering the score, and take the full width while down there */
    @media (max-width: 60rem) {
      :host {
        max-width: calc(100vw - var(--space-lg) * 2);
        top: calc(max(var(--space-md), env(safe-area-inset-top)) + 3.25rem);
      }
    }
    :host([hidden]) { display:none; }
    input { padding:var(--space-sm) var(--space-md); background:rgba(0,0,0,.6);
      border:var(--border) solid var(--line); border-radius:var(--radius-sm); color:var(--ink);
      font-family:inherit; font-size:16px; outline:none; min-width:0; }
    input:focus { border-color:var(--accent); }
    input::placeholder { color:var(--muted); }
    /* 16px keeps iOS from zooming the page when a field takes focus */
    #key { flex:1 1 9rem; min-width:7rem; }
    #q { flex:2 1 14rem; min-width:8rem; }
    button { padding:var(--space-sm) var(--space-lg); background:var(--panel2); color:var(--ink);
      border:var(--border) solid var(--line); border-radius:var(--radius-sm); font-family:inherit;
      font-weight:600; cursor:pointer; min-height:2.75rem; flex:0 0 auto; }
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
