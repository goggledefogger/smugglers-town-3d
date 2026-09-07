import { html, css, LitElement, type PropertyValues } from 'lit';
import { ALL_ACTIONS, type Bindings, type Binding } from '../../input/bindings.ts';
import type { LogicalAction } from '../../input/types.ts';
import type { InputManager } from '../../input/InputManager.ts';
import type { AudioManager } from '../../audio/AudioManager.ts';
import type { GameEvents } from '../../app/events.ts';

/**
 * Rebind screen: lists every logical action and its current binding on each
 * device, and lets the player rebind by entering "listening" mode and
 * pressing a key or button. Also provides master audio volume and sound controls.
 * Changes save to localStorage immediately.
 *
 * Opened from the garage's CONTROLS button or via Pause hotkey.
 */

const ACTION_LABEL: Record<LogicalAction, string> = {
  accelerate: 'Accelerate',
  brake: 'Brake / reverse',
  steerLeft: 'Steer left',
  steerRight: 'Steer right',
  jump: 'Jump',
  handbrake: 'Handbrake (slide)',
  pitchUp: 'Pitch up (air)',
  pitchDown: 'Pitch down (air)',
  camera: 'Camera',
  reset: 'Reset car',
  viewMode: 'Toggle 3D visual mode',
  clutterMode: 'Street clutter filter',
  uiUp: 'Menu up',
  uiDown: 'Menu down',
  uiLeft: 'Menu left',
  uiRight: 'Menu right',
  uiConfirm: 'Confirm',
  uiBack: 'Back',
  uiTab: 'Tab',
  uiPause: 'Pause'
};

const ACTION_GROUP: Record<string, LogicalAction[]> = {
  Driving: ['accelerate', 'brake', 'steerLeft', 'steerRight', 'jump', 'handbrake', 'pitchUp', 'pitchDown'],
  'Gameplay hotkeys': ['camera', 'reset', 'viewMode'],
  Menus: ['uiUp', 'uiDown', 'uiLeft', 'uiRight', 'uiConfirm', 'uiBack', 'uiTab', 'uiPause']
};

function describeBinding(b: Binding): string {
  if (b.kind === 'key') return prettyKey(b.code);
  if (b.kind === 'button') return `Button ${b.index}`;
  return `Axis ${b.index} ${b.sign > 0 ? '+' : '−'}`;
}

function prettyKey(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Arrow')) return code.slice(5) + ' arrow';
  if (code === 'Space') return 'Space';
  return code;
}

