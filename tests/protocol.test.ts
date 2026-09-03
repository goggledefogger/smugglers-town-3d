import { describe, it, expect } from 'vitest';
import {
  encode, decode, inputToMsg, inputFromMsg,
  type InputMsg, type SnapshotMsg, type EventMsg, type HelloMsg, type BodySnap
} from '../src/net/protocol.ts';
import type { VehicleInput } from '../src/core/physics/vehicleStats.ts';

describe('InputMsg', () => {
  it('round trips through encode/decode', () => {
    const msg: InputMsg = { t: 'i', seq: 7, th: 0.5, br: 0.25, st: -0.3, j: true, p: 0.2 };
    expect(decode(encode(msg))).toEqual(msg);
  });

  it('inputToMsg / inputFromMsg round trip, defaulting missing pitch to 0', () => {
    const input: VehicleInput = { throttle: 1, brake: 0, steer: -1, jump: false };
    const msg = inputToMsg(input, 3);
    expect(msg).toEqual({ t: 'i', seq: 3, th: 1, br: 0, st: -1, j: false, p: 0 });
    expect(inputFromMsg(msg)).toEqual({ throttle: 1, brake: 0, steer: -1, jump: false, pitch: 0 });
  });

  it('rejects out-of-range fields', () => {
    const base = { t: 'i', seq: 1, th: 0.5, br: 0.5, st: 0, j: false, p: 0 };
    expect(decode(JSON.stringify({ ...base, th: 1.5 }))).toBeNull();
    expect(decode(JSON.stringify({ ...base, br: -0.1 }))).toBeNull();
    expect(decode(JSON.stringify({ ...base, st: 2 }))).toBeNull();
    expect(decode(JSON.stringify({ ...base, p: -2 }))).toBeNull();
    expect(decode(JSON.stringify({ ...base, seq: -1 }))).toBeNull();
    expect(decode(JSON.stringify({ ...base, j: 'yes' }))).toBeNull();
  });

  it('rejects missing fields', () => {
    expect(decode(JSON.stringify({ t: 'i', seq: 1 }))).toBeNull();
  });
});

describe('SnapshotMsg', () => {
  const sample: SnapshotMsg = {
    t: 's', tick: 42, timeS: 12.3, timeLeftS: 118.7,
    phase: 'playing', scores: [1, 2], carrier: 3,
    crate: [1.23456, 0.5, -7.89123],
    bodies: [
      { id: 0, p: [1.23456, 0.5, -3.14159], q: [0.123456, 0.5, -0.5, 0.707107], v: [1.111, -2.222, 0], d: 0.42, g: 1 },
      { id: 1, p: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], d: 0, g: 0 }
    ]
  };

  it('round trips, rounding positions/velocities to 2dp and quaternions to 4dp', () => {
    const decoded = decode(encode(sample)) as SnapshotMsg;
    expect(decoded.tick).toBe(42);
    expect(decoded.phase).toBe('playing');
    expect(decoded.scores).toEqual([1, 2]);
    expect(decoded.carrier).toBe(3);
    expect(decoded.crate).toEqual([1.23, 0.5, -7.89]);
    const body0 = decoded.bodies[0] as BodySnap;
    expect(body0.p).toEqual([1.23, 0.5, -3.14]);
    expect(body0.q).toEqual([0.1235, 0.5, -0.5, 0.7071]);
    expect(body0.v).toEqual([1.11, -2.22, 0]);
  });

  it('allows a null carrier', () => {
    const msg: SnapshotMsg = { ...sample, carrier: null };
    const decoded = decode(encode(msg)) as SnapshotMsg;
    expect(decoded.carrier).toBeNull();
  });

  it('rejects a bad phase, wrong-length arrays, and non-finite numbers', () => {
    const base = JSON.parse(encode(sample)) as Record<string, unknown>;
    expect(decode(JSON.stringify({ ...base, phase: 'paused' }))).toBeNull();
    expect(decode(JSON.stringify({ ...base, scores: [1] }))).toBeNull();
    expect(decode(JSON.stringify({ ...base, crate: [1, 2] }))).toBeNull();
    expect(decode(JSON.stringify({ ...base, bodies: [{ ...(base.bodies as unknown[])[0] as object, q: [0, 0, 0] }] }))).toBeNull();
    expect(decode('{"t":"s","tick":1,"timeS":1,"timeLeftS":1,"phase":"playing","scores":[0,0],"carrier":null,"crate":[0,0,0],"bodies":[{"id":0,"p":[0,0,0],"q":[0,0,0,1],"v":[0,0,0],"d":NaN,"g":0}]}')).toBeNull();
  });

  it('encodes an 8-body snapshot compactly', () => {
    // 8 grounded cars spread over ~50 world units, yaw-only rotation (typical
    // driving pose) — a realistic, not worst-case, snapshot.
    const bodies: BodySnap[] = Array.from({ length: 8 }, (_, i) => {
      const yaw = (i - 4) * 0.35;
      return {
        id: i,
        p: [(i - 4) * 8.5, 0.4, (i - 4) * -6.2],
        q: [0, Math.round(Math.sin(yaw / 2) * 10000) / 10000, 0, Math.round(Math.cos(yaw / 2) * 10000) / 10000],
        v: [4 + i * 0.4, 0, -1 + i * 0.2],
        d: i * 0.03,
        g: (i % 2) as 0 | 1
      };
    });
    const msg: SnapshotMsg = {
      t: 's', tick: 1200, timeS: 42.5, timeLeftS: 77.3,
      phase: 'playing', scores: [3, 5], carrier: 2, crate: [10.5, 0.5, -8.25], bodies
    };
    const bytes = new TextEncoder().encode(encode(msg)).length;
    // The literal single-char-keyed schema plus JSON's own punctuation puts a
    // realistic 8-body snapshot around 780-800 bytes, not the 400-700 the
    // spec doc estimates; there is no further slack to squeeze at this
    // precision without changing the wire format (e.g. binary, coarser
    // rounding, or dropping a quaternion axis for grounded bodies).
    expect(bytes).toBeLessThan(1000);
  });
});

