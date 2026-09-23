import { html, css, LitElement } from 'lit';
import { VEHICLE_TYPES, type VehicleStats } from '../../core/physics/vehicleStats.ts';
import { getGamepadDisplayName } from '../../input/gamepadNormalization.ts';
import type { InputManager } from '../../input/InputManager.ts';

/**
 * The garage: title, the roster to pick from, stats for the pick, and the
 * way into the game. The right half is see-through so the Showroom's 3D
 * preview of the selected vehicle shows behind it. Arrow keys
 * select, Enter (or the button) starts. A gamepad navigates the same way:
 * dpad/stick moves the focus ring, A starts, B opens online.
 */
const STAT_ROWS: readonly (readonly [keyof VehicleStats & string, string])[] = [
  ['accel', 'Acceleration'],
  ['maxSpeed', 'Top speed'],
  ['steer', 'Handling'],
  ['grip', 'Grip'],
  ['durability', 'Armor'],
  ['mass', 'Mass']
];

const STAT_MAX: Record<string, number> = {};
for (const [key] of STAT_ROWS) {
  STAT_MAX[key] = Math.max(...VEHICLE_TYPES.map(v => v[key] as number));
}

export class IntroScreen extends LitElement {
  static override styles = css`
    /* the document's universal box-sizing rule does not cross the shadow
       boundary; .stats sets an explicit width and padding and needs it */
    *, :host { box-sizing: border-box; }

    :host { position:fixed; inset:0; z-index:40; display:grid;
      grid-template-columns:minmax(300px, 430px) 1fr; grid-template-rows:auto 1fr auto;
      background:linear-gradient(90deg, rgba(11,15,23,.97) 0%, rgba(11,15,23,.95) 34%,
        rgba(11,15,23,.22) 55%, rgba(11,15,23,.35) 100%); }
    header { grid-column:1 / -1; padding:20px 28px 6px; }
    h1 { font-family:'Russo One',sans-serif; font-size:clamp(28px,4.5vw,46px); line-height:1;
      margin:0; text-shadow:0 4px 0 #0008; }
    .ac { color:var(--accent); }
    .sub { color:var(--muted); margin:8px 0 0; font-size:13px; max-width:640px; line-height:1.45; }
    .list { padding:8px 28px; display:flex; flex-direction:column; gap:8px; overflow:auto; }
    .label { font-size:10px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted); margin:6px 0 2px; }
    .card { display:flex; align-items:center; gap:12px; padding:11px 14px; background:rgba(17,26,38,.85);
      border:2px solid var(--line); border-radius:10px; cursor:pointer; outline:none; backdrop-filter:blur(6px);
      transition:border-color .15s, transform .15s, box-shadow .15s; }
    .card:hover { border-color:var(--sand); box-shadow:0 0 12px rgba(251,191,36,.2); }
    .card.sel { border-color:var(--accent); background:rgba(26,42,66,.95); transform:translateX(6px);
      box-shadow:0 0 16px rgba(255,85,0,.3); }
    /* gamepad focus ring: the InputManager moves data-focused between cards
       and buttons; keyboard hover and mouse click still work alongside it */
    .card[data-focused], button[data-focused] {
      border-color:var(--accent) !important;
      box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 40%, transparent);
    }
    .swatch { width:14px; height:14px; border-radius:4px; flex:none; }
    .name { font-family:'Russo One',sans-serif; font-size:15px; flex:1; }
    .key { font-family:'JetBrains Mono',monospace; font-size:11px; color:var(--muted); background:var(--panel2);
      border:1px solid var(--line); border-radius:4px; padding:1px 6px; }
    .stage { position:relative; }
    .pick { position:absolute; left:28px; top:6px; }
    .pick h2 { font-family:'Russo One',sans-serif; font-size:clamp(24px,3.2vw,36px); margin:0; text-shadow:0 3px 0 #0008; }
    .pick .blurb { color:var(--muted); font-size:12px; margin-top:2px; }
    .where { position:absolute; left:28px; top:74px; color:var(--sand); font-size:13px; font-weight:600;
      text-shadow:0 2px 6px #000c; max-width:40vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .stats { position:absolute; left:28px; bottom:14px; width:270px; padding:12px 14px;
      background:rgba(17,26,38,.86); border:1px solid var(--line); border-radius:10px; backdrop-filter:blur(8px); }
    .stat { display:grid; grid-template-columns:96px 1fr; align-items:center; gap:10px; margin:5px 0;
      font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
    .bar { height:7px; background:#070b12; border-radius:4px; overflow:hidden; border:1px solid var(--line); }
    .fill { display:block; height:100%; background:var(--accent); transition:width .18s; }
    footer { grid-column:1 / -1; display:flex; align-items:center; justify-content:space-between; gap:16px;
      padding:10px 28px 20px; flex-wrap:wrap; }
    .controls { font-size:12px; color:#9e9; line-height:1.8; }
    .controls kbd { background:var(--panel2); border:1px solid var(--line); border-bottom-width:2px;
      border-radius:4px; padding:1px 6px; font-family:'JetBrains Mono',monospace; font-size:11px; color:var(--ink); }
    .play { padding:14px 42px; background:var(--accent); color:#0b0f17; font-family:'Russo One',sans-serif;
      font-size:18px; border:none; border-radius:10px; cursor:pointer;
      box-shadow:0 6px 0 #c23800, 0 10px 24px rgba(255,85,0,.35);
      transition:transform .08s, box-shadow .2s; }
    .actions { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
    .online { padding:13px 22px; background:transparent; color:var(--accent); font-family:'Russo One',sans-serif;
      font-size:14px; border:2px solid var(--accent); border-radius:10px; cursor:pointer; letter-spacing:.04em; }
    .online:hover { background:rgba(255,85,0,.15); }
    .controls { padding:13px 22px; background:transparent; color:var(--muted); font-family:'Russo One',sans-serif;
      font-size:14px; border:2px solid var(--line); border-radius:10px; cursor:pointer; letter-spacing:.04em; }
    .controls:hover { border-color:var(--sand); color:var(--sand); }
    .play:hover { transform:translateY(-2px); box-shadow:0 8px 0 #c23800, 0 14px 28px rgba(255,85,0,.45); }
    .play:active { transform:translateY(4px); box-shadow:0 2px 0 #c23800; }
    @media (max-width: 760px) {
      :host { grid-template-columns:1fr; background:rgba(11,15,23,.96); }
      .stage { min-height:120px; }
      .stats { position:static; width:auto; margin:8px 28px; }
      .pick { position:static; padding:0 28px; }
    }
  `;

