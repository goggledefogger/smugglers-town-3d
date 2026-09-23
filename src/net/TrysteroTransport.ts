import type { FirebaseApp } from 'firebase/app';
import { joinRoom, selfId } from '@trystero-p2p/firebase';
import type { Transport } from './Transport.ts';
import { logger } from '../app/log.ts';

const log = logger('rtc');

/** Google's public STUN server; free, no account, enough for peers that aren't both behind symmetric NATs. */
const STUN_URL = 'stun:stun.l.google.com:19302';
/**
 * A TURN relay for players on different networks, where a direct link often
 * cannot get through both routers. JSON RTCIceServer[] from the build env
 * (.env.local, never committed); it ships in the bundle, so use a relay
 * account whose credentials are meant for browsers
 */
// Vite statically replaces import.meta.env.VITE_* at build time.
// Dynamic key access (import.meta.env[key]) does NOT work
const TURN_SERVERS: RTCIceServer[] = JSON.parse(import.meta.env.VITE_TURN_SERVERS || '[]');

export async function connectTrystero(
  roomCode: string,
  firebaseApp: FirebaseApp,
  databaseURL: string
): Promise<Transport> {
  const room = joinRoom(
    {
      appId: databaseURL,
      relayConfig: { firebaseApp, firebasePath: 'signal' },
      rtcConfig: { iceServers: [{ urls: STUN_URL }, ...TURN_SERVERS] }
    },
    roomCode
  );

  log.info('joined signalling room', { roomCode, selfId });
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
    log.info('peer joined', { peerId });
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
