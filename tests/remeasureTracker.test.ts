import { describe, expect, it } from 'vitest';
import { RemeasureTracker } from '../src/services/overture/remeasureTracker.ts';

describe('RemeasureTracker', () => {
  it('drains on the last chunk re-measured, even when nothing flipped', () => {
    const t = new RemeasureTracker();
    t.posted(1); t.posted(2);
    t.applied(1); t.applied(2);
    t.begin();
    expect(t.pendingCount).toBe(2);
    t.posted(2); t.posted(1);
    expect(t.applied(2)).toBe(false);
    expect(t.applied(1)).toBe(true);
    expect(t.pendingCount).toBe(0);
  });

  it('a reply to a message posted before the refinement is stale and does not count', () => {
    const t = new RemeasureTracker();
    t.posted(5);          // in flight when the ground is refined
    t.begin();
    t.posted(5);          // the re-measure
    expect(t.applied(5)).toBe(false);
    expect(t.applied(5)).toBe(true);
  });

  it('a new refinement restarts the set from the chunks seen, and never drains twice', () => {
    const t = new RemeasureTracker();
    t.posted(1); t.applied(1);
    t.begin();
    t.posted(2); t.applied(2);   // a chunk first seen mid-drain is not owed by this refinement
    t.begin();                   // second refinement before chunk 1 came back
    expect(t.pendingCount).toBe(2);
    t.posted(1); t.posted(2);
    expect(t.applied(1)).toBe(false);
    expect(t.applied(2)).toBe(true);
    expect(t.applied(2)).toBe(false);
  });

  it('is quiet with no refinement, and reset forgets everything', () => {
    const t = new RemeasureTracker();
    t.posted(1);
    expect(t.applied(1)).toBe(false);
    t.begin();
    t.reset();
    expect(t.pendingCount).toBe(0);
    expect(t.applied(1)).toBe(false);
  });
});
