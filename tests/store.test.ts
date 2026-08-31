import { describe, it, expect } from 'vitest';
import { createStore } from '../src/app/store.ts';
import { EventBus } from '../src/app/events.ts';

describe('createStore', () => {
  it('emits initial state on subscribe', () => {
    const s = createStore({ a: 1 });
    let seen = -1;
    s.subscribe(st => (seen = st.a));
    expect(seen).toBe(1);
  });

  it('notifies subscribers on set with patched state', () => {
    const s = createStore({ a: 1, b: 2 });
    const seen: number[] = [];
    s.subscribe(st => seen.push(st.a));
    s.set({ a: 5 });
    expect(seen).toEqual([1, 5]);
    expect(s.get().b).toBe(2);
  });

  it('unsubscribes via the returned disposer', () => {
    const s = createStore({ a: 1 });
    const seen: number[] = [];
    const off = s.subscribe(st => seen.push(st.a));
    off();
    s.set({ a: 5 });
    expect(seen).toEqual([1]);
  });
});

describe('EventBus', () => {
  it('delivers events to handlers', () => {
    const bus = new EventBus<{ ping: { n: number } }>();
    const got: number[] = [];
    bus.on('ping', p => got.push(p.n));
    bus.emit('ping', { n: 1 });
    bus.emit('ping', { n: 2 });
    expect(got).toEqual([1, 2]);
  });

  it('supports multiple handlers and disposal', () => {
    const bus = new EventBus<{ ping: { n: number } }>();
    const a: number[] = [];
    const b: number[] = [];
    const offA = bus.on('ping', p => a.push(p.n));
    bus.on('ping', p => b.push(p.n));
    bus.emit('ping', { n: 1 });
    offA();
    bus.emit('ping', { n: 2 });
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
  });
});
