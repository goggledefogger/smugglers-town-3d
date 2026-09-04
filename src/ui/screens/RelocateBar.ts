import { html, css, LitElement } from 'lit';

/**
 * Relocate controls: Google Maps API key + place search.
 *
 * Two shapes, because the HUD's top row is the contested space. Given room it
 * is an inline row sitting in the gap between the integrity and score panels.
 * Where there is no such gap it collapses to a single button and opens on
 * demand — three fields cannot fit a phone's width on one line, and wrapping
 * them makes a permanent three-row block across the middle of the game, which
 * is worse than a button. Errors surface inline as status text, never alert().
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
      /* nowrap on the inline row: width:max-content on a *wrapping* flex
         container resolves narrower than the row it contains, so the fields
         wrapped even with a thousand pixels of gap to sit in. The collapsed
         panel does its own wrapping below. */
      flex-wrap: nowrap;
      justify-content: center;
      gap: var(--space-xs);
      /* the gap between the HUD's top corners: integrity takes ~19rem on the
         left and the score ~30rem on the right, so what is left in the middle
         is the room this bar actually has. Wide screens have plenty and it sits
         up on that row; it only drops below when the gap gets too narrow to
         hold it on one line, since wrapping makes it tall enough to reach the
         nav marker */
      max-width: calc(100vw - 52rem);
      width: max-content;
    }
    /* too narrow to sit beside the HUD's top corners: drop below them instead
       of covering the score, and take the full width while down there */

    :host([hidden]) { display:none; }

    .fields { display: contents; }
    .toggle { display: none; }

    /* No usable gap: collapse to a button that opens the fields on demand.
       The threshold is the corners (~52rem) plus what one row of fields needs
       (~38rem) — widen a field below and this number has to move with it. */
    @media (max-width: 92rem) {
      :host {
        /* below the corners, because on a phone there is no gap between them
           to sit in — but only a button lives here until you ask for more */
        top: calc(max(var(--space-md), env(safe-area-inset-top)) + 3.5rem);
        max-width: calc(100vw - var(--space-lg) * 2);
        flex-direction: column;
        align-items: center;
      }
      .toggle { display: block; min-height: 2.25rem; padding: var(--space-xs) var(--space-md); }
      .fields { display: none; }
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
    button:disabled { opacity:.5; cursor:wait; }
    .status { position:absolute; top:calc(100% + 6px); left:0; right:0; font-size:11px;
      color:var(--hot); text-align:center; pointer-events:none; }
  `;

  static override properties = {
    busy: { type: Boolean },
    status: { type: String },
    open: { type: Boolean, reflect: true }
  };
  declare busy: boolean;
  declare status: string;
  /** Narrow screens only: whether the collapsed panel is showing. */
  declare open: boolean;

  constructor() {
    super();
    this.busy = false;
    this.status = '';
    this.open = false;
  }

  onSearch?: (query: string, key: string) => void;

  private submit(): void {
    const q = (this.renderRoot.querySelector('#q') as HTMLInputElement).value.trim();
    const key = (this.renderRoot.querySelector('#key') as HTMLInputElement).value.trim();
    if (q && this.onSearch) this.onSearch(q, key);
  }

  override render() {
    return html`
      <button class="toggle" aria-expanded=${this.open ? 'true' : 'false'}
        @click=${() => { this.open = !this.open; }}>${this.open ? 'CLOSE' : 'GO SOMEWHERE REAL'}</button>
      <div class="fields">
        <input id="key" type="password" placeholder="Google API key (optional)"
          @change=${(e: Event) => localStorage.setItem('gmap_key', (e.target as HTMLInputElement).value.trim())} />
        <input id="q" type="text" placeholder="Search any place on Earth…"
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
