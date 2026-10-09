/**
 * Which chunks of the Cutout height field must be re-measured after a ground refinement, and when the last one has.
 *
 * A refinement swaps the worker's terrain but keeps its field, so a stored rise is read against the new ground
 * until its chunk is measured again: a roof cap baked in that window is wrong, and a re-measure that flips no bit
 * rebuilds nothing. The caller bumps the keep version once this reports the set drained.
 *
 * The worker answers every chunk message in order, so a reply to a message posted before the refinement is stale
 * (measured against the old ground). Each seen chunk therefore needs (messages still unanswered + 1) replies.
 */
export class RemeasureTracker {
  /** chunks posted at least once since the last reset */
  private readonly seen = new Set<number>();
  /** messages posted and not yet answered, per chunk */
  private readonly outstanding = new Map<number, number>();
  /** replies still needed before the chunk counts as re-measured */
  private readonly pending = new Map<number, number>();

  get pendingCount(): number {
    return this.pending.size;
  }

  /** A chunk's heights were posted to the worker. */
  posted(chunk: number): void {
    this.seen.add(chunk);
    this.outstanding.set(chunk, (this.outstanding.get(chunk) ?? 0) + 1);
  }

  /** A refinement was applied: every chunk seen so far needs a fresh measure. Replaces any set still draining. */
  begin(): void {
    this.pending.clear();
    for (const c of this.seen) this.pending.set(c, (this.outstanding.get(c) ?? 0) + 1);
  }

  /** The worker answered a chunk. True when this reply drains the set (the last chunk is re-measured). */
  applied(chunk: number): boolean {
    const o = this.outstanding.get(chunk) ?? 0;
    if (o > 0) this.outstanding.set(chunk, o - 1);
    const need = this.pending.get(chunk);
    if (need === undefined) return false;
    if (need > 1) {
      this.pending.set(chunk, need - 1);
      return false;
    }
    this.pending.delete(chunk);
    return this.pending.size === 0;
  }

  /**
   * A chunk owed a re-measure was turned away by the capture (it holds no fine tile any more, so it is not coming):
   * it stops being owed. True when that drains the set.
   */
  skipped(chunk: number): boolean {
    return this.pending.delete(chunk) && this.pending.size === 0;
  }

  /** A fresh field (new tileset or world): nothing seen, nothing owed. */
  reset(): void {
    this.seen.clear();
    this.outstanding.clear();
    this.pending.clear();
  }
}
