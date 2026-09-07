/**
 * Procedural Musical Stingers and Event Audio Cues.
 * Responds to gameplay events (contraband pickup, steal, delivery, wreck, countdown, match end).
 */

export class StingerAudio {
  constructor(
    private readonly ctx: AudioContext,
    private readonly destination: AudioNode
  ) {}

  /**
   * Upbeat ascending 4-note arpeggio on contraband pickup.
   */
  playPickup(): void {
    if (this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
    notes.forEach((freq, idx) => {
      this.playTone(now + idx * 0.07, freq, 0.22, 0.28, 'triangle');
    });
  }

  /**
   * Dramatic double warning stinger when contraband is stolen.
   */
  playStolen(): void {
    if (this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    this.playTone(now, 622.25, 0.14, 0.35, 'sawtooth'); // Eb5
    this.playTone(now + 0.12, 739.99, 0.25, 0.40, 'sawtooth'); // F#5
  }

  /**
   * Triumphant brassy victory fanfare when contraband is delivered to base.
   */
  playDelivered(): void {
    if (this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    // Fanfare motif: C5 -> E5 -> G5 -> High C6 chord
    const sequence = [
      { t: 0.00, f: 523.25, d: 0.12, vol: 0.32 },
      { t: 0.10, f: 659.25, d: 0.12, vol: 0.34 },
      { t: 0.20, f: 783.99, d: 0.18, vol: 0.36 },
      { t: 0.34, f: 1046.50, d: 0.55, vol: 0.42 }
    ];

    for (const s of sequence) {
      this.playTone(now + s.t, s.f, s.d, s.vol, 'triangle');
      // Harmonic layer for brassy brightness
      this.playTone(now + s.t, s.f * 1.5, s.d * 0.8, s.vol * 0.4, 'sine');
    }
  }

  /**
   * Descending dissonant cue when contraband is dropped or lost.
   */
  playDropped(): void {
    if (this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(587.33, now); // D5
    osc.frequency.exponentialRampToValueAtTime(220.00, now + 0.32); // A3

    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);

    osc.connect(gain);
    gain.connect(this.destination);

    osc.start(now);
    osc.stop(now + 0.35);
  }

  /**
   * Heavy crash and electrical power down tone when vehicle is wrecked.
   */
  playWrecked(): void {
    if (this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(30, now + 0.5);

    gain.gain.setValueAtTime(0.42, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

    osc.connect(gain);
    gain.connect(this.destination);

    osc.start(now);
    osc.stop(now + 0.52);
  }

  /**
   * Match start countdown beep:
   * n = 3, 2, 1 -> short high ping
   * n = 0 ("GO!") -> bright celebratory chord
   */
  playCountdown(n: number): void {
    if (this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;

    if (n > 0) {
      this.playTone(now, 880, 0.09, 0.32, 'sine');
    } else {
      // "GO!" chord: 1760 Hz + 1320 Hz
      this.playTone(now, 1760, 0.35, 0.38, 'sine');
      this.playTone(now, 1320, 0.35, 0.28, 'triangle');
    }
  }

  /**
   * Alert pulse for final minute or sudden death.
   */
  playAlert(): void {
    if (this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    this.playTone(now, 440, 0.15, 0.3, 'square');
    this.playTone(now + 0.18, 440, 0.18, 0.3, 'square');
  }

  /**
   * Extended victory fanfare when a team wins the match.
   */
  playWin(): void {
    if (this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const fanfare = [
      { t: 0.0, f: 523.25, d: 0.15 }, // C5
      { t: 0.15, f: 659.25, d: 0.15 }, // E5
      { t: 0.30, f: 783.99, d: 0.22 }, // G5
      { t: 0.55, f: 659.25, d: 0.12 }, // E5
      { t: 0.70, f: 1046.50, d: 0.75 } // High C6
    ];

    for (const note of fanfare) {
      this.playTone(now + note.t, note.f, note.d, 0.35, 'triangle');
      this.playTone(now + note.t, note.f * 1.5, note.d * 0.8, 0.18, 'sine');
    }
  }

  private playTone(
    start: number,
    freq: number,
    duration: number,
    volume: number,
    type: OscillatorType
  ): void {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);

    gain.gain.setValueAtTime(0.001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);

    osc.connect(gain);
    gain.connect(this.destination);

    osc.start(start);
    osc.stop(start + duration + 0.05);
  }
}
