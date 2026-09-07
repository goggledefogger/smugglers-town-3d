import { html, css, LitElement } from 'lit';
import { TEST_SCENARIOS, getScenario } from '../../core/geo/testScenarios.ts';

/**
 * Relocate controls: Google Maps API key + place search.
 *
 * A single "GO SOMEWHERE REAL" button on every screen, opening on demand into
 * a popover with the key, search, and scenario fields. The fields do not live
 * on the HUD row even where they would fit — three of them across the middle
 * of the game is worse than a button on both a phone and a desktop. Errors
 * surface inline as status text, never alert().
 */
export class RelocateBar extends LitElement {
  static override styles = css`
    /* the document's universal box-sizing rule does not cross the shadow
       boundary, so without this the open panel's padding and border are added
       on top of its width and it hangs off the side of a phone */
    *, :host { box-sizing: border-box; }

    :host {
      position: fixed;
      top: max(var(--space-md), env(safe-area-inset-top));
      left: 50%;
      transform: translateX(-50%);
      z-index: 50;
      display: flex;
      /* stack the toggle over the popover it opens: the panel drops below the
         button instead of sitting beside it, so it never overlaps the score */
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--space-xs);
      max-width: calc(100vw - 52rem);
      width: max-content;
    }

    :host([hidden]) { display:none; }

    /* Featured on the garage/menu screen only: pulled to the middle of the
       viewport and scaled up so the call to action reads as the main event.
       Gameplay keeps the small top-centered toggle instead. */
    :host([featured]) {
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      max-width: calc(100vw - var(--space-xl) * 2);
    }
    :host([featured]) .toggle {
      min-height: 4.5rem;
      padding: var(--space-xl) var(--space-2xl);
      font-family: 'Russo One', sans-serif;
      font-size: clamp(20px, 2.4vw, 28px);
      letter-spacing: .06em;
      background: var(--accent);
      color: #0b0f17;
      border: var(--border) solid color-mix(in srgb, var(--accent) 70%, #000 30%);
      border-radius: var(--radius-lg);
      box-shadow: 0 8px 0 #c23800, 0 16px 32px rgba(255, 85, 0, .4);
      transition: transform .08s, box-shadow .2s;
    }
    :host([featured]) .toggle:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 0 #c23800, 0 20px 36px rgba(255, 85, 0, .5);
    }
    :host([featured]) .toggle:active {
      transform: translateY(4px);
      box-shadow: 0 3px 0 #c23800;
    }
    :host([featured][open]) .toggle {
      background: transparent;
      color: var(--accent);
      border-color: var(--accent);
    }
    :host([featured][open]) .fields { width: min(28rem, calc(100vw - var(--space-xl) * 2)); }
    /* On a narrow screen the garage roster fills the column, so a dead-center
       button would sit on top of the car list. Drop it below the roster and
       the showroom stage instead of overlapping them. */
    @media (max-width: 760px) {
      :host([featured]) {
        top: auto;
        bottom: max(var(--space-2xl), env(safe-area-inset-bottom));
        transform: translateX(-50%);
      }
    }

    /* One button on every screen: the fields open on demand below it. Three
       fields do not belong on the HUD row even where they would fit, and the
       collapsed form is the same on a phone and a desktop. */
    .fields { display: none; }
    .toggle { display: block; min-height: 2.25rem; padding: var(--space-xs) var(--space-md); }
    :host([open]) .fields {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: var(--space-xs);
      margin-top: var(--space-xs);
      padding: var(--space-md);
      width: min(24rem, calc(100vw - var(--space-lg) * 2));
      background: var(--scrim);
      border: var(--border) solid var(--line);
      border-radius: var(--radius-md);
    }
    :host([open]) .toggle { border-color: var(--accent); color: var(--accent); }

    /* No usable gap between the HUD corners: drop below them instead of
       covering the score. The collapsed form is already the default above;
       this only widens the bar and lowers it. */
    @media (max-width: 92rem) {
      :host {
        top: calc(max(var(--space-md), env(safe-area-inset-top)) + 7.2rem);
        max-width: calc(100vw - var(--space-lg) * 2);
      }
    }
    input { padding:var(--space-sm) var(--space-md); background:rgba(0,0,0,.6);
      border:var(--border) solid var(--line); border-radius:var(--radius-sm); color:var(--ink);
      font-family:inherit; font-size:16px; outline:none; min-width:0; }
    input:focus { border-color:var(--accent); }
    input::placeholder { color:var(--muted); }
    /* 16px keeps iOS from zooming the page when a field takes focus */
    #key { flex:1 1 13rem; min-width:7rem; }
    #q { flex:2 1 17rem; min-width:8rem; }
    button { padding:var(--space-sm) var(--space-lg); background:var(--panel2); color:var(--ink);
      border:var(--border) solid var(--line); border-radius:var(--radius-sm); font-family:inherit;
      font-weight:600; cursor:pointer; min-height:2.75rem; flex:0 0 auto; }
    button:hover { border-color:var(--accent); color:var(--accent); }
    #scenario {
      padding: var(--space-sm) var(--space-sm);
      background: rgba(14, 21, 32, 0.92);
      border: var(--border) solid var(--line);
      border-radius: var(--radius-sm);
      color: var(--ink);
      font-family: inherit;
      font-size: 13px;
      font-weight: 500;
      outline: none;
      cursor: pointer;
      flex: 0 0 auto;
      max-width: 15rem;
    }
    #scenario:focus, #scenario:hover { border-color: var(--accent); color: var(--accent); }
    #scenario option, #scenario optgroup {
      background: #0e1522;
      color: #f1f5f9;
    }
    .status { position:absolute; top:calc(100% + 6px); left:0; right:0; font-size:11px;
      color:var(--hot); text-align:center; pointer-events:none; }
  `;

