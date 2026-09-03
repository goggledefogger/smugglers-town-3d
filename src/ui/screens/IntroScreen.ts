import { html, css, LitElement } from 'lit';
import { VEHICLE_TYPES, type VehicleStats } from '../../core/physics/vehicleStats.ts';

/**
 * The garage: title, the roster to pick from, stats for the pick, and the
 * way into the game. The right half is see-through so the Showroom's 3D
 * preview of the selected vehicle shows behind it. Arrow keys or 1-5
 * select, Enter (or the button) starts.
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
    :host { position:fixed; inset:0; z-index:40; display:grid;
      grid-template-columns:minmax(300px, 430px) 1fr; grid-template-rows:auto 1fr auto;
      background:linear-gradient(90deg, rgba(26,20,16,.97) 0%, rgba(26,20,16,.97) 34%,
        rgba(26,20,16,.18) 52%, rgba(26,20,16,.3) 100%); }
    header { grid-column:1 / -1; padding:20px 28px 6px; }
    h1 { font-family:'Russo One',sans-serif; font-size:clamp(28px,4.5vw,46px); line-height:1;
      margin:0; text-shadow:0 4px 0 #0006; }
    .ac { color:var(--accent); }
    .sub { color:var(--muted); margin:8px 0 0; font-size:13px; max-width:640px; line-height:1.45; }
    .list { padding:8px 28px; display:flex; flex-direction:column; gap:8px; overflow:auto; }
    .label { font-size:10px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted); margin:6px 0 2px; }
    .card { display:flex; align-items:center; gap:12px; padding:11px 14px; background:rgba(36,28,22,.85);
      border:2px solid var(--line); border-radius:10px; cursor:pointer; outline:none; transition:border-color .12s, transform .12s; }
    .card:hover { border-color:var(--sand); }
    .card.sel { border-color:var(--accent); background:rgba(64,42,28,.95); transform:translateX(6px); }
    .swatch { width:14px; height:14px; border-radius:4px; flex:none; }
    .name { font-family:'Russo One',sans-serif; font-size:15px; flex:1; }
    .key { font-family:'JetBrains Mono',monospace; font-size:11px; color:var(--muted); background:var(--panel2);
      border:1px solid var(--line); border-radius:4px; padding:1px 6px; }
    .stage { position:relative; }
    .pick { position:absolute; left:28px; top:6px; }
    .pick h2 { font-family:'Russo One',sans-serif; font-size:clamp(24px,3.2vw,36px); margin:0; text-shadow:0 3px 0 #0006; }
    .pick .blurb { color:var(--muted); font-size:12px; margin-top:2px; }
    .stats { position:absolute; left:28px; bottom:14px; width:270px; padding:12px 14px;
      background:rgba(36,28,22,.86); border:1px solid var(--line); border-radius:10px; }
    .stat { display:grid; grid-template-columns:96px 1fr; align-items:center; gap:10px; margin:5px 0;
      font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
    .bar { height:7px; background:#000; border-radius:4px; overflow:hidden; border:1px solid var(--line); }
    .fill { display:block; height:100%; background:var(--accent); transition:width .18s; }
    footer { grid-column:1 / -1; display:flex; align-items:center; justify-content:space-between; gap:16px;
      padding:10px 28px 20px; flex-wrap:wrap; }
    .controls { font-size:12px; color:#9e9; line-height:1.8; }
    .controls kbd { background:var(--panel2); border:1px solid var(--line); border-bottom-width:2px;
      border-radius:4px; padding:1px 6px; font-family:'JetBrains Mono',monospace; font-size:11px; color:var(--ink); }
    .play { padding:14px 42px; background:var(--accent); color:#1a1410; font-family:'Russo One',sans-serif;
      font-size:18px; border:none; border-radius:10px; cursor:pointer; box-shadow:0 6px 0 #b0390f;
      transition:transform .08s, box-shadow .2s; }
    .actions { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
    .online { padding:13px 22px; background:transparent; color:var(--accent); font-family:'Russo One',sans-serif;
      font-size:14px; border:2px solid var(--accent); border-radius:10px; cursor:pointer; letter-spacing:.04em; }
    .online:hover { background:rgba(255,120,60,.12); }
    .play:hover { transform:translateY(-2px); box-shadow:0 8px 0 #b0390f; }
    .play:active { transform:translateY(4px); box-shadow:0 2px 0 #b0390f; }
    @media (max-width: 760px) {
      :host { grid-template-columns:1fr; background:rgba(26,20,16,.96); }
      .stage { min-height:120px; }
      .stats { position:static; width:auto; margin:8px 28px; }
      .pick { position:static; padding:0 28px; }
    }
  `;

  static override properties = { selected: { type: Number } };
  declare selected: number;

  onStart?: (typeIdx: number) => void;
  /** The multiplayer lobby, with the same garage pick. */
  onOnline?: (typeIdx: number) => void;
  onSelect?: (typeIdx: number) => void;

  private readonly onKey = (e: KeyboardEvent): void => {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName ?? '')) return;
    if (e.code === 'ArrowDown' || e.code === 'ArrowRight') this.select(this.selected + 1);
    else if (e.code === 'ArrowUp' || e.code === 'ArrowLeft') this.select(this.selected - 1);
    else if (e.code.startsWith('Digit')) {
      const n = Number(e.code.slice(5));
      if (n >= 1 && n <= VEHICLE_TYPES.length) this.select(n - 1);
    } else if (e.code === 'Enter') this.onStart?.(this.selected);
    else return;
    e.preventDefault();
  };

  constructor() {
    super();
    this.selected = 2;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.onKey);
    queueMicrotask(() => this.onSelect?.(this.selected));
  }

  override disconnectedCallback(): void {
    window.removeEventListener('keydown', this.onKey);
    super.disconnectedCallback();
  }

  private select(idx: number): void {
    const n = VEHICLE_TYPES.length;
    this.selected = ((idx % n) + n) % n;
    this.onSelect?.(this.selected);
  }

  override render() {
    const v = VEHICLE_TYPES[this.selected]!;
    const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
    return html`
      <header>
        <h1>SMUGGLERS <span class="ac">TOWN 3D</span></h1>
        <p class="sub">Turf Wars — one crate of contraband on the map. Grab it, rush it back to your crew's base.
        Get rammed and it changes hands. First to 5, or the leader at the buzzer, wins.</p>
      </header>
      <div class="list">
        <div class="label">Pick your ride</div>
        ${VEHICLE_TYPES.map((t, i) => html`
          <div class="card ${i === this.selected ? 'sel' : ''}" role="button" tabindex="0"
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
          <kbd>W</kbd>/<kbd>↑</kbd> accelerate · <kbd>S</kbd>/<kbd>↓</kbd> brake/reverse ·
          <kbd>A</kbd><kbd>D</kbd>/<kbd>←</kbd><kbd>→</kbd> steer · <kbd>Space</kbd> jump<br>
          <kbd>R</kbd> reset car · <kbd>C</kbd> camera · <kbd>↑</kbd><kbd>↓</kbd> or <kbd>1-5</kbd> pick · <kbd>Enter</kbd> start
        </div>
        <span class="actions">
          <button class="online" @click=${() => this.onOnline?.(this.selected)}>PLAY ONLINE</button>
          <button class="play" @click=${() => this.onStart?.(this.selected)}>START ENGINE</button>
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
