/**
 * Game Audio Manager.
 * Orchestrates procedural Web Audio synthesis, handles browser autoplay unlock,
 * manages master gain/mute settings with localStorage persistence, and wires
 * gameplay events to dynamic sound cues.
 */

import type { GameEvents } from '../app/events.ts';
import type { VehicleActor } from '../app/Game.ts';
import type { VehicleInput } from '../core/physics/vehicleStats.ts';
import type { MatchState } from '../core/gameplay/MatchRules.ts';
import { EngineAudio } from './EngineAudio.ts';
import { TireAudio } from './TireAudio.ts';
import { ImpactAudio } from './ImpactAudio.ts';
import { StingerAudio } from './StingerAudio.ts';
import { ProximityAudio } from './ProximityAudio.ts';
import { HornAudio } from './HornAudio.ts';

const STORAGE_MUTED_KEY = 'smugglers_audio_muted';
const STORAGE_VOLUME_KEY = 'smugglers_audio_volume';

export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;

  readonly engine: EngineAudio | null = null;
  readonly tire: TireAudio | null = null;
  readonly impacts: ImpactAudio | null = null;
  readonly stingers: StingerAudio | null = null;
  readonly proximity: ProximityAudio | null = null;
  readonly horn: HornAudio | null = null;

  private isMuted = false;
  private volume = 0.8;
  private unsubEvents: (() => void)[] = [];
  private unlockHandler: (() => void) | null = null;
  private prevJumpHeld = false;

  constructor(private readonly events?: GameEvents) {
    this.loadSettings();
    this.initContext();
    this.setupAutoplayUnlock();
    this.bindEvents();
  }

  private loadSettings(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const savedMuted = localStorage.getItem(STORAGE_MUTED_KEY);
      if (savedMuted !== null) this.isMuted = savedMuted === 'true';
      const savedVol = localStorage.getItem(STORAGE_VOLUME_KEY);
      if (savedVol !== null) {
        const parsed = parseFloat(savedVol);
        if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) this.volume = parsed;
      }
    } catch {}
  }

  private saveSettings(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_MUTED_KEY, String(this.isMuted));
      localStorage.setItem(STORAGE_VOLUME_KEY, String(this.volume));
    } catch {}
  }

  private initContext(): void {
    const AudioCtx =
      typeof window !== 'undefined'
        ? window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        : null;
    if (!AudioCtx) return;

    try {
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.updateMasterGain();
      this.masterGain.connect(this.ctx.destination);

      // Initialize sound generators
      (this as any).engine = new EngineAudio(this.ctx, this.masterGain);
      (this as any).tire = new TireAudio(this.ctx, this.masterGain);
      (this as any).impacts = new ImpactAudio(this.ctx, this.masterGain);
      (this as any).stingers = new StingerAudio(this.ctx, this.masterGain);
      (this as any).proximity = new ProximityAudio(this.ctx, this.masterGain);
      (this as any).horn = new HornAudio(this.ctx, this.masterGain);
    } catch {
      // AudioContext unavailable in headless / node environment without polyfills
    }
  }

  private setupAutoplayUnlock(): void {
    if (typeof window === 'undefined') return;

    this.unlockHandler = () => {
      this.resume();
      this.removeAutoplayListeners();
    };

    window.addEventListener('pointerdown', this.unlockHandler, { passive: true, once: true });
    window.addEventListener('keydown', this.unlockHandler, { passive: true, once: true });
    window.addEventListener('touchstart', this.unlockHandler, { passive: true, once: true });
  }

  private removeAutoplayListeners(): void {
    if (!this.unlockHandler || typeof window === 'undefined') return;
    window.removeEventListener('pointerdown', this.unlockHandler);
    window.removeEventListener('keydown', this.unlockHandler);
    window.removeEventListener('touchstart', this.unlockHandler);
    this.unlockHandler = null;
  }

  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  private updateMasterGain(): void {
    if (!this.masterGain || !this.ctx) return;
    const targetGain = this.isMuted ? 0 : this.volume;
    this.masterGain.gain.setTargetAtTime(targetGain, this.ctx.currentTime, 0.02);
  }

  toggleMute(): boolean {
    this.setMuted(!this.isMuted);
    return this.isMuted;
  }

  setMuted(muted: boolean): void {
    this.isMuted = muted;
    this.saveSettings();
    this.updateMasterGain();
    if (!muted) this.resume();
  }

  get muted(): boolean {
    return this.isMuted;
  }

  setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(1, vol));
    this.saveSettings();
    this.updateMasterGain();
  }

  get masterVolume(): number {
    return this.volume;
  }

  private bindEvents(): void {
    if (!this.events) return;

    this.unsubEvents.push(
      this.events.on('contraband:pickup', () => this.stingers?.playPickup()),
      this.events.on('contraband:stolen', () => this.stingers?.playStolen()),
      this.events.on('contraband:delivered', () => this.stingers?.playDelivered()),
      this.events.on('contraband:dropped', () => this.stingers?.playDropped()),
      this.events.on('vehicle:wrecked', () => this.stingers?.playWrecked()),
      this.events.on('match:countdown', e => this.stingers?.playCountdown(e.n)),
      this.events.on('match:finalMinute', () => this.stingers?.playAlert()),
      this.events.on('match:suddenDeath', () => this.stingers?.playAlert()),
      this.events.on('match:win', () => this.stingers?.playWin())
    );
  }

  /**
   * Main per-frame audio loop update.
   */
  update(
    dt: number,
    player: VehicleActor | null,
    drive: VehicleInput | null,
    state: MatchState | null,
    inPlay: boolean
  ): void {
    if (!this.ctx || this.ctx.state !== 'running') return;

    if (!inPlay || !player) {
      this.engine?.update(dt, 0, 1, 0, true, false);
      this.tire?.update(0, 0, false, false);
      return;
    }

    const b = player.body;
    const topSpeed = b.cfg.maxSpeed * b.stats.maxSpeed;
    const throttle = drive?.throttle ?? 0;
    const handbrake = !!drive?.handbrake;

    // Start background audio sources if needed
    this.engine?.start();
    this.tire?.start();

    // 1. Engine sound
    this.engine?.update(dt, b.speed, topSpeed, throttle, b.onGround, true);

    // 2. Tire screech & drift
    this.tire?.update(b.speed, b.lateralSlip, handbrake, b.onGround);

    // 3. Collision impacts
    if (b.lastImpact) {
      if (b.lastImpact.kind === 'landing') {
        this.impacts?.playLanding(b.lastImpact.speed);
      } else if (b.lastImpact.kind === 'building') {
        this.impacts?.playCrash(b.lastImpact.speed);
      } else if (b.lastImpact.kind === 'vehicle') {
        this.impacts?.playRam(b.lastImpact.speed);
      }
    }

    // 4. Jump whoosh
    const jumpingNow = !!drive?.jump;
    if (jumpingNow && !this.prevJumpHeld && b.onGround) {
      this.playJumpWhoosh();
    }
    this.prevJumpHeld = jumpingNow;

    // 5. Proximity beacon cue when carrying contraband near team base
    if (state) {
      const isCarrier = state.contraband.some(c => c.carrier === b);
      if (isCarrier) {
        const teamBase = state.bases[player.team];
        if (teamBase) {
          const dist = Math.hypot(b.pos.x - teamBase.x, b.pos.z - teamBase.z);
          this.proximity?.update(true, dist);
        }
      }
    }
  }

  private playJumpWhoosh(): void {
    if (!this.ctx || this.ctx.state !== 'running' || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(90, now);
    osc.frequency.exponentialRampToValueAtTime(260, now + 0.15);

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(now);
    osc.stop(now + 0.2);
  }

  dispose(): void {
    for (const unsub of this.unsubEvents) unsub();
    this.unsubEvents = [];
    this.removeAutoplayListeners();
    this.engine?.stop();
    this.tire?.stop();
    this.horn?.stop();
    if (this.ctx && this.ctx.state !== 'closed') {
      this.ctx.close().catch(() => {});
    }
    this.ctx = null;
  }
}
