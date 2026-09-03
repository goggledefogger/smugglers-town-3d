import { describe, it, expect } from 'vitest';
import { ClientSession } from '../src/net/ClientSession.ts';
import { createLoopbackHub } from '../src/net/LoopbackTransport.ts';
import { encode, PROTOCOL_VERSION, type HelloMsg, type SnapshotMsg } from '../src/net/protocol.ts';
import { EventBus, type GameEventMap } from '../src/app/events.ts';
import { createStore, type HudSnapshot } from '../src/app/store.ts';
import { Heightfield } from '../src/core/heightfield.ts';
import { createDesertTerrain } from '../src/core/terrain/ProceduralTerrain.ts';

const hello: HelloMsg = {
  t: 'h', v: PROTOCOL_VERSION, seed: 1, map: { kind: 'desert' },
  roster: [{ id: 1, name: 'me', team: 0, vehicle: 2, owner: 'me' }, { id: 2, name: 'bot', team: 1, vehicle: 0, owner: null }],
  bases: [[100, 0, 0], [-100, 0, 0]]
};

function snapshot(tick: number, x: number): SnapshotMsg {
  const body = (id: number) => ({ id, p: [x, 1, 0] as [number, number, number], q: [0, 0, 0, 1] as [number, number, number, number], v: [60, 0, 0] as [number, number, number], d: 0, g: 1 as const });
  return { t: 's', tick, timeS: tick / 60, timeLeftS: 300, phase: 'playing', scores: [0, 0], carrier: null, crate: [0, 0, 0], bodies: [body(1), body(2)] };
}

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

describe('ClientSession playback', () => {
  it('moves the puppet forward smoothly through jittery snapshot arrival, never backward', async () => {
    const hub = createLoopbackHub();
    const host = hub.join('host');
    const me = hub.join('me');
    const terrain = createDesertTerrain(new Heightfield(840, 1, new Float32Array(4)));
    const client = new ClientSession(hello, 'me', me, new EventBus<GameEventMap>(), createStore<HudSnapshot>({} as HudSnapshot), terrain);
    const car = client.player!.body;
    // the host moves 1 unit per tick and snapshots every 3 ticks; the network
    // delivers them in irregular bursts: gaps of up to 4 frames, then two at once
    const queue: SnapshotMsg[] = [];
    const deliver = async (): Promise<void> => {
      for (const s of queue.splice(0)) host.send(encode(s), 'me');
      await flush();
    };
    for (let f = 0; f < 12; f++) if (f % 3 === 0) queue.push(snapshot(f, f));
    await deliver();
    const xs: number[] = [];
    let stalls = 0;
    for (let frame = 12; frame < 132; frame++) {
      if (frame % 3 === 0) queue.push(snapshot(frame, frame));
      if (frame % 5 === 0 || frame % 7 === 0) await deliver();
      client.update(1 / 60, null);
      const x = car.pos.x;
      if (xs.length > 0 && x < xs[xs.length - 1]!) throw new Error(`went backward at frame ${frame}`);
      if (xs.length > 0 && x === xs[xs.length - 1]! && frame > 10) stalls++;
      xs.push(x);
    }
    // covered the distance the host did (within the buffer's delay), and only
    // a handful of frames stood still
    expect(xs[xs.length - 1]!).toBeGreaterThan(xs[10]! + 95);
    expect(stalls).toBeLessThan(6);
    client.dispose();
  });
});
