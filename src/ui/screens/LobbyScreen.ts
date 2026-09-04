import { html, css, LitElement, type TemplateResult } from 'lit';
import { VEHICLE_TYPES } from '../../core/physics/vehicleStats.ts';
import type { LobbyRoom, LobbyPlayer, Team } from '../../net/lobby.ts';
import { MAX_PLACE_LEN, type MatchMap } from '../../net/protocol.ts';
import type { UiAction } from '../../input/types.ts';

const TEAM_NAME: Record<Team, string> = { 0: 'Your Crew', 1: 'Rivals' };

/** Somewhere to start from, so the search box is never a blank stare. */
const PRESETS = ['Portland, OR', 'San Francisco', 'Manhattan, NY', 'Tokyo', 'Dubai'] as const;

export type CityMap = Extract<MatchMap, { kind: 'city' }>;

/**
 * The lobby: pick where you are playing and create a room, or join one by
 * code, then the roster and the local vehicle/team/ready controls.
 *
 * Choosing a place costs one geocode and one thumbnail, never the world — the
 * flow only streams elevation, imagery and building tiles once the match
 * actually starts, so browsing three cities before settling is nearly free.
 * The component itself does no network work: it fires intents and renders
 * whatever the flow puts back on it.
 *
 * Styled from the shared token scale in index.html so it reads as one app with
 * the garage.
 */