  static override properties = {
    busy: { type: Boolean },
    status: { type: String },
    open: { type: Boolean, reflect: true },
    featured: { type: Boolean, reflect: true }
  };
  declare busy: boolean;
  declare status: string;
  /** Narrow screens only: whether the collapsed panel is showing. */
  declare open: boolean;
  /** Garage/menu screen only: enlarge and center the toggle as the main CTA. */
  declare featured: boolean;

  constructor() {
    super();
    this.busy = false;
    this.status = '';
    this.open = false;
    this.featured = false;
  }

  onSearch?: (query: string, key: string) => void;

  submit(): void {
    const qEl = this.renderRoot.querySelector('#q') as HTMLInputElement | null;
    const keyEl = this.renderRoot.querySelector('#key') as HTMLInputElement | null;
    const q = qEl?.value.trim() ?? '';
    const key = keyEl?.value.trim() || localStorage.getItem('gmap_key') || '';
    if (key.startsWith('4/')) {
      this.status = 'Key starts with "4/" — this is an OAuth authorization code, not a Google API Key (starts with AIzaSy).';
      return;
    }
    if (!key) {
      this.status = 'Paste a Google Maps API key first (starts with AIzaSy).';
      return;
    }
    if (q && this.onSearch) {
      this.onSearch(q, key);
      // collapse back to the button once the search is dispatched — the status
      // line sits below :host so it stays visible whether open or not
      this.open = false;
    }
  }

  selectScenario(id: string): void {
    if (!id) return;
    const s = getScenario(id);
    if (!s) return;
    const qInput = this.renderRoot.querySelector('#q') as HTMLInputElement | null;
    if (qInput) qInput.value = `${s.lat}, ${s.lon}`;
    this.status = `[Test GPS] ${s.name}: ${s.testFocus}`;
    const keyEl = this.renderRoot.querySelector('#key') as HTMLInputElement | null;
    const key = keyEl?.value.trim() || localStorage.getItem('gmap_key') || '';
    if (key) {
      this.submit();
    }
  }

  setQuery(query: string): void {
    const qInput = this.renderRoot.querySelector('#q') as HTMLInputElement | null;
    if (qInput) qInput.value = query;
  }

  override render() {
    // Group scenarios by category
    const categories = [
      { key: 'bridge_water', label: '🌉 Bridges & Water' },
      { key: 'dense_city', label: '🏙️ Dense 3D Cities' },
      { key: 'open_ground', label: '🏜️ Open Ground (2D Satellite)' },
      { key: 'steep_slope', label: '⛰️ Steep Slopes & Hills' },
      { key: 'coast_interface', label: '🌊 Shoreline & Interfaces' }
    ] as const;

    return html`
      <button class="toggle" aria-expanded=${this.open ? 'true' : 'false'}
        @click=${() => { this.open = !this.open; }}>${this.open ? 'CLOSE' : 'GO SOMEWHERE REAL'}</button>
      <div class="fields">
        <select id="scenario" @change=${(e: Event) => {
          this.selectScenario((e.target as HTMLSelectElement).value);
          (e.target as HTMLSelectElement).value = '';
        }}>
          <option value="">🎯 Test Scenarios (GPS Benchmarks)…</option>
          ${categories.map(cat => html`
            <optgroup label=${cat.label}>
              ${TEST_SCENARIOS.filter(s => s.category === cat.key).map(s => html`
                <option value=${s.id}>${s.name}</option>
              `)}
            </optgroup>
          `)}
        </select>
        <input id="key" type="password" placeholder="Google API key (optional)"
          @change=${(e: Event) => localStorage.setItem('gmap_key', (e.target as HTMLInputElement).value.trim())} />
        <input id="q" type="text" placeholder="Search any place or GPS lat, lon…"
          @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') this.submit(); }} />
        <button ?disabled=${this.busy} @click=${() => this.submit()}>RELOCATE</button>
      </div>
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
