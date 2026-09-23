/**
 * Slow-frame log: a hitch names its cause. The frame loop marks its sections
 * with `lap`; work outside the loop (a promise landing) goes through `time`. A
 * frame over budget logs each section's ms and the game events of the last
 * second under the `perf` scope, so `stt.dump()` or the lobby's copy link
 * carries the evidence
 */
import { logger } from './log.ts';
import type { GameEvents } from './events.ts';

const log = logger('perf');
const SLOW_WORK_MS = 50;
const SLOW_GAP_MS = 250;
const WATCHED = [
  'contraband:pickup', 'contraband:stolen', 'contraband:delivered', 'contraband:dropped',
  'vehicle:wrecked', 'match:finalMinute', 'match:suddenDeath'
] as const;

export class FrameProfiler {
  private readonly laps = new Map<string, number>();
  private lapAt = 0;
  private readonly recent: { name: string; t: number }[] = [];

  constructor(events: GameEvents) {
    for (const name of WATCHED) events.on(name, () => this.recent.push({ name, t: performance.now() }));
  }

  begin(): void {
    this.lapAt = performance.now();
  }

  /** Charge the time since the last mark to `name`. */
  lap(name: string): void {
    const t = performance.now();
    this.add(name, t - this.lapAt);
    this.lapAt = t;
  }

  /** Charge `fn` to `name` in the next report, for work the loop does not run. */
  time<T>(name: string, fn: () => T): T {
    const t0 = performance.now();
    try { return fn(); } finally { this.add(name, performance.now() - t0); }
  }

  /** gapMs: time since the previous frame began, which also catches stalls no lap saw. */
  end(gapMs: number): void {
    const now = performance.now();
    while (this.recent.length && now - this.recent[0]!.t > 1000) this.recent.shift();
    let work = 0;
    for (const ms of this.laps.values()) work += ms;
    if (work >= SLOW_WORK_MS || gapMs >= SLOW_GAP_MS) {
      const parts: Record<string, number> = {};
      for (const [k, ms] of this.laps) if (ms >= 2) parts[k] = Math.round(ms);
      log.warn(`slow frame: ${Math.round(work)} ms work, ${Math.round(gapMs)} ms since last`, {
        parts, events: this.recent.map(e => `${e.name} ${Math.round(now - e.t)} ms ago`)
      });
    }
    this.laps.clear();
  }

  private add(name: string, ms: number): void {
    this.laps.set(name, (this.laps.get(name) ?? 0) + ms);
  }
}
