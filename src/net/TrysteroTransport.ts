import type { FirebaseApp } from 'firebase/app';
import { joinRoom, selfId } from '@trystero-p2p/firebase';
import type { Transport } from './Transport.ts';
import { logger } from '../app/log.ts';

const log = logger('rtc');

/** Google's public STUN server; free, no account, enough for peers that aren't both behind symmetric NATs. */
const STUN_URL = 'stun:stun.l.google.com:19302';
/**
 * Where to get a TURN relay (turn/worker.js) for players on different
 * networks, where a direct link often cannot get through both routers. Unset
 * or unreachable, matches still connect directly wherever that works
 */
// Vite statically replaces import.meta.env.VITE_* at build time.
// Dynamic key access (import.meta.env[key]) does NOT work
const TURN_URL: string = import.meta.env.VITE_TURN_URL ?? '';

/** `?relay` on the URL: connect only through the relay, to test it on one network. */
const RELAY_ONLY = typeof location !== 'undefined' && new URLSearchParams(location.search).has('relay');

/** How a live link to a peer actually runs: through the relay, or directly. */
async function linkKind(pc: RTCPeerConnection | undefined): Promise<string> {
  if (!pc) return 'unknown';
  const stats = await pc.getStats();
  for (const s of stats.values()) {
    if (s.type !== 'candidate-pair' || !s.nominated || s.state !== 'succeeded') continue;
    return stats.get(s.localCandidateId)?.candidateType === 'relay' ? 'relay' : 'direct';
  }
  return 'unknown';
}

async function relayServers(): Promise<RTCIceServer[]> {
  if (!TURN_URL) return [];
  try {
    const res = await fetch(TURN_URL, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json() as { iceServers?: RTCIceServer[] };
    return body.iceServers ?? [];
  } catch (e) {
    log.warn('no TURN relay, direct links only', e);
    return [];
  }
}

export async function connectTrystero(
  roomCode: string,
  firebaseApp: FirebaseApp,
  databaseURL: string
): Promise<Transport> {
  const relays = await relayServers();
  const room = joinRoom(
    {
      appId: databaseURL,
      relayConfig: { firebaseApp, firebasePath: 'signal' },
      rtcConfig: { iceServers: [{ urls: STUN_URL }, ...relays], ...(RELAY_ONLY ? { iceTransportPolicy: 'relay' as const } : {}) }
    },
    roomCode,
    // without this a link that never comes up fails silently on both sides
    { onJoinError: e => log.warn('peer link failed', { peerId: e.peerId, error: e.error }) }
  );

  log.info('joined signalling room', { roomCode, selfId, relay: relays.length > 0, relayOnly: RELAY_ONLY });
  const action = room.makeAction<string>('m');

  // trystero hands the room a single onMessage/onPeerJoin/onPeerLeave slot each;
  // fan those out to our own listener sets so Transport supports multiple subscribers
  const messageCbs = new Set<(data: string, from: string) => void>();
  const joinCbs = new Set<(id: string) => void>();
  const leaveCbs = new Set<(id: string) => void>();

  action.onMessage = (data, { peerId }) => {
    for (const cb of messageCbs) cb(data, peerId);
  };
  room.onPeerJoin = (peerId) => {
    void linkKind(room.getPeers()[peerId]).then(via => log.info('peer joined', { peerId, via }));
    for (const cb of joinCbs) cb(peerId);
  };
  room.onPeerLeave = (peerId) => {
    log.info('peer left', { peerId });
    for (const cb of leaveCbs) cb(peerId);
  };

  return {
    selfId,
    peers: () => Object.keys(room.getPeers()),
    send(data, to) {
      // exactOptionalPropertyTypes: SendOptions.target has no undefined in its type, so an absent `to` must omit the key rather than set it to undefined
      void action.send(data, to === undefined ? {} : { target: to });
    },
    onMessage(cb) {
      messageCbs.add(cb);
      return () => messageCbs.delete(cb);
    },
    onPeerJoin(cb) {
      joinCbs.add(cb);
      return () => joinCbs.delete(cb);
    },
    onPeerLeave(cb) {
      leaveCbs.add(cb);
      return () => leaveCbs.delete(cb);
    },
    leave() {
      void room.leave();
    }
  };
}