  static override properties = { selected: { type: Number }, locationLabel: { type: String } };
  declare selected: number;
  /** Where the next match plays: the desert by default, a relocated place after GO SOMEWHERE REAL. */
  declare locationLabel: string;

  onStart?: (typeIdx: number) => void;
  /** The multiplayer lobby, with the same garage pick. */
  onOnline?: (typeIdx: number) => void;
  onSelect?: (typeIdx: number) => void;
  /** Open the controls/rebind screen. */
  onControls?: () => void;

  /** Focus index across all data-focusable elements: vehicle cards then buttons. */
  private focusIdx = 0;

  /** Handle a UI action from the InputManager. Returns true if consumed. */
  handleUiAction(action: 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back' | 'tab' | 'pause'): boolean {
    const count = VEHICLE_TYPES.length + 3; // cards + PLAY ONLINE + START ENGINE + CONTROLS
    if (action === 'up' || action === 'left') { this.moveFocus(this.focusIdx - 1, count); return true; }
    if (action === 'down' || action === 'right') { this.moveFocus(this.focusIdx + 1, count); return true; }
    if (action === 'confirm') { this.activateFocus(); return true; }
    return false;
  }

  private moveFocus(idx: number, count: number): void {
    const n = ((idx % count) + count) % count;
    this.focusIdx = n;
    if (n < VEHICLE_TYPES.length) this.select(n);
    this.updateFocus();
  }

  private activateFocus(): void {
    if (this.focusIdx < VEHICLE_TYPES.length) this.onStart?.(this.focusIdx);
    else if (this.focusIdx === VEHICLE_TYPES.length) this.onOnline?.(this.selected);
    else if (this.focusIdx === VEHICLE_TYPES.length + 1) this.onStart?.(this.selected);
    else this.onControls?.();
  }

  /** Repaint the data-focused attribute onto the current focus target. */
  private updateFocus(): void {
    this.renderRoot.querySelectorAll('[data-focusable]').forEach((el, i) => {
      if (i === this.focusIdx) el.setAttribute('data-focused', '');
      else el.removeAttribute('data-focused');
    });
  }

  constructor() {
    super();
    this.selected = 2;
    this.focusIdx = 2;
    this.locationLabel = '';
  }

  private padDisposer: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    queueMicrotask(() => { this.onSelect?.(this.selected); this.updateFocus(); });