export class SettingsScreen extends LitElement {
  static override styles = css`
    :host {
      position: fixed; inset: 0; z-index: 70;
      display: flex; align-items: flex-start; justify-content: center;
      background: var(--scrim); overflow-y: auto;
      padding: var(--space-xl) var(--space-md);
      box-sizing: border-box;
    }
    :host([hidden]) { display: none; }
    .panel {
      width: 100%; max-width: 42rem; margin: auto 0;
      background: var(--panel); border: var(--border) solid var(--line);
      border-radius: var(--radius-lg); padding: var(--space-xl);
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.65);
    }
    h1 { font-family: 'Russo One', sans-serif; font-size: 1.4rem; margin: 0 0 var(--space-sm); }
    .sub { color: var(--muted); font-size: var(--text-sm); margin: 0 0 var(--space-lg); }
    .group { margin-bottom: var(--space-lg); }
    .group h2 {
      font-size: var(--text-xs); letter-spacing: var(--tracking-wide);
      text-transform: uppercase; color: var(--muted); margin: 0 0 var(--space-xs);
    }
    .row {
      display: grid; grid-template-columns: 1fr auto auto;
      align-items: center; gap: var(--space-sm);
      padding: var(--space-xs) var(--space-sm);
      border: 1px solid var(--line); border-radius: var(--radius-sm);
      margin-bottom: var(--space-2xs); cursor: pointer;
    }
    .row[data-focused] {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 40%, transparent);
    }
    .row.listening { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--panel)); }
    .action { font-size: var(--text-md); }
    .binding {
      font-family: 'JetBrains Mono', monospace; font-size: var(--text-sm);
      color: var(--muted); padding: var(--space-2xs) var(--space-sm);
      background: var(--field-bg); border: 1px solid var(--line); border-radius: var(--radius-sm);
      min-width: 6rem; text-align: center;
    }
    .binding.empty { color: var(--muted); font-style: italic; }
    .device { font-size: var(--text-2xs); color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
    .footer { display: flex; gap: var(--space-sm); justify-content: flex-end; margin-top: var(--space-lg); }
    button {
      padding: var(--space-sm) var(--space-lg);
      background: var(--panel2); color: var(--ink);
      border: var(--border) solid var(--line); border-radius: var(--radius-md);
      font-family: inherit; font-weight: 600; cursor: pointer;
    }
    button:hover { border-color: var(--accent); color: var(--accent); }
    button.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
    .listening-prompt {
      color: var(--accent); font-size: var(--text-sm); text-align: center;
      margin: var(--space-sm) 0; min-height: 1.2em;
    }
    .audio-panel {
      background: var(--field-bg);
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      padding: var(--space-md);
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
    }
    .audio-control-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-md);
      flex-wrap: wrap;
    }
    .audio-label {
      font-size: var(--text-md);
      font-weight: 600;
      color: var(--ink);
    }
    .slider-wrapper {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      flex: 1;
      min-width: 14rem;
      justify-content: flex-end;
    }
    .volume-slider {
      flex: 1;
      max-width: 18rem;
      height: 8px;
      appearance: none;
      -webkit-appearance: none;
      background: var(--panel2);
      border-radius: 4px;
      outline: none;
      cursor: pointer;
      border: 1px solid var(--line);
    }
    .volume-slider::-webkit-slider-thumb {
      appearance: none;
      -webkit-appearance: none;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: var(--accent);
      cursor: pointer;
      border: 2px solid #fff;
      box-shadow: 0 0 8px rgba(245, 158, 11, 0.4);
      transition: transform 0.1s ease;
    }
    .volume-slider::-webkit-slider-thumb:hover {
      transform: scale(1.15);
    }
    .volume-slider::-moz-range-thumb {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: var(--accent);
      cursor: pointer;
      border: 2px solid #fff;
      box-shadow: 0 0 8px rgba(245, 158, 11, 0.4);
    }
    .volume-badge {
      font-family: 'JetBrains Mono', monospace;
      font-size: var(--text-sm);
      font-weight: 600;
      color: var(--accent);
      background: var(--panel2);
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      padding: var(--space-2xs) var(--space-xs);
      min-width: 3.5rem;
      text-align: center;
    }
    .audio-actions-row {
      display: flex;
      gap: var(--space-sm);
      flex-wrap: wrap;
    }
    .audio-btn {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      padding: var(--space-xs) var(--space-md);
      font-size: var(--text-sm);
      letter-spacing: 0.03em;
    }
    .audio-btn.muted {
      border-color: #ef4444;
      color: #ef4444;
    }
    .audio-btn.active {
      border-color: var(--accent);
    }
  `;

  static override properties = {
    listening: { type: String }
  };
  /** Which action is in listening mode, or null. */
  declare listening: LogicalAction | null;
  private manager: InputManager | null = null;
  private audio: AudioManager | null = null;
  private offAudio: (() => void) | null = null;
  private focusIdx = 0;
  private offChange: (() => void) | null = null;
  private cancelCapture: (() => void) | null = null;

  constructor() {
    super();
    this.listening = null;
  }

  bindAudio(audio: AudioManager, events?: GameEvents): void {
    this.audio = audio;
    this.offAudio?.();
    if (events) {
      this.offAudio = events.on('audio:change', () => this.requestUpdate());
    }
    this.requestUpdate();
  }

  private handleVolumeInput(e: Event): void {
    const input = e.target as HTMLInputElement;
    const val = Number(input.value) / 100;
    if (this.audio) {
      this.audio.setVolume(val);
    }
    this.requestUpdate();
  }

  private handleToggleMute(): void {
    if (this.audio) {
      this.audio.toggleMute();
    }
    this.requestUpdate();
  }

  private handleTestHorn(): void {
    if (this.audio) {
      this.audio.testHorn();
    }
  }

  set inputManager(m: InputManager) {
    this.manager = m;
    this.offChange?.();
    this.offChange = m.bindings.onChange(() => this.requestUpdate());
  }

  handleUiAction(action: 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back' | 'tab' | 'pause'): boolean {
    if (action === 'pause') { this.close(); return true; }
    if (action === 'back') {
      if (this.listening) { this.cancelListening(); return true; }
      this.close(); return true;
    }
    if (action === 'confirm') {
      const rows = this.actionsList();
      const a = rows[this.focusIdx];
      if (a) this.startListening(a);
      return true;
    }
    if (action === 'up' || action === 'left' || action === 'down' || action === 'right') {
      if (this.listening) return true;  // don't move focus while capturing
      const rows = this.actionsList();
      if (rows.length === 0) return false;
      const dir = (action === 'up' || action === 'left') ? -1 : 1;
      this.focusIdx = ((this.focusIdx + dir) % rows.length + rows.length) % rows.length;
      this.updateFocus();
      return true;
    }
    return false;
  }

