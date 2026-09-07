/**
 * Procedural Tire Skid & Drift Audio Synthesizer.
 * Generates bandpass-filtered noise modulated dynamically by lateral slip velocity
 * and handbrake maneuvers on the driving surface.
 */

export class TireAudio {
  private readonly filter: BiquadFilterNode;
  private readonly gain: GainNode;
  private noiseSource: AudioBufferSourceNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private isStarted = false;

  constructor(private readonly ctx: AudioContext, destination: AudioNode) {
    // Bandpass filter isolating high-friction tire screech and gravel scrub frequencies
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'bandpass';
    this.filter.frequency.setValueAtTime(1050, ctx.currentTime);
    this.filter.Q.setValueAtTime(2.2, ctx.currentTime);

    this.gain = ctx.createGain();
    this.gain.gain.setValueAtTime(0, ctx.currentTime);

    this.filter.connect(this.gain);
    this.gain.connect(destination);

    this.createNoiseBuffer();
  }

  private createNoiseBuffer(): void {
    const sampleRate = this.ctx.sampleRate;
    const bufferSize = sampleRate * 2; // 2 seconds of noise
    const buffer = this.ctx.createBuffer(1, bufferSize, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buffer;
  }

  start(): void {
    if (this.isStarted || !this.noiseBuffer) return;
    this.isStarted = true;

    try {
      this.noiseSource = this.ctx.createBufferSource();
      this.noiseSource.buffer = this.noiseBuffer;
      this.noiseSource.loop = true;
      this.noiseSource.connect(this.filter);
      this.noiseSource.start();
    } catch {
      // Ignore if cannot start
    }
  }

  /**
   * Updates tire sound intensity based on lateral skid speed and handbrake.
   * @param speed Vehicle speed in m/s
   * @param lateralSlip Lateral skid speed in m/s
   * @param handbrake Whether handbrake is engaged
   * @param onGround Whether vehicle is on driving surface
   */
  update(
    speed: number,
    lateralSlip: number,
    handbrake: boolean,
    onGround: boolean
  ): void {
    if (!this.isStarted || this.ctx.state !== 'running') return;

    const now = this.ctx.currentTime;
    if (!onGround || speed < 3) {
      this.gain.gain.setTargetAtTime(0, now, 0.05);
      return;
    }

    // Measure slide intensity from lateral tire velocity
    const slipFactor = Math.min(1.0, Math.max(0, (lateralSlip - 2.5) / 10.0));
    // Handbrake at speed causes immediate rear-wheel lock slide
    const handbrakeFactor = handbrake && speed > 5 ? Math.min(1.0, speed / 18.0) * 0.75 : 0;
    const intensity = Math.max(slipFactor, handbrakeFactor);

    if (intensity > 0.05) {
      // Pitch/frequency rises with slip speed
      const centerFreq = 950 + intensity * 450 + Math.min(300, speed * 8);
      this.filter.frequency.setTargetAtTime(centerFreq, now, 0.05);

      const targetGain = intensity * 0.13;
      this.gain.gain.setTargetAtTime(targetGain, now, 0.04);
    } else {
      this.gain.gain.setTargetAtTime(0, now, 0.06);
    }
  }

  stop(): void {
    if (!this.isStarted) return;
    try {
      this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
      this.noiseSource?.stop();
      this.noiseSource?.disconnect();
    } catch {}
    this.noiseSource = null;
    this.isStarted = false;
  }
}
