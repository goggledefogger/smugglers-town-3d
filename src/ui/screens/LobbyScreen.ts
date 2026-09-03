import { html, css, LitElement } from 'lit';
import { VEHICLE_TYPES } from '../../core/physics/vehicleStats.ts';
import type { LobbyRoom, LobbyPlayer, Team } from '../../net/lobby.ts';

const TEAM_NAME: Record<Team, string> = { 0: 'Your Crew', 1: 'Rivals' };

/**
 * The lobby: create or join a room by code, then the roster and the local
 * vehicle/team/ready controls while everyone gets set. Styled to match the
 * garage (IntroScreen) so the two screens read as one app.
 */
export class LobbyScreen extends LitElement {
  static override styles = css`
    :host { position:fixed; inset:0; z-index:60; display:flex; align-items:center; justify-content:center;
      background:rgba(26,20,16,.97); overflow:auto; padding:32px 16px; }
    :host([hidden]) { display:none; }
    .panel { width:100%; max-width:420px; background:rgba(36,28,22,.9); border:2px solid var(--line);
      border-radius:14px; padding:26px 30px; }
    .panel.wide { max-width:760px; }
    h1 { font-family:'Russo One',sans-serif; font-size:clamp(24px,3.6vw,34px); margin:0 0 4px;
      text-shadow:0 3px 0 #0006; }
    .ac { color:var(--accent); }
    .sub { color:var(--muted); font-size:12px; margin:0 0 20px; line-height:1.4; }
    label { display:block; font-size:10px; letter-spacing:.14em; text-transform:uppercase;
      color:var(--muted); margin:14px 0 4px; }
    label:first-of-type { margin-top:0; }
    input { width:100%; box-sizing:border-box; padding:10px 12px; background:rgba(0,0,0,.4);
      border:2px solid var(--line); border-radius:8px; color:var(--ink); font-family:inherit;
      font-size:14px; outline:none; }
    input:focus { border-color:var(--accent); }
    input::placeholder { color:var(--muted); }
    #code { font-family:'JetBrains Mono',monospace; font-size:26px; letter-spacing:.3em;
      text-align:center; text-transform:uppercase; }
    .row { display:flex; gap:10px; margin-top:16px; }
    button { padding:11px 18px; background:var(--panel2); color:var(--ink); border:2px solid var(--line);
      border-radius:8px; font-family:inherit; font-weight:600; font-size:13px; cursor:pointer; flex:1; }
    button:hover:not(:disabled) { border-color:var(--accent); color:var(--accent); }
    button:disabled { opacity:.5; cursor:wait; }
    button.primary { background:var(--accent); color:#1a1410; border-color:var(--accent); font-family:'Russo One',sans-serif; }
    button.primary:hover:not(:disabled) { border-color:var(--accent); color:#1a1410; opacity:.92; }
    button.ready-on { border-color:var(--good); color:var(--good); }
    .back { display:block; width:100%; text-align:center; margin-top:16px; color:var(--muted); font-size:12px;
      background:none; border:none; cursor:pointer; text-decoration:underline; }
    .status { margin-top:14px; font-size:12px; color:var(--hot); text-align:center; }

    /* --- in-room --- */
    .code-big { font-family:'JetBrains Mono',monospace; font-size:clamp(36px,6vw,52px);
      letter-spacing:.28em; text-align:center; color:var(--accent); }
    .code-hint { text-align:center; color:var(--muted); font-size:11px; margin:2px 0 6px; }
    .map-line { text-align:center; color:var(--muted); font-size:12px; margin-bottom:18px; }
    .board { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
    .roster { display:grid; grid-template-columns:1fr 1fr; gap:10px; align-content:start; }
    .controls-col { display:flex; flex-direction:column; gap:6px; }
    .team-name { font-size:10px; letter-spacing:.14em; text-transform:uppercase; margin:0 0 8px; }
    .team-col.t0 .team-name { color:var(--accent); }
    .team-col.t1 .team-name { color:var(--cool); }
    .seat { display:flex; align-items:center; gap:6px; padding:8px 9px; margin-bottom:6px;
      background:rgba(0,0,0,.25); border:1px solid var(--line); border-radius:8px; font-size:11.5px; min-height:16px; }
    .seat.empty { color:var(--muted); font-style:italic; }
    .swatch { width:9px; height:9px; border-radius:3px; flex:none; }
    .seat .who { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .badge { font-size:9px; letter-spacing:.06em; padding:1px 5px; border-radius:4px; flex:none; font-weight:700; }
    .badge.host { background:var(--accent); color:#1a1410; }
    .badge.ready { background:var(--good); color:#1a1410; }
    .picker { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:6px; }
    .vcard { display:flex; align-items:center; gap:6px; padding:6px 9px; background:rgba(0,0,0,.25);
      border:2px solid var(--line); border-radius:7px; cursor:pointer; font-size:11px; flex:1 1 auto; min-width:96px; outline:none; }
    .vcard:hover { border-color:var(--sand); }
    .vcard.sel { border-color:var(--accent); background:rgba(64,42,28,.95); }
    .vcard .name { flex:1; }
    .vcard .key { font-family:'JetBrains Mono',monospace; color:var(--muted); font-size:10px; }
    .hint { color:var(--muted); font-size:11px; text-align:center; margin:2px 0; }
    .start { padding:14px; font-size:16px; }
    @media (max-width: 640px) {
      .board { grid-template-columns:1fr; }
      .panel.wide { max-width:420px; }
    }
  `;