  private close(): void {
    this.cancelListening();
    this.hidden = true;
    this.requestUpdate();
    this.dispatchEvent(new CustomEvent('settings-close', { bubbles: true, composed: true }));
  }

  private cancelListening(): void {
    this.cancelCapture?.();
    this.cancelCapture = null;
    this.listening = null;
    this.requestUpdate();
  }

  private actionsList(): readonly LogicalAction[] {
    return ALL_ACTIONS;
  }

  private startListening(action: LogicalAction): void {
    this.cancelCapture?.();
    this.listening = action;
    this.requestUpdate();
    // swallow the confirm/back that opened listening so it doesn't capture itself
    setTimeout(() => {
      if (!this.manager || this.listening !== action) return;
      this.cancelCapture = this.manager.captureNext(captured => {
        this.manager!.bindings.rebind(captured.device, action, captured.binding);
        this.listening = null;
        this.cancelCapture = null;
        this.requestUpdate();
      });
    }, 250);
  }

  private updateFocus(): void {
    this.renderRoot.querySelectorAll('.row').forEach((el, i) => {
      if (i === this.focusIdx) el.setAttribute('data-focused', '');
      else el.removeAttribute('data-focused');
    });
  }

  override updated(_changed: PropertyValues): void {
    this.updateFocus();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.offChange?.();
    this.offChange = null;
    this.cancelCapture?.();
    this.cancelCapture = null;
    this.offAudio?.();
    this.offAudio = null;
  }

  override render() {
    const b = this.manager?.bindings;
    const volPercent = Math.round((this.audio?.masterVolume ?? 0.8) * 100);
    const isMuted = this.audio?.muted ?? false;

    return html`
      <div class="panel">
        <h1>SETTINGS & CONTROLS</h1>
        <p class="sub">Adjust game audio volume and rebind controls. Changes take effect immediately and save to your browser.</p>

        <div class="group audio-group">
          <h2>Audio Settings</h2>
          <div class="audio-panel">
            <div class="audio-control-row">
              <span class="audio-label">Master Volume</span>
              <div class="slider-wrapper">
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  .value=${String(volPercent)}
                  @input=${this.handleVolumeInput}
                  class="volume-slider"
                  aria-label="Master Volume"
                />
                <span class="volume-badge">${volPercent}%</span>
              </div>
            </div>
            <div class="audio-actions-row">
              <button
                type="button"
                class="audio-btn ${isMuted ? 'muted' : 'active'}"
                @click=${this.handleToggleMute}
              >
                ${isMuted ? '🔇 UNMUTE AUDIO' : '🔊 MUTE AUDIO'}
              </button>
              <button
                type="button"
                class="audio-btn horn-btn"
                @click=${this.handleTestHorn}
                title="Test sound volume"
              >
                📯 TEST HORN
              </button>
            </div>
          </div>
        </div>

        <div class="listening-prompt">${this.listening
          ? `Press a key or button for ${ACTION_LABEL[this.listening]}… (B to cancel)`
          : ''}</div>
        ${Object.entries(ACTION_GROUP).map(([group, actions]) => html`
          <div class="group">
            <h2>${group}</h2>
            ${actions.map(action => this.renderRow(b, action))}
          </div>
        `)}
        <div class="footer">
          <button @click=${() => this.reset()}>RESET TO DEFAULTS</button>
          <button class="primary" @click=${() => this.close()}>DONE</button>
        </div>
      </div>
    `;
  }

  private renderRow(b: Bindings | undefined, action: LogicalAction) {
    const kb = b?.table('keyboard')[action];
    const gp = b?.table('gamepad')[action];
    const isListening = this.listening === action;
    return html`
      <div class="row ${isListening ? 'listening' : ''}" @click=${() => this.startListening(action)}>
        <span class="action">${ACTION_LABEL[action]}</span>
        <span class="binding ${kb?.length ? '' : 'empty'}">${kb?.length ? describeBinding(kb[0]!) : '—'}</span>
        <span class="binding ${gp?.length ? '' : 'empty'}">${gp?.length ? describeBinding(gp[0]!) : '—'}</span>
      </div>
    `;
  }

  private reset(): void {
    this.manager?.bindings.reset();
  }
}

customElements.define('sr-settings', SettingsScreen);
