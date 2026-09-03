import { describe, it, expect, vi } from 'vitest';
import { createLoopbackHub } from '../src/net/LoopbackTransport.ts';

// deliveries are queued as microtasks, so give them one tick to flush
const flush = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

describe('LoopbackTransport', () => {
  it('broadcasts to every other member and not the sender', async () => {
    const hub = createLoopbackHub();
    const a = hub.join('a');
    const b = hub.join('b');
    const c = hub.join('c');
    await flush();

    const onA = vi.fn();
    const onB = vi.fn();
    const onC = vi.fn();
    a.onMessage(onA);
    b.onMessage(onB);
    c.onMessage(onC);

    a.send('hi');
    await flush();

    expect(onA).not.toHaveBeenCalled();
    expect(onB).toHaveBeenCalledWith('hi', 'a');
    expect(onC).toHaveBeenCalledWith('hi', 'a');
  });

  it('a direct send reaches only its target', async () => {
    const hub = createLoopbackHub();
    const a = hub.join('a');
    const b = hub.join('b');
    const c = hub.join('c');
    await flush();

    const onB = vi.fn();
    const onC = vi.fn();
    b.onMessage(onB);
    c.onMessage(onC);

    a.send('hi', 'b');
    await flush();

    expect(onB).toHaveBeenCalledWith('hi', 'a');
    expect(onC).not.toHaveBeenCalled();
  });

  it('a newcomer sees existing peers and existing peers get onPeerJoin', async () => {
    const hub = createLoopbackHub();
    const a = hub.join('a');
    hub.join('b');
    await flush();

    const onJoin = vi.fn();
    a.onPeerJoin(onJoin);

    const c = hub.join('c');

    expect([...c.peers()].sort()).toEqual(['a', 'b']);
    expect(onJoin).not.toHaveBeenCalled();
    await flush();
    expect(onJoin).toHaveBeenCalledWith('c');
  });

  it('leave fires onPeerLeave and removes the peer', async () => {
    const hub = createLoopbackHub();
    const a = hub.join('a');
    const b = hub.join('b');
    await flush();

    const onLeave = vi.fn();
    b.onPeerLeave(onLeave);

    a.leave();

    expect(b.peers()).toEqual([]);
    expect(onLeave).not.toHaveBeenCalled();
    await flush();
    expect(onLeave).toHaveBeenCalledWith('a');
  });

  it('an unsubscribed callback stops firing', async () => {
    const hub = createLoopbackHub();
    const a = hub.join('a');
    const b = hub.join('b');
    await flush();

    const onMessage = vi.fn();
    const unsubscribe = b.onMessage(onMessage);
    unsubscribe();

    a.send('hi');
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });
});