  static override properties = {
    room: { type: Object },
    selfId: { type: String },
    status: { type: String },
    busy: { type: Boolean },
    defaultName: { type: String },
    vehicle: { type: Number },
    canStart: { type: Boolean }
  };
  declare room: LobbyRoom | null;
  declare selfId: string;
  declare status: string;
  declare busy: boolean;
  declare defaultName: string;
  declare vehicle: number;
  declare canStart: boolean;

  constructor() {
    super();
    this.room = null;
    this.selfId = '';
    this.status = '';
    this.busy = false;
    this.defaultName = '';
    this.vehicle = 2;
    this.canStart = false;
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName ?? '')) return;
    if (!e.code.startsWith('Digit')) return;
    const n = Number(e.code.slice(5));
    if (n < 1 || n > VEHICLE_TYPES.length) return;
    this.pickVehicle(n - 1);
    e.preventDefault();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.onKey);
  }

  override disconnectedCallback(): void {
    window.removeEventListener('keydown', this.onKey);
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

  private createRoom(): void {
    const name = (this.renderRoot.querySelector('#name') as HTMLInputElement).value.trim();
    if (!name) return;
    this.fireDetail('lobby-create', { name });
  }

  private joinRoom(): void {
    const name = (this.renderRoot.querySelector('#name') as HTMLInputElement).value.trim();
    const code = (this.renderRoot.querySelector('#code') as HTMLInputElement).value.trim();
    if (!name || code.length !== 4) return;
    this.fireDetail('lobby-join', { code, name });
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

  private renderEntry() {
    return html`
      <div class="panel">
        <h1>JOIN A <span class="ac">CREW</span></h1>
        <p class="sub">Play a 4v4 round with friends over the internet. Bots fill the empty seats.</p>
        <label for="name">Your name</label>
        <input id="name" type="text" placeholder="Name" maxlength="20" .value=${this.defaultName} />
        <div class="row">
          <button class="primary" ?disabled=${this.busy} @click=${() => this.createRoom()}>CREATE ROOM</button>
        </div>
        <label for="code">Room code</label>
        <input id="code" type="text" maxlength="4" placeholder="CODE"
          @input=${(e: Event) => { const el = e.target as HTMLInputElement; el.value = el.value.toUpperCase(); }}
          @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') this.joinRoom(); }} />
        <div class="row">
          <button ?disabled=${this.busy} @click=${() => this.joinRoom()}>JOIN</button>
        </div>
        <button class="back" @click=${() => this.fire('lobby-back')}>Back</button>
        ${this.status ? html`<div class="status">${this.status}</div>` : ''}
      </div>
    `;
  }

  private renderRoom(room: LobbyRoom) {
    const isHost = room.host === this.selfId;
    const mapLine = room.map.kind === 'city' ? room.map.query : 'Procedural desert';
    return html`
      <div class="panel wide">
        <div class="code-big">${room.code}</div>
        <div class="code-hint">share this code</div>
        <div class="map-line">${mapLine}</div>
        <div class="board">
          <div class="roster">
            ${this.renderTeam(room, 0)}
            ${this.renderTeam(room, 1)}
          </div>
          <div class="controls-col">
            <label>Your vehicle</label>
            ${this.renderPicker()}
            <div class="row">
              <button class="${this.self?.ready ? 'ready-on' : ''}" ?disabled=${this.busy} @click=${() => this.toggleReady()}>
                ${this.self?.ready ? 'CANCEL READY' : 'READY UP'}
              </button>
              <button ?disabled=${this.busy} @click=${() => this.switchTeam()}>SWITCH TEAM</button>
            </div>
            ${isHost
              ? html`
                  <button class="primary start" ?disabled=${this.busy || !this.canStart} @click=${() => this.fire('lobby-start')}>START MATCH</button>
                  ${!this.canStart ? html`<div class="hint">waiting for everyone to ready up</div>` : ''}
                `
              : html`<div class="hint">waiting for host to start</div>`}
            <button ?disabled=${this.busy} @click=${() => this.fire('lobby-leave')}>LEAVE</button>
          </div>
        </div>
        ${this.status ? html`<div class="status">${this.status}</div>` : ''}
      </div>
    `;
  }

  override render() {
    return this.room ? this.renderRoom(this.room) : this.renderEntry();
  }
}
customElements.define('sr-lobby', LobbyScreen);
