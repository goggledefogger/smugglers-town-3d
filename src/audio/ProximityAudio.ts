/**
 * Procedural Base Delivery Proximity Beacon Cue.
 * When the player is carrying contraband and nearing their delivery base,
 * emits rhythmic beacon pulses that accelerate in tempo and volume as they approach.
 */

export class ProximityAudio {
  private lastPulseTime = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly destination: AudioNode
  ) {}

  /**
   * Updates proximity cue every frame.
   * @param isCarrying Whether the local player is currently carrying contraband
   * @param distanceToBase Distance in meters to the team's delivery base
   */
  update(isCarrying: boolean, distanceToBase: number): void {
    if (!isCarrying || this.ctx.state !== 'running') return;

    // Active zone: within 160m of the base
    const maxDist = 160;
    const minDist = 22; // delivery radius
    if (distanceToBase > maxDist || distanceToBase < minDist * 0.5) return;

    // Normalized closeness: 0.0 at 160m, 1.0 at 22m
    const closeness = Math.min(1.0, Math.max(0, (maxDist - distanceToBase) / (maxDist - minDist)));

    // Pulse interval speeds up: 1.1s at distance -> 0.25s right near base
    const pulseInterval = 1.1 - closeness * 0.85;

    const now = this.ctx.currentTime;
    if (now - this.lastPulseTime >= pulseInterval) {
      this.lastPulseTime = now;
      this.playPulse(now, closeness);
    }
  }

  private playPulse(start: number, closeness: number): void {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    // Pitch rises as you get closer (440 Hz up to 660 Hz)
    const freq = 440 + closeness * 220;
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);

    const duration = 0.09;
    const volume = 0.08 + closeness * 0.20;

    gain.gain.setValueAtTime(0.001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);

    osc.connect(gain);
    gain.connect(this.destination);

    osc.start(start);
    osc.stop(start + duration + 0.02);
  }
}