export class LobbyScreen extends LitElement {
  static override styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--scrim);
      overflow: auto;
      padding: var(--space-2xl) var(--space-lg);
    }
    :host([hidden]) { display: none; }

    .panel {
      width: 100%;
      max-width: 30rem;
      background: color-mix(in srgb, var(--panel) 90%, transparent);
      border: var(--border) solid var(--line);
      border-radius: var(--radius-lg);
      padding: var(--space-xl) var(--space-xl);
    }
    .panel.wide { max-width: 54rem; }

    h1 {
      font-family: 'Russo One', sans-serif;
      font-size: clamp(1.5rem, 3.6vw, 2.1rem);
      margin: 0 0 var(--space-2xs);
      text-shadow: 0 3px 0 rgb(0 0 0 / .4);
    }
    .ac { color: var(--accent); }
    .sub {
      color: var(--muted);
      font-size: var(--text-md);
      margin: 0 0 var(--space-xl);
      line-height: 1.4;
    }

    label, .legend {
      display: block;
      font-size: var(--text-xs);
      letter-spacing: var(--tracking-wide);
      text-transform: uppercase;
      color: var(--muted);
      margin: var(--space-lg) 0 var(--space-2xs);
    }
    label:first-of-type { margin-top: 0; }

    input[type=text], input[type=password] {
      width: 100%;
      box-sizing: border-box;
      padding: var(--space-sm) var(--space-md);
      background: var(--field-bg);
      border: var(--border) solid var(--line);
      border-radius: var(--radius-md);
      color: var(--ink);
      font-family: inherit;
      font-size: var(--text-md);
      outline: none;
    }
    input:focus { border-color: var(--accent); }
    input::placeholder { color: var(--muted); }
    #code {
      font-family: 'JetBrains Mono', monospace;
      font-size: 1.6rem;
      letter-spacing: .3em;
      text-align: center;
      text-transform: uppercase;
    }

    .row { display: flex; gap: var(--space-sm); margin-top: var(--space-lg); }
    .row.tight { margin-top: var(--space-sm); }

    button {
      padding: var(--space-md) var(--space-lg);
      background: var(--panel2);
      color: var(--ink);
      border: var(--border) solid var(--line);
      border-radius: var(--radius-md);
      font-family: inherit;
      font-weight: 600;
      font-size: var(--text-md);
      cursor: pointer;
      flex: 1;
    }
    button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
    button:disabled { opacity: .5; cursor: not-allowed; }
    /* gamepad focus ring, moved by the InputManager */
    button[data-focused], .vcard[data-focused], .map-card[data-focused] {
      border-color: var(--accent) !important;
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 40%, transparent);
    }
    button.primary {
      background: var(--accent);
      color: var(--bg);
      border-color: var(--accent);
      font-family: 'Russo One', sans-serif;
    }
    button.primary:hover:not(:disabled) { color: var(--bg); opacity: .92; }
    button.ready-on { border-color: var(--good); color: var(--good); }
    button.slim { flex: 0 0 auto; }

    .back {
      display: block;
      width: 100%;
      text-align: center;
      margin-top: var(--space-lg);
      color: var(--muted);
      font-size: var(--text-md);
      background: none;
      border: none;
      cursor: pointer;
      text-decoration: underline;
    }
    .status {
      margin-top: var(--space-md);
      font-size: var(--text-md);
      color: var(--hot);
      text-align: center;
    }
    .link {
      display: block;
      margin: var(--space-sm) auto 0;
      background: none;
      border: none;
      color: var(--muted);
      font-size: var(--text-sm);
      text-decoration: underline;
      cursor: pointer;
    }

    /* --- where you're playing --- */
    .maps { display: flex; gap: var(--space-sm); }
    .map-card {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      padding: var(--space-md);
      background: var(--inset-bg);
      border: var(--border) solid var(--line);
      border-radius: var(--radius-md);
      cursor: pointer;
      outline: none;
    }
    .map-card:hover, .map-card:focus-visible { border-color: var(--sand); }
    .map-card[aria-pressed=true] {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 16%, var(--inset-bg));
    }
    .map-card .name { font-size: var(--text-md); font-weight: 600; }
    .map-card .note { font-size: var(--text-sm); color: var(--muted); line-height: 1.35; }

    .city-setup {
      margin-top: var(--space-md);
      padding: var(--space-md);
      border: var(--border) solid var(--line);
      border-radius: var(--radius-md);
      background: var(--inset-bg);
    }
    .city-setup label:first-of-type { margin-top: 0; }
    .presets { display: flex; flex-wrap: wrap; gap: var(--space-2xs); margin-top: var(--space-sm); }
    .chip {
      padding: var(--space-2xs) var(--space-sm);
      background: var(--field-bg);
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      color: var(--muted);
      font-family: inherit;
      font-size: var(--text-sm);
      cursor: pointer;
      flex: 0 0 auto;
    }
    .chip:hover { border-color: var(--accent); color: var(--accent); }

    /* the confirmed place: the whole point of checking before you commit */
    .found {
      display: flex;
      gap: var(--space-md);
      align-items: center;
      margin-top: var(--space-md);
      padding: var(--space-sm);
      border: var(--border) solid var(--good);
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--good) 12%, transparent);
    }
    .found img {
      width: 8rem;
      height: 3.4rem;
      object-fit: cover;
      border-radius: var(--radius-sm);
      flex: none;
      background: var(--field-bg);
    }
    .found .where { min-width: 0; }
    .found .place {
      font-size: var(--text-md);
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .found .coords {
      font-family: 'JetBrains Mono', monospace;
      font-size: var(--text-sm);
      color: var(--muted);
    }

    .check-row { display: flex; gap: var(--space-sm); margin-top: var(--space-2xs); }
    .check-row input { flex: 1; }
    .check-row button { flex: 0 0 auto; padding: var(--space-sm) var(--space-md); }

    .switch {
      display: flex;
      gap: var(--space-sm);
      align-items: flex-start;
      margin-top: var(--space-md);
      cursor: pointer;
      font-size: var(--text-md);
    }
    .switch input { margin: 0; accent-color: var(--accent); flex: none; }
    .switch .note { display: block; color: var(--muted); font-size: var(--text-sm); line-height: 1.35; }

    .note-line { color: var(--muted); font-size: var(--text-sm); line-height: 1.4; margin-top: var(--space-sm); }

    /* --- in-room --- */
    .code-big {
      font-family: 'JetBrains Mono', monospace;
      font-size: clamp(2.2rem, 6vw, 3.2rem);
      letter-spacing: .28em;
      text-align: center;
      color: var(--accent);
    }
    .code-hint {
      text-align: center;
      color: var(--muted);
      font-size: var(--text-sm);
      margin: var(--space-2xs) 0 var(--space-xs);
    }
    .map-line {
      display: flex;
      gap: var(--space-sm);
      align-items: center;
      justify-content: center;
      color: var(--muted);
      font-size: var(--text-md);
      margin-bottom: var(--space-lg);
    }
    .map-line .pin { color: var(--accent); }
    .board { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-xl); }
    .roster { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-md); align-content: start; }
    .controls-col { display: flex; flex-direction: column; gap: var(--space-xs); }
    .team-name {
      font-size: var(--text-xs);
      letter-spacing: var(--tracking-wide);
      text-transform: uppercase;
      margin: 0 0 var(--space-sm);
    }
    .team-col.t0 .team-name { color: var(--accent); }
    .team-col.t1 .team-name { color: var(--cool); }
    .seat {
      display: flex;
      align-items: center;
      gap: var(--space-xs);
      padding: var(--space-sm) var(--space-xs);
      margin-bottom: var(--space-xs);
      background: var(--inset-bg);
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      font-size: var(--text-sm);
    }
    .seat.empty { color: var(--muted); font-style: italic; }
    .swatch { width: .6rem; height: .6rem; border-radius: var(--radius-sm); flex: none; }
    .seat .who { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge {
      font-size: var(--text-2xs);
      letter-spacing: .06em;
      padding: 1px var(--space-2xs);
      border-radius: var(--radius-sm);
      flex: none;
      font-weight: 700;
      color: var(--bg);
    }
    .badge.host { background: var(--accent); }
    .badge.ready { background: var(--good); }
    .picker { display: flex; flex-wrap: wrap; gap: var(--space-xs); margin-bottom: var(--space-xs); }
    .vcard {
      display: flex;
      align-items: center;
      gap: var(--space-xs);
      padding: var(--space-xs) var(--space-sm);
      background: var(--inset-bg);
      border: var(--border) solid var(--line);
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: var(--text-sm);
      flex: 1 1 auto;
      min-width: 6rem;
      outline: none;
    }
    .vcard:hover { border-color: var(--sand); }
    .vcard.sel { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 16%, var(--inset-bg)); }
    .vcard .name { flex: 1; }
    .vcard .key { font-family: 'JetBrains Mono', monospace; color: var(--muted); font-size: var(--text-xs); }
    .hint { color: var(--muted); font-size: var(--text-sm); text-align: center; margin: var(--space-2xs) 0; }

    /* a joiner in a city room with no key: the one thing blocking ready-up */
    .key-gate {
      margin-bottom: var(--space-sm);
      padding: var(--space-md);
      border: var(--border) solid var(--hot);
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--hot) 12%, transparent);
    }
    .key-gate .legend { margin-top: 0; color: var(--ink); }

    .start { padding: var(--space-lg); font-size: var(--text-lg); }

    @media (max-width: 40rem) {
      .board { grid-template-columns: 1fr; }
      .panel.wide { max-width: 30rem; }
      .maps { flex-direction: column; }
    }
  `;

  static override properties = {
    room: { type: Object },
    selfId: { type: String },
    status: { type: String },
    busy: { type: Boolean },
    defaultName: { type: String },
    vehicle: { type: Number },
    canStart: { type: Boolean },
    mapKind: { type: String },
    place: { type: Object },
    thumbnailUrl: { type: String },
    mapStatus: { type: String },
    checking: { type: Boolean },
    shareKey: { type: Boolean },
    hasKey: { type: Boolean },
    defaultKey: { type: String }
  };
  declare room: LobbyRoom | null;
  declare selfId: string;
  declare status: string;
  declare busy: boolean;
  declare defaultName: string;
  declare vehicle: number;
  declare canStart: boolean;
  /** Which map the host is setting up. Ignored for a joiner. */
  declare mapKind: 'desert' | 'city';
  /** The checked place, or null while nothing is confirmed. */
  declare place: CityMap | null;
  declare thumbnailUrl: string;
  declare mapStatus: string;
  declare checking: boolean;
  declare shareKey: boolean;
  /** The flow is holding a usable Maps key for this browser. */
  declare hasKey: boolean;
  declare defaultKey: string;

  constructor() {
    super();
    this.room = null;
    this.selfId = '';
    this.status = '';
    this.busy = false;
    this.defaultName = '';
    this.vehicle = 2;
    this.canStart = false;
    this.mapKind = 'desert';
    this.place = null;
    this.thumbnailUrl = '';
    this.mapStatus = '';
    this.checking = false;
    this.shareKey = true;
    this.hasKey = false;
    this.defaultKey = '';
  }

  /** Focus index across [data-focusable] in DOM order. */
  private focusIdx = 0;

  /** Handle a UI action from the InputManager. Returns true if consumed. */
  handleUiAction(action: UiAction): boolean {
    if (action === 'confirm') { this.activateFocus(); return true; }
    if (action === 'back') { this.fire('lobby-back'); return true; }
    if (action === 'up' || action === 'left' || action === 'down' || action === 'right') {
      const els = [...this.renderRoot.querySelectorAll('[data-focusable]')] as HTMLElement[];
      if (els.length === 0) return false;
      const dir = (action === 'up' || action === 'left') ? -1 : 1;
      this.focusIdx = ((this.focusIdx + dir) % els.length + els.length) % els.length;
      els.forEach((el, i) => { if (i === this.focusIdx) el.setAttribute('data-focused', ''); else el.removeAttribute('data-focused'); });
      return true;
    }
    return false;
  }

  /** Activate the focused element, or the first primary action if none focused. */
  private activateFocus(): void {
    const els = [...this.renderRoot.querySelectorAll('[data-focusable]')] as HTMLElement[];
    if (els.length === 0) return;
    const el = els[this.focusIdx] ?? els[0]!;
    if (el instanceof HTMLButtonElement) el.click();
    else (el as HTMLElement & { click?: () => void }).click?.();
  }

  override connectedCallback(): void {
    super.connectedCallback();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
  }

  private fire(name: string): void {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
  }

  private fireDetail<T>(name: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true, composed: true }));
  }

  private get self(): LobbyPlayer | null {
    if (!this.room) return null;
    return this.room.players[this.selfId] ?? null;
  }

  private field(sel: string): string {
    return (this.renderRoot.querySelector(sel) as HTMLInputElement | null)?.value.trim() ?? '';
  }

  private pickVehicle(idx: number): void {
    this.vehicle = idx;
    this.fireDetail('lobby-vehicle', { vehicle: idx });
  }

  private toggleReady(): void {
    this.fireDetail('lobby-ready', { ready: !(this.self?.ready ?? false) });
  }

  private switchTeam(): void {
    const next: Team = this.self?.team === 0 ? 1 : 0;
    this.fireDetail('lobby-team', { team: next });
  }

  private setMapKind(kind: 'desert' | 'city'): void {
    this.mapKind = kind;
    this.mapStatus = '';
  }

  /** Resolve the place and prove the key, without loading a thing. */
  private check(): void {
    const query = this.field('#place');
    const key = this.field('#gkey');
    if (!query) { this.mapStatus = 'Type a place, or pick one below'; return; }
    if (!key) { this.mapStatus = 'Paste a Google Maps API key first'; return; }
    this.mapStatus = '';
    this.fireDetail('lobby-check', { query, key });
  }

  private usePreset(name: string): void {
    const el = this.renderRoot.querySelector('#place') as HTMLInputElement | null;
    if (el) el.value = name;
    this.check();
  }

  // a click must always answer: a silent early return here read as "nothing
  // happens" for a player with no saved name
  private createRoom(): void {
    if (this.mapKind === 'city' && !this.place) {
      this.status = 'Check a location first, so everyone lands in the same place';
      return;
    }
    this.status = '';
    this.fireDetail('lobby-create', {
      name: this.field('#name'),
      map: this.mapKind === 'city' && this.place ? this.place : { kind: 'desert' as const },
      shareKey: this.mapKind === 'city' && this.shareKey
    });
  }

  private joinRoom(): void {
    const code = this.field('#code').toUpperCase();
    if (code.length !== 4) {
      this.status = 'Enter the 4-letter room code';
      return;
    }
    this.fireDetail('lobby-join', { code, name: this.field('#name') });
  }

  private submitGuestKey(): void {
    const key = this.field('#guestkey');
    if (!key) { this.status = 'Paste a Google Maps API key'; return; }
    this.status = '';
    this.fireDetail('lobby-key', { key });
  }

  private seats(room: LobbyRoom, team: Team): (readonly [string, LobbyPlayer])[] {
    return Object.entries(room.players)
      .filter(([, p]) => p.team === team)
      .sort((a, b) => a[1].joinedAt - b[1].joinedAt);
  }

  private renderSeat(room: LobbyRoom, uid: string, p: LobbyPlayer) {
    const v = VEHICLE_TYPES[p.vehicle] ?? VEHICLE_TYPES[0]!;
    const hex = '#' + v.color.toString(16).padStart(6, '0');
    return html`
      <div class="seat">
        <span class="swatch" style="background:${hex}"></span>
        <span class="who">${p.name}${uid === this.selfId ? ' (you)' : ''} · ${v.name}</span>
        ${uid === room.host ? html`<span class="badge host">HOST</span>` : ''}
        ${p.ready ? html`<span class="badge ready">READY</span>` : ''}
      </div>
    `;
  }

  private renderTeam(room: LobbyRoom, team: Team) {
    const seats = this.seats(room, team);
    const rows = [0, 1, 2, 3].map(i => {
      const seat = seats[i];
      return seat ? this.renderSeat(room, seat[0], seat[1]) : html`<div class="seat empty">bot</div>`;
    });
    return html`
      <div class="team-col t${team}">
        <div class="team-name">${TEAM_NAME[team]}</div>
        ${rows}
      </div>
    `;
  }

  private renderPicker() {
    return html`
      <div class="picker">
        ${VEHICLE_TYPES.map((v, i) => html`
          <div class="vcard ${i === this.vehicle ? 'sel' : ''}" role="button" tabindex="0"
            @click=${() => this.pickVehicle(i)}>
            <span class="swatch" style="background:${'#' + v.color.toString(16).padStart(6, '0')}"></span>
            <span class="name">${v.name}</span>
            <span class="key">${i + 1}</span>
          </div>
        `)}
      </div>
    `;
  }

  private renderMapCard(kind: 'desert' | 'city', name: string, note: string) {
    return html`
      <div class="map-card" role="button" tabindex="0" aria-pressed=${this.mapKind === kind}
        @click=${() => this.setMapKind(kind)}
        @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.setMapKind(kind); } }}>
        <span class="name">${name}</span>
        <span class="note">${note}</span>
      </div>
    `;
  }

  private renderCitySetup() {
    return html`
      <div class="city-setup">
        <label for="gkey">Your Google Maps API key</label>
        <input id="gkey" type="password" placeholder="AIza…" .value=${this.defaultKey}
          @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') this.check(); }} />
        <label for="place">Where</label>
        <div class="check-row">
          <input id="place" type="text" placeholder="Any place on Earth…" maxlength=${MAX_PLACE_LEN}
            @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') this.check(); }} />
          <button class="slim" ?disabled=${this.checking} @click=${() => this.check()}>
            ${this.checking ? 'CHECKING…' : 'CHECK'}
          </button>
        </div>
        <div class="presets">
          ${PRESETS.map(name => html`
            <button class="chip" ?disabled=${this.checking} @click=${() => this.usePreset(name)}>${name}</button>
          `)}
        </div>
        ${this.place ? html`
          <div class="found">
            ${this.thumbnailUrl ? html`<img src=${this.thumbnailUrl} alt="" />` : ''}
            <div class="where">
              <div class="place">${this.place.label}</div>
              <div class="coords">${this.place.lat.toFixed(4)}, ${this.place.lon.toFixed(4)}</div>
            </div>
          </div>
          <label class="switch">
            <input type="checkbox" .checked=${this.shareKey}
              @change=${(e: Event) => { this.shareKey = (e.target as HTMLInputElement).checked; }} />
            <span>
              Share my key with this room
              <span class="note">${this.shareKey
                ? 'Friends join with just the code. Anyone in the room can spend your Maps quota.'
                : 'Every player will need a Maps key of their own to load this city.'}</span>
            </span>
          </label>
        ` : ''}
        ${this.mapStatus ? html`<div class="status">${this.mapStatus}</div>` : ''}
        <div class="note-line">
          Checking costs one lookup. The city itself only loads when the match starts.
        </div>
      </div>
    `;
  }

  private renderEntry() {
    return html`
      <div class="panel">
        <h1>JOIN A <span class="ac">CREW</span></h1>
        <p class="sub">Play a 4v4 round with friends over the internet. Bots fill the empty seats.</p>
        <label for="name">Your name</label>
        <input id="name" type="text" placeholder="Name" maxlength="20" .value=${this.defaultName} />

        <span class="legend">Where you're playing</span>
        <div class="maps">
          ${this.renderMapCard('desert', 'Desert', 'Procedural dunes. Starts instantly, no key needed.')}
          ${this.renderMapCard('city', 'Anywhere on Earth', 'Real terrain and buildings. Needs a Google Maps key.')}
        </div>
        ${this.mapKind === 'city' ? this.renderCitySetup() : ''}

        <div class="row">
          <button class="primary" data-focusable ?disabled=${this.busy} @click=${() => this.createRoom()}>CREATE ROOM</button>
        </div>

        <label for="code">Room code</label>
        <input id="code" type="text" maxlength="4" placeholder="CODE"
          @input=${(e: Event) => { const el = e.target as HTMLInputElement; el.value = el.value.toUpperCase(); }}
          @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') this.joinRoom(); }} />
        <div class="row">
          <button data-focusable ?disabled=${this.busy} @click=${() => this.joinRoom()}>JOIN</button>
        </div>
        <button class="back" data-focusable @click=${() => this.fire('lobby-back')}>Back</button>
        ${this.status ? html`<div class="status">${this.status}</div>` : ''}
        <button class="link" @click=${() => this.fire('lobby-logs')}>copy debug log</button>
      </div>
    `;
  }

  /** A joiner in a city room whose browser has no key and no host offer. */
  private renderKeyGate() {
    return html`
      <div class="key-gate">
        <span class="legend">This crew is playing in a real city</span>
        <div class="note-line">
          The host is not sharing their Maps key, so you need one of your own to
          load the buildings and terrain.
        </div>
        <div class="check-row">
          <input id="guestkey" type="password" placeholder="AIza…" .value=${this.defaultKey}
            @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') this.submitGuestKey(); }} />
          <button class="slim" @click=${() => this.submitGuestKey()}>USE KEY</button>
        </div>
      </div>
    `;
  }

  private renderRoom(room: LobbyRoom) {
    const isHost = room.host === this.selfId;
    const city = room.map.kind === 'city' ? room.map : null;
    // a joiner can only ready up once it can actually build the world it will
    // be dropped into: its own key, or the host's offer to share one
    const blocked = !isHost && city !== null && !room.keyShared && !this.hasKey;
    return html`
      <div class="panel wide">
        <div class="code-big">${room.code}</div>
        <div class="code-hint">share this code</div>
        <div class="map-line">
          <span class="pin">${city ? '◉' : '◇'}</span>
          <span>${city ? city.label : 'Procedural desert'}</span>
          ${city && room.keyShared && !isHost ? html`<span>· host is sharing their map key</span>` : ''}
        </div>
        <div class="board">
          <div class="roster">
            ${this.renderTeam(room, 0)}
            ${this.renderTeam(room, 1)}
          </div>
          <div class="controls-col">
            ${blocked ? this.renderKeyGate() : ''}
            <label>Your vehicle</label>
            ${this.renderPicker()}
            <div class="row tight">
              <button class="${this.self?.ready ? 'ready-on' : ''}" data-focusable ?disabled=${this.busy || blocked}
                @click=${() => this.toggleReady()}>
                ${this.self?.ready ? 'CANCEL READY' : 'READY UP'}
              </button>
              <button data-focusable ?disabled=${this.busy} @click=${() => this.switchTeam()}>SWITCH TEAM</button>
            </div>
            ${isHost
              ? html`
                  <button class="primary start" data-focusable ?disabled=${this.busy || !this.canStart} @click=${() => this.fire('lobby-start')}>START MATCH</button>
                  ${!this.canStart ? html`<div class="hint">waiting for everyone to ready up</div>` : ''}
                  ${city ? html`<div class="hint">${city.label} loads for everyone when you start</div>` : ''}
                `
              : html`<div class="hint">waiting for host to start</div>`}
            <button data-focusable ?disabled=${this.busy} @click=${() => this.fire('lobby-leave')}>LEAVE</button>
          </div>
        </div>
        ${this.status ? html`<div class="status">${this.status}</div>` : ''}
        <button class="link" @click=${() => this.fire('lobby-logs')}>copy debug log</button>
      </div>
    `;
  }

  override render(): TemplateResult {
    return this.room ? this.renderRoom(this.room) : this.renderEntry();
  }
}
customElements.define('sr-lobby', LobbyScreen);
