/**
 * Room create / join / presence over the Realtime Database. See the Lobby
 * section of docs/MULTIPLAYER.md for the layout this mirrors.
 */
import {
  getDatabase, ref, get, update, set, onValue, onDisconnect, runTransaction,
  type Database
} from 'firebase/database';
import { firebaseApp, identity } from '../services/firebase.ts';
import { logger } from '../app/log.ts';

const log = logger('lobby');

export type Team = 0 | 1;

export interface LobbyPlayer {
  name: string;
  vehicle: number;
  team: Team;
  ready: boolean;
  joinedAt: number;
}

export interface LobbyRoom {
  code: string;
  host: string;
  createdAt: number;
  phase: 'lobby' | 'playing';
  seed: number;
  map: { kind: 'desert' | 'city'; query?: string };
  players: Record<string, LobbyPlayer>;
}

export interface Lobby {
  readonly code: string;
  readonly selfId: string;
  readonly isHost: boolean;
  room(): LobbyRoom | null;
  /** Fires with the current value immediately, then on change; null once the room is gone. */
  subscribe(cb: (room: LobbyRoom | null) => void): () => void;
  setReady(ready: boolean): Promise<void>;
  setVehicle(vehicle: number): Promise<void>;
  setTeam(team: Team): Promise<void>;
  /** Host only: phase → 'playing', seed written. */
  start(seed: number): Promise<void>;
  /**
   * A secret only this player and the host can read; the host demands it in
   * the join message, which binds a transport peer to an authenticated seat.
   */
  readonly token: string;
  /** Host only: every player's token, keyed by uid. */
  tokens(): Promise<Record<string, string>>;
  /** Host leaving deletes the room. */
  leave(): Promise<void>;
}

export const MAX_PLAYERS = 8;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeRoomCode(rng: () => number): string {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += ROOM_CODE_ALPHABET.charAt(Math.floor(rng() * ROOM_CODE_ALPHABET.length));
  }
  return code;
}

/** The team with fewer players; 0 on a tie. */
export function assignTeam(players: Record<string, LobbyPlayer>): Team {
  let count0 = 0;
  let count1 = 0;
  for (const p of Object.values(players)) {
    if (p.team === 0) count0++;
    else count1++;
  }
  return count0 <= count1 ? 0 : 1;
}

/** Host, phase lobby, every non-host player ready — the host alone may start. */
export function canStart(room: LobbyRoom, selfId: string): boolean {
  if (room.host !== selfId || room.phase !== 'lobby') return false;
  for (const [uid, p] of Object.entries(room.players)) {
    if (uid !== room.host && !p.ready) return false;
  }
  return true;
}

export function validateName(name: string): string {
  const trimmed = name.trim().slice(0, 24);
  return trimmed.length > 0 ? trimmed : 'Driver';
}

/** Strict validation of a database snapshot — peers write this data. */
export function parseRoom(raw: unknown, code: string): LobbyRoom | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['host'] !== 'string' || r['host'].length === 0) return null;
  if (typeof r['createdAt'] !== 'number') return null;
  if (r['phase'] !== 'lobby' && r['phase'] !== 'playing') return null;
  if (typeof r['seed'] !== 'number') return null;
  const map = parseMap(r['map']);
  if (!map) return null;
  const players = parsePlayers(r['players']);
  if (!players) return null;
  return { code, host: r['host'], createdAt: r['createdAt'], phase: r['phase'], seed: r['seed'], map, players };
}

function parseMap(raw: unknown): LobbyRoom['map'] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (m['kind'] !== 'desert' && m['kind'] !== 'city') return null;
  if (m['query'] === undefined) return { kind: m['kind'] };
  if (typeof m['query'] !== 'string' || m['query'].length > 80) return null;
  return { kind: m['kind'], query: m['query'] };
}

function parsePlayers(raw: unknown): Record<string, LobbyPlayer> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out: Record<string, LobbyPlayer> = {};
  for (const [uid, v] of Object.entries(raw as Record<string, unknown>)) {
    const p = parsePlayer(v);
    if (!p) return null;
    out[uid] = p;
  }
  return out;
}

function parsePlayer(raw: unknown): LobbyPlayer | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p['name'] !== 'string' || p['name'].length === 0 || p['name'].length > 24) return null;
  if (typeof p['vehicle'] !== 'number' || p['vehicle'] < 0 || p['vehicle'] > 4) return null;
  if (p['team'] !== 0 && p['team'] !== 1) return null;
  if (typeof p['ready'] !== 'boolean') return null;
  if (typeof p['joinedAt'] !== 'number') return null;
  return { name: p['name'], vehicle: p['vehicle'], team: p['team'], ready: p['ready'], joinedAt: p['joinedAt'] };
}

class LobbyImpl implements Lobby {
  readonly code: string;
  readonly selfId: string;
  readonly isHost: boolean;
  private readonly database: Database;
  private current: LobbyRoom | null = null;
  private loaded = false;
  private readonly listeners = new Set<(room: LobbyRoom | null) => void>();
  private readonly stopListening: () => void;
  /** Resolves with the first snapshot, so a caller never sees "no room" that merely means "not loaded yet". */
  readonly ready: Promise<void>;

  readonly token: string;

