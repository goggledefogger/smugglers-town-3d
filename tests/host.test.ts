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
