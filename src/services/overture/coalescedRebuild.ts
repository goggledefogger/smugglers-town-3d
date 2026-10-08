/**
 * At most one rebuild per interval, and at most one in flight: requests
 * that arrive while a build runs, or before the interval since the last
 * start has passed, fold into a single later run. The run reads the latest
 * inputs when it starts, so nothing a folded request asked for is lost.
 * The Cutout 3D stencil uses it: tiles streaming in rewrite the classifier
 * grid every collider pass, and the stencil follows at most every 2 s.
 */
export interface RebuildClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: RebuildClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>)
};

export class CoalescedRebuild {
  private lastStart = -Infinity;
  private busy = false;
  private pending = false;
  private timer: unknown = null;
  /** runs started since construction or the last reset */
  starts = 0;

  /** `run` must call done() when its build finishes or fails (synchronously is fine). */
  constructor(private readonly run: () => void, readonly intervalMs: number, private readonly clock: RebuildClock = realClock) {}

  request(): void {
    if (this.busy || this.timer !== null) {
      this.pending = true;
      return;
    }
    const wait = this.lastStart + this.intervalMs - this.clock.now();
    if (wait > 0) {
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        this.start();
      }, wait);
      return;
    }
    this.start();
  }

  done(): void {
    this.busy = false;
    if (this.pending) {
      this.pending = false;
      this.request();
    }
  }

  /** Drop a queued run and forget the one in flight (a new tileset). */
  reset(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.busy = false;
    this.pending = false;
    this.lastStart = -Infinity;
    this.starts = 0;
  }

  private start(): void {
    this.pending = false;
    this.busy = true;
    this.lastStart = this.clock.now();
    this.starts++;
    this.run();
  }
}
