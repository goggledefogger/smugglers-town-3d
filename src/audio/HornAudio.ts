/**
 * Procedural Vehicle Horn Synthesizer.
 * Dual-tone vintage electric horn (F4 349 Hz & A4 440 Hz).
 */

export class HornAudio {
  private osc1: OscillatorNode | null = null;
  private osc2: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  private isHonking = false;

  constructor(
    private readonly ctx: AudioContext,
    private readonly destination: AudioNode
  ) {}

  start(): void {
    if (this.isHonking || this.ctx.state !== 'running') return;
    this.isHonking = true;

    const now = this.ctx.currentTime;
    this.osc1 = this.ctx.createOscillator();
    this.osc2 = this.ctx.createOscillator();
    this.gain = this.ctx.createGain();

    this.osc1.type = 'sawtooth';
    this.osc2.type = 'triangle';
    this.osc1.frequency.setValueAtTime(349.23, now); // F4
    this.osc2.frequency.setValueAtTime(440.00, now); // A4

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(800, now);
    filter.Q.setValueAtTime(1.5, now);

    this.gain.gain.setValueAtTime(0.001, now);
    this.gain.gain.linearRampToValueAtTime(0.28, now + 0.03);

    this.osc1.connect(filter);
    this.osc2.connect(filter);
    filter.connect(this.gain);
    this.gain.connect(this.destination);

    this.osc1.start(now);
    this.osc2.start(now);
  }

  stop(): void {
    if (!this.isHonking) return;
    this.isHonking = false;

    const now = this.ctx.currentTime;
    if (this.gain) {
      this.gain.gain.linearRampToValueAtTime(0.001, now + 0.04);
    }
    setTimeout(() => {
      try {
        this.osc1?.stop();
        this.osc2?.stop();
        this.osc1?.disconnect();
        this.osc2?.disconnect();
      } catch {}
      this.osc1 = null;
      this.osc2 = null;
      this.gain = null;
    }, 50);
  }
}