    if (typeof window !== 'undefined') {
      const onPad = () => this.requestUpdate();
      window.addEventListener('gamepadconnected', onPad);
      window.addEventListener('gamepaddisconnected', onPad);
      this.padDisposer = () => {
        window.removeEventListener('gamepadconnected', onPad);
        window.removeEventListener('gamepaddisconnected', onPad);
      };
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.padDisposer?.();
    this.padDisposer = null;
  }

  private select(idx: number): void {
    const n = VEHICLE_TYPES.length;
    this.selected = ((idx % n) + n) % n;
    this.onSelect?.(this.selected);
  }

  inputManager?: InputManager;

  override render() {
    const v = VEHICLE_TYPES[this.selected]!;
    const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

    const activePad = this.inputManager?.gamepad?.getActivePad();
    let connectedGamepadName: string | null = activePad?.name ?? null;
    if (!connectedGamepadName && typeof navigator !== 'undefined' && navigator.getGamepads) {
      for (const p of navigator.getGamepads()) {
        if (p && p.connected && !/vjoy|virtual/i.test(p.id)) {
          connectedGamepadName = getGamepadDisplayName(p.id);
          break;
        }
      }
    }

    return html`
      <header>
        <h1>SMUGGLERS <span class="ac">TOWN 3D</span></h1>
        <p class="sub">World Tour — one crate of contraband on the map. Grab it, rush it back to your crew's base.
        Get rammed and it changes hands. First to 5, or the leader at the buzzer, wins.</p>
      </header>
      <div class="list">
        <div class="label">Pick your ride</div>
        ${VEHICLE_TYPES.map((t, i) => html`
          <div class="card ${i === this.selected ? 'sel' : ''}" role="button" tabindex="0"
            data-focusable
            @click=${() => this.select(i)} @dblclick=${() => this.onStart?.(i)}>
            <span class="swatch" style="background:${hex(t.color)}"></span>
            <span class="name">${t.name}</span>
            <span class="key">${i + 1}</span>
          </div>
        `)}
      </div>
      <div class="stage">
        <div class="pick">
          <h2>${v.name}</h2>
          <div class="blurb">${blurb(v)}</div>
        </div>
        ${this.locationLabel ? html`<div class="where">📍 ${this.locationLabel}</div>` : ''}
        <div class="stats">
          ${STAT_ROWS.map(([key, label]) => html`
            <div class="stat">
              <span>${label}</span>
              <span class="bar"><span class="fill" style="width:${Math.round(((v[key] as number) / STAT_MAX[key]!) * 100)}%"></span></span>
            </div>
          `)}
        </div>
      </div>
      <footer>
        <div class="controls">
          ${connectedGamepadName ? html`
            <div style="color:var(--accent);font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:6px;">
              <span>🎮</span> <span>${connectedGamepadName}</span>
              <span style="color:var(--muted);font-weight:400;">(<kbd>A</kbd> start · <kbd>D-pad</kbd> pick · <kbd>Start</kbd> controls)</span>
            </div>
          ` : ''}
          <kbd>W</kbd>/<kbd>↑</kbd> accelerate · <kbd>S</kbd>/<kbd>↓</kbd> brake/reverse ·
          <kbd>A</kbd><kbd>D</kbd>/<kbd>←</kbd><kbd>→</kbd> steer · <kbd>Space</kbd> jump<br>
          <kbd>R</kbd> reset car · <kbd>C</kbd> camera · <kbd>↑</kbd><kbd>↓</kbd> pick · <kbd>Enter</kbd> start
        </div>
        <span class="actions">
          <button class="online" data-focusable @click=${() => this.onOnline?.(this.selected)}>PLAY ONLINE</button>
          <button class="play" data-focusable @click=${() => this.onStart?.(this.selected)}>START ENGINE</button>
          <button class="controls" data-focusable @click=${() => this.onControls?.()}>CONTROLS</button>
        </span>
      </footer>
    `;
  }
}

function blurb(v: VehicleStats): string {
  if (v.mass >= 1.8) return 'Slow to wind up, impossible to push around. Rams win.';
  if (v.accel >= 1.4 && v.durability < 0.6) return 'Quick and fragile. Out-run trouble, don\'t out-muscle it.';
  if (v.grip <= 0.75) return 'Fastest thing on the map, and it slides. Brake early.';
  if (v.mass >= 1.3) return 'Heavy enough to bully, quick enough to chase.';
  return 'Balanced. Nothing special, nothing to apologise for.';
}

customElements.define('sr-intro', IntroScreen);
