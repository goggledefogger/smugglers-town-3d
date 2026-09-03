import { describe, it, expect } from 'vitest';
import { HostSession } from '../src/net/HostSession.ts';
import { createLoopbackHub } from '../src/net/LoopbackTransport.ts';
import { encode } from '../src/net/protocol.ts';
import { EventBus, type GameEventMap } from '../src/app/events.ts';

const TOKENS = { ada: 'ada-token-0123456789abcdef', bob: 'bob-token-0123456789abcdef' };
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

describe('HostSession seat binding', () => {
  it('binds a peer to a seat only with that seat\'s token, and never rebinds', async () => {
    const hub = createLoopbackHub();
    const hostT = hub.join('host');
    const host = new HostSession(hostT, new EventBus<GameEventMap>(), TOKENS);
    const ada = hub.join('peer-ada');
    const mallory = hub.join('peer-mallory');
    const wait = host.waitForPeers(['ada', 'bob'], 200);

    // wrong token: ignored
    mallory.send(encode({ t: 'j', uid: 'ada', token: 'wrong-token-0123456789abcdef' }), 'host');
    await tick();
    // right token: bound
    ada.send(encode({ t: 'j', uid: 'ada', token: TOKENS.ada }), 'host');
    await tick();
    // a second peer with the right token cannot take a bound seat
    mallory.send(encode({ t: 'j', uid: 'ada', token: TOKENS.ada }), 'host');
    await tick();
    // and a bound peer cannot claim a second seat
    ada.send(encode({ t: 'j', uid: 'bob', token: TOKENS.bob }), 'host');
    await tick();

    const missing = await wait;
    expect(missing).toEqual(['bob']);
    host.dispose();
  });
});

describe('HostSession start barrier', () => {
  const seat = (hub: ReturnType<typeof createLoopbackHub>, uid: 'ada' | 'bob') => {
    const t = hub.join(`peer-${uid}`);
    t.send(encode({ t: 'j', uid, token: TOKENS[uid] }), 'host');
    return t;
  };

  it('holds the start until every player reports its world built', async () => {
    const hub = createLoopbackHub();
    const host = new HostSession(hub.join('host'), new EventBus<GameEventMap>(), TOKENS);
    const ada = seat(hub, 'ada');
    const bob = seat(hub, 'bob');
    await tick();

    const wait = host.waitForReady(['ada', 'bob'], 2000);
    let settled = false;
    void wait.then(() => { settled = true; });

    ada.send(encode({ t: 'r' }), 'host');
    await tick();
    expect(settled).toBe(false); // one loaded is not everyone

    bob.send(encode({ t: 'r' }), 'host');
    expect(await wait).toEqual([]);
    host.dispose();
  });

  it('gives up on a straggler rather than hanging the match', async () => {
    const hub = createLoopbackHub();
    const host = new HostSession(hub.join('host'), new EventBus<GameEventMap>(), TOKENS);
    const ada = seat(hub, 'ada');
    seat(hub, 'bob');
    await tick();

    const started = Date.now();
    const wait = host.waitForReady(['ada', 'bob'], 120);
    ada.send(encode({ t: 'r' }), 'host');
    expect(await wait).toEqual(['bob']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    host.dispose();
  });

  it('stops waiting the moment a loading player drops, without burning the timeout', async () => {
    const hub = createLoopbackHub();
    const host = new HostSession(hub.join('host'), new EventBus<GameEventMap>(), TOKENS);
    const ada = seat(hub, 'ada');
    const bob = seat(hub, 'bob');
    await tick();

    const started = Date.now();
    const wait = host.waitForReady(['ada', 'bob'], 10000);
    ada.send(encode({ t: 'r' }), 'host');
    await tick();
    bob.leave();

    expect(await wait).toEqual(['bob']);
    expect(Date.now() - started).toBeLessThan(2000); // the timeout is for the stuck, not the gone
    host.dispose();
  });

  it('ignores a ready from a peer that never claimed a seat', async () => {
    const hub = createLoopbackHub();
    const host = new HostSession(hub.join('host'), new EventBus<GameEventMap>(), TOKENS);
    const ada = seat(hub, 'ada');
    const stranger = hub.join('peer-stranger');
    await tick();

    const wait = host.waitForReady(['ada'], 150);
    stranger.send(encode({ t: 'r' }), 'host');
    await tick();

    ada.send(encode({ t: 'r' }), 'host');
    expect(await wait).toEqual([]);
    host.dispose();
  });
});