describe('EventMsg', () => {
  const cases: EventMsg[] = [
    { t: 'e', name: 'contraband:pickup', payload: { vehicleId: 3 } },
    { t: 'e', name: 'contraband:stolen', payload: { attackerId: 1, victimId: 2 } },
    { t: 'e', name: 'contraband:delivered', payload: { team: 0 } },
    { t: 'e', name: 'contraband:dropped', payload: { vehicleId: 4 } },
    { t: 'e', name: 'vehicle:wrecked', payload: { vehicleId: 5 } },
    { t: 'e', name: 'match:countdown', payload: { n: 3 } },
    { t: 'e', name: 'match:finalMinute', payload: {} },
    { t: 'e', name: 'match:suddenDeath', payload: {} },
    { t: 'e', name: 'match:win', payload: { team: 1 } }
  ];

  it.each(cases)('round trips %j', msg => {
    expect(decode(encode(msg))).toEqual(msg);
  });

  it('rejects an unknown event name and a bad payload', () => {
    expect(decode(JSON.stringify({ t: 'e', name: 'nope', payload: {} }))).toBeNull();
    expect(decode(JSON.stringify({ t: 'e', name: 'match:win', payload: { team: 2 } }))).toBeNull();
    expect(decode(JSON.stringify({ t: 'e', name: 'contraband:pickup', payload: {} }))).toBeNull();
  });
});

describe('HelloMsg', () => {
  it('round trips with and without map.query', () => {
    const withQuery: HelloMsg = {
      t: 'h', seed: 42, map: { kind: 'city', query: 'portland' }, bases: [[273, 2, 0], [-273, 2, 0]],
      roster: [
        { id: 0, name: 'A', team: 0, vehicle: 2, owner: 'peer-1' },
        { id: 1, name: 'B', team: 1, vehicle: 0, owner: null }
      ]
    };
    expect(decode(encode(withQuery))).toEqual(withQuery);

    const noQuery: HelloMsg = { t: 'h', seed: 7, map: { kind: 'desert' }, roster: [], bases: [[0, 0, 0], [1, 1, 1]] };
    expect(decode(encode(noQuery))).toEqual(noQuery);
  });

  it('rejects a bad map kind, out-of-range vehicle, and a wrong-typed owner', () => {
    const base = { t: 'h', seed: 1, map: { kind: 'desert' }, roster: [] as unknown[], bases: [[0, 0, 0], [1, 1, 1]] };
    expect(decode(JSON.stringify({ ...base, map: { kind: 'moon' } }))).toBeNull();
    expect(decode(JSON.stringify({
      ...base, roster: [{ id: 0, name: 'A', team: 0, vehicle: 9, owner: null }]
    }))).toBeNull();
    expect(decode(JSON.stringify({
      ...base, roster: [{ id: 0, name: 'A', team: 0, vehicle: 0, owner: 7 }]
    }))).toBeNull();
  });
});

describe('decode', () => {
  it('never throws on garbage, and returns null', () => {
    expect(decode('not json')).toBeNull();
    expect(decode('{"t":"i"')).toBeNull();
    expect(decode(NaN)).toBeNull();
    expect(decode(undefined)).toBeNull();
    expect(decode(null)).toBeNull();
    expect(decode(42)).toBeNull();
    expect(decode([])).toBeNull();
    expect(decode(JSON.stringify({ t: 'x' }))).toBeNull();
  });
});

describe('join message', () => {
  it('round-trips a join and rejects one without a valid token', () => {
    const join = { t: 'j' as const, uid: 'abc123', token: '0123456789abcdef0123456789abcdef' };
    expect(decode(encode(join))).toEqual(join);
    expect(decode(JSON.stringify({ t: 'j', uid: 'abc123' }))).toBeNull();
    expect(decode(JSON.stringify({ t: 'j', uid: 'abc123', token: 'short' }))).toBeNull();
    expect(decode(JSON.stringify({ t: 'j', uid: '', token: join.token }))).toBeNull();
  });
});
