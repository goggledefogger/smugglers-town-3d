/**
 * Procedural Vehicle Engine Synthesizer using Web Audio API.
 * Uses dual harmonic oscillators, resonant lowpass filtering, and dynamic
 * multi-gear RPM curve responding to throttle load, road speed, and airborne states.
 */

export class EngineAudio {
  private readonly osc1: OscillatorNode;
  private readonly osc2: OscillatorNode;
  private readonly filter: BiquadFilterNode;
  private readonly gain: GainNode;
  private isStarted = false;

  private currentRpm = 0.2; // 0.0 (idle) to 1.0 (redline)

  constructor(private readonly ctx: AudioContext, destination: AudioNode) {
    // Primary sawtooth for combustion cylinder pulse harmonics
    this.osc1 = ctx.createOscillator();
    this.osc1.type = 'sawtooth';
    this.osc1.frequency.setValueAtTime(46, ctx.currentTime);

    // Sub-harmonic triangle for deep engine block rumble
    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'triangle';
    this.osc2.frequency.setValueAtTime(23, ctx.currentTime);

    // Resonant lowpass filter simulating exhaust manifold & intake acoustics
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.setValueAtTime(220, ctx.currentTime);
    this.filter.Q.setValueAtTime(2.0, ctx.currentTime);

    // Output gain node
    this.gain = ctx.createGain();
    this.gain.gain.setValueAtTime(0, ctx.currentTime);

    // Wire up graph: (osc1 + osc2) -> filter -> gain -> destination
    this.osc1.connect(this.filter);
    this.osc2.connect(this.filter);
    this.filter.connect(this.gain);
    this.gain.connect(destination);
  }

  start(): void {
    if (this.isStarted) return;
    this.isStarted = true;
    try {
      this.osc1.start();
      this.osc2.start();
    } catch {
      // Ignore if already started
    }
  }

  /**
   * Updates engine pitch, filter cutoff, and throttle load every frame.
   * @param dt Elapsed frame time in seconds
   * @param speed Vehicle current speed in m/s
   * @param maxSpeed Top speed of vehicle in m/s
   * @param throttle Throttle input [0, 1]
   * @param onGround Whether wheels are touching ground
   * @param inPlay Whether active driving is underway
   */
  update(
    dt: number,
    speed: number,
    maxSpeed: number,
    throttle: number,
    onGround: boolean,
    inPlay: boolean
  ): void {
    if (!this.isStarted || this.ctx.state !== 'running') return;

    const now = this.ctx.currentTime;
    if (!inPlay) {
      // Fade out engine when in showroom or menus
      this.gain.gain.setTargetAtTime(0, now, 0.1);
      return;
    }

    const safeMaxSpeed = Math.max(15, maxSpeed);
    const speedRatio = Math.min(1.0, Math.max(0, speed / safeMaxSpeed));

    // Multi-gear simulation: calculate target RPM across 4 gear steps
    let targetRpm = 0.2;
    if (!onGround && throttle > 0.1) {
      // Wheels spinning freely in the air: RPM flares up
      targetRpm = 0.85 + 0.15 * throttle;
    } else {
      // 4-gear power bands
      if (speedRatio < 0.25) {
        // 1st gear: 0.0 -> 0.25 speed maps to 0.2 -> 0.8 RPM
        targetRpm = 0.2 + (speedRatio / 0.25) * 0.6;
      } else if (speedRatio < 0.50) {
        // 2nd gear: 0.25 -> 0.50 speed maps to 0.45 -> 0.85 RPM
        targetRpm = 0.45 + ((speedRatio - 0.25) / 0.25) * 0.4;
      } else if (speedRatio < 0.75) {
        // 3rd gear: 0.50 -> 0.75 speed maps to 0.55 -> 0.90 RPM
        targetRpm = 0.55 + ((speedRatio - 0.50) / 0.25) * 0.35;
      } else {
        // 4th gear: 0.75 -> 1.00 speed maps to 0.65 -> 1.00 RPM
        targetRpm = 0.65 + ((speedRatio - 0.75) / 0.25) * 0.35;
      }

      // Add throttle load boost
      if (throttle > 0) {
        targetRpm = Math.min(1.0, targetRpm + throttle * 0.12);
      }
    }

    // Smooth RPM response
    const rpmSpeed = targetRpm > this.currentRpm ? 6.0 : 3.5;
    this.currentRpm += (targetRpm - this.currentRpm) * Math.min(1.0, dt * rpmSpeed);

    // Map RPM to fundamental pitch (45 Hz at idle, up to ~320 Hz at redline)
    const baseFreq = 45 + this.currentRpm * 275;
    this.osc1.frequency.setTargetAtTime(baseFreq, now, 0.05);
    this.osc2.frequency.setTargetAtTime(baseFreq * 0.5, now, 0.05);

    // Resonant filter opens with RPM and aggressive throttle
    const baseCutoff = 180 + this.currentRpm * 1400;
    const throttleCutoffBoost = throttle * 900;
    const cutoff = Math.min(3600, baseCutoff + throttleCutoffBoost);
    this.filter.frequency.setTargetAtTime(cutoff, now, 0.05);

    // Engine volume: base volume + throttle surge
    const targetGain = 0.18 + this.currentRpm * 0.14 + (throttle > 0 ? 0.08 : 0);
    this.gain.gain.setTargetAtTime(targetGain, now, 0.05);
  }

  stop(): void {
    if (!this.isStarted) return;
    try {
      this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
      setTimeout(() => {
        try {
          this.osc1.stop();
          this.osc2.stop();
        } catch {}
      }, 100);
    } catch {}
    this.isStarted = false;
  }
}
