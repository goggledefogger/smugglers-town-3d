/**
 * Procedural Collision & Landing Impact Synthesizer.
 * Synthesizes dynamic landing thuds, building crash crunches, and vehicle-to-vehicle rams.
 */

export class ImpactAudio {
  private lastImpactTime = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly destination: AudioNode
  ) {}

  /**
   * Plays a ground landing thump scaled to landing velocity.
   */
  playLanding(speed: number): void {
    if (this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    if (now - this.lastImpactTime < 0.1) return; // rate limit
    this.lastImpactTime = now;

    const intensity = Math.min(1.0, Math.max(0.2, (speed - 5) / 25));
    const duration = 0.22;

    // Pitch-dropping sine thump
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(130 * (0.8 + 0.4 * intensity), now);
    osc.frequency.exponentialRampToValueAtTime(32, now + duration);

    gain.gain.setValueAtTime(intensity * 0.45, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc.connect(gain);
    gain.connect(this.destination);

    osc.start(now);
    osc.stop(now + duration + 0.05);
  }

  /**
   * Plays a building or obstacle collision crunch.
   */
  playCrash(speed: number): void {
    if (this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    if (now - this.lastImpactTime < 0.08) return;
    this.lastImpactTime = now;

    const intensity = Math.min(1.0, Math.max(0.25, speed / 24));
    const duration = 0.28;

    // 1. Low bass punch
    const osc = this.ctx.createOscillator();
    const oscGain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(160, now);
    osc.frequency.exponentialRampToValueAtTime(40, now + duration);
    oscGain.gain.setValueAtTime(intensity * 0.4, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.connect(oscGain);
    oscGain.connect(this.destination);
    osc.start(now);
    osc.stop(now + duration);

    // 2. High crunch noise transient
    this.playNoiseBurst(now, duration * 0.7, 850, intensity * 0.35);
  }

  /**
   * Plays a vehicle-to-vehicle metallic collision.
   */
  playRam(relSpeed: number): void {
    if (this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    if (now - this.lastImpactTime < 0.08) return;
    this.lastImpactTime = now;

    const intensity = Math.min(1.0, Math.max(0.3, relSpeed / 20));
    const duration = 0.24;

    // Metallic ring (dual detuned tones)
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc1.type = 'sawtooth';
    osc2.type = 'triangle';
    osc1.frequency.setValueAtTime(260, now);
    osc2.frequency.setValueAtTime(395, now);
    osc1.frequency.exponentialRampToValueAtTime(80, now + duration);
    osc2.frequency.exponentialRampToValueAtTime(120, now + duration);

    gain.gain.setValueAtTime(intensity * 0.38, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(this.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + duration);
    osc2.stop(now + duration);

    this.playNoiseBurst(now, duration * 0.6, 1400, intensity * 0.3);
  }

  private playNoiseBurst(start: number, duration: number, cutoff: number, vol: number): void {
    const sampleRate = this.ctx.sampleRate;
    const bufferSize = Math.floor(sampleRate * duration);
    if (bufferSize <= 0) return;

    const buffer = this.ctx.createBuffer(1, bufferSize, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(cutoff, start);
    filter.Q.setValueAtTime(1.8, start);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(vol, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.destination);

    noise.start(start);
    noise.stop(start + duration + 0.02);
  }
}