  constructor(code: string, selfId: string, isHost: boolean, database: Database, token: string) {
    this.code = code;
    this.selfId = selfId;
    this.isHost = isHost;
    this.database = database;
    this.token = token;
    let first: () => void = () => undefined;
    this.ready = new Promise<void>(resolve => { first = resolve; });
    this.stopListening = onValue(ref(database, `rooms/${code}`), snapshot => {
      this.current = parseRoom(snapshot.val(), code);
      this.loaded = true;
      first();
      for (const cb of this.listeners) cb(this.current);
    });
  }

  room(): LobbyRoom | null {
    return this.current;
  }

  subscribe(cb: (room: LobbyRoom | null) => void): () => void {
    this.listeners.add(cb);
    if (this.loaded) cb(this.current);
    return () => this.listeners.delete(cb);
  }

  async setReady(ready: boolean): Promise<void> {
    await update(this.selfRef(), { ready });
  }

  async setVehicle(vehicle: number): Promise<void> {
    await update(this.selfRef(), { vehicle });
  }

  async setTeam(team: Team): Promise<void> {
    await update(this.selfRef(), { team });
  }

  async start(seed: number): Promise<void> {
    if (!this.isHost) throw new Error('not-host');
    await update(ref(this.database, `rooms/${this.code}`), { phase: 'playing', seed });
  }

  async tokens(): Promise<Record<string, string>> {
    const snap = await get(ref(this.database, `tokens/${this.code}`));
    const raw: unknown = snap.val();
    const out: Record<string, string> = {};
    if (typeof raw === 'object' && raw !== null) {
      for (const [uid, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string') out[uid] = v;
    }
    return out;
  }

  async leave(): Promise<void> {
    this.stopListening();
    await set(ref(this.database, `tokens/${this.code}/${this.selfId}`), null).catch(() => undefined);
    if (this.isHost) await set(ref(this.database, `rooms/${this.code}`), null);
    else await set(this.selfRef(), null);
  }

  private selfRef() {
    return ref(this.database, `rooms/${this.code}/players/${this.selfId}`);
  }
}

export async function createLobby(name: string, vehicle: number, map: LobbyRoom['map']): Promise<Lobby> {
  const database = getDatabase(await firebaseApp());
  const selfId = await identity();
  const player: LobbyPlayer = { name: validateName(name), vehicle, team: 0, ready: false, joinedAt: Date.now() };
  const newRoom = { host: selfId, createdAt: Date.now(), phase: 'lobby', seed: 0, map, players: { [selfId]: player } };

  for (let attempt = 0; attempt < 10; attempt++) {
    const code = makeRoomCode(Math.random);
    const roomRef = ref(database, `rooms/${code}`);
    const result = await runTransaction(roomRef, current => (current === null ? newRoom : undefined))
      .catch(() => ({ committed: false }));
    if (!result.committed) continue; // code already taken, try another

    const token = await claimToken(database, code, selfId);
    log.info('created', { code, uid: selfId });
    await onDisconnect(roomRef).remove();
    await onDisconnect(ref(database, `rooms/${code}/players/${selfId}`)).remove();
    const lobby = new LobbyImpl(code, selfId, true, database, token);
    await lobby.ready;
    return lobby;
  }
  throw new Error('could not allocate a room code');
}

export async function joinLobby(code: string, name: string, vehicle: number): Promise<Lobby> {
  const database = getDatabase(await firebaseApp());
  const selfId = await identity();
  log.info('join', { code, uid: selfId });
  const raw: unknown = (await get(ref(database, `rooms/${code}`))).val();
  const room = parseRoom(raw, code);
  log.info('room', room ? { phase: room.phase, players: Object.keys(room.players).length, host: room.host } : { raw: raw === null ? null : 'unparseable' });
  if (!room) throw new Error('not-found');
  // two tabs of one browser share the anonymous sign-in: that is the host trying to join itself
  if (room.host === selfId) throw new Error('self-host');
  if (room.phase !== 'lobby') throw new Error('started');
  if (!(selfId in room.players) && Object.keys(room.players).length >= MAX_PLAYERS) throw new Error('full');
  // only this seat is written: the rules let a player write nothing else in
  // the room, and refuse a new seat once the match has started
  const player: LobbyPlayer = {
    name: validateName(name), vehicle, team: assignTeam(room.players), ready: false, joinedAt: Date.now()
  };
  const seatRef = ref(database, `rooms/${code}/players/${selfId}`);
  try {
    await set(seatRef, player);
  } catch (err) {
    log.warn('seat write refused', err);
    throw new Error('started');
  }
  log.info('seated', { code, team: player.team });
  const token = await claimToken(database, code, selfId);
  await onDisconnect(seatRef).remove();
  const lobby = new LobbyImpl(code, selfId, false, database, token);
  await lobby.ready;
  return lobby;
}

/** Write a fresh secret under tokens/$code/$uid, readable only by its owner and the host. */
async function claimToken(database: Database, code: string, uid: string): Promise<string> {
  const token = crypto.randomUUID();
  const tokenRef = ref(database, `tokens/${code}/${uid}`);
  await set(tokenRef, token);
  await onDisconnect(tokenRef).remove();
  return token;
}
