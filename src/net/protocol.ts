/**
 * The wire protocol: message shapes, plus encode/decode between them and the
 * JSON strings that actually cross the wire. See docs/MULTIPLAYER.md.
 */
import type { GameEventMap } from '../app/events.ts';
import type { VehicleInput } from '../core/physics/vehicleStats.ts';

export type PeerId = string;

/**
 * Bumped whenever the hello changes shape or meaning. A host and a client on
 * different builds is the normal case, not an exotic one — the host plays from
 * a dev server while friends join the deployed site — and the failure it caused
 * was silent: a client too old to understand a city map built the desert
 * instead and drove around a different world for the whole match. Better to
 * refuse the match and say why.
 */
export const PROTOCOL_VERSION = 3;

/** Client → host, ~30 Hz. Latest seq wins. */
export interface InputMsg { t: 'i'; seq: number; th: number; br: number; st: number; j: boolean; p: number; hb: boolean }

export interface BodySnap { id: number; p: [number, number, number]; q: [number, number, number, number]; v: [number, number, number]; d: number; g: 0 | 1 }

/** One crate on the wire: id, position, and the body id carrying it. */
export interface CrateSnap { i: number; p: [number, number, number]; c: number | null; d: 0 | 1 }

/** Host → all, ~20 Hz. */
export interface SnapshotMsg {
  t: 's'; tick: number; timeS: number; timeLeftS: number;
  phase: 'countdown' | 'playing' | 'suddenDeath' | 'gameover';
  scores: [number, number]; crates: CrateSnap[];
  bodies: BodySnap[];
}

type NetEventName = Exclude<keyof GameEventMap, 'location:changed'>;

/** Host → all, reliable, once per gameplay event. A typed union over GameEventMap minus 'location:changed'. */
export type EventMsg = { [K in NetEventName]: { t: 'e'; name: K; payload: GameEventMap[K] } }[NetEventName];

/**
 * Where a match is played. A city carries the geocoded centre, not just the
 * search text: every client builds its world from these exact coordinates, so
 * nobody re-geocodes and no two players can land on different Portlands.
 */
export type MatchMap =
  | { kind: 'desert' }
  | { kind: 'city'; query: string; label: string; lat: number; lon: number };

export const MAX_PLACE_LEN = 80;

/**
 * The one map validator. The lobby record and the hello message both cross a
 * trust boundary, so both come through here.
 */
export function decodeMatchMap(v: unknown): MatchMap | null {
  if (!isRecord(v)) return null;
  if (v.kind === 'desert') return { kind: 'desert' };
  if (v.kind !== 'city') return null;
  if (typeof v.query !== 'string' || v.query.length === 0 || v.query.length > MAX_PLACE_LEN) return null;
  if (typeof v.label !== 'string' || v.label.length === 0 || v.label.length > MAX_PLACE_LEN) return null;
  if (!inRange(v.lat, -90, 90) || !inRange(v.lon, -180, 180)) return null;
  return { kind: 'city', query: v.query, label: v.label, lat: v.lat, lon: v.lon };
}

/** owner null = bot */
export interface RosterEntry { id: number; name: string; team: 0 | 1; vehicle: number; owner: PeerId | null }

/** Host → a joining client: everything needed to build the world. */
export interface HelloMsg {
  t: 'h'; v: number; seed: number; map: MatchMap; roster: RosterEntry[];
  /** The host's base positions; clients cannot derive them, their colliders differ. */
  bases: [[number, number, number], [number, number, number]];
  /**
   * The host's Google Maps key, when they chose to share it, so players can
   * load a city without one of their own. Sent per-peer to seats that already
   * proved their token, never broadcast.
   */
  key?: string;
}

/** Client → host on connect: which lobby seat this peer is, proven by the seat's token. */
export interface JoinMsg { t: 'j'; uid: string; token: string }

/**
 * Client → host once its world is built and it can actually play. A city takes
 * tens of seconds to stream, so without this the host starts the clock while a
 * guest is still fetching tiles and that player arrives to a match in progress.
 */
export interface ReadyMsg { t: 'r' }

export type NetMsg = InputMsg | SnapshotMsg | EventMsg | HelloMsg | JoinMsg | ReadyMsg;

const r2 = (n: number): number => Math.round(n * 100) / 100;
const r4 = (n: number): number => Math.round(n * 10000) / 10000;
const roundVec3 = (v: readonly [number, number, number]): [number, number, number] => [r2(v[0]), r2(v[1]), r2(v[2])];
const roundQuat = (q: readonly [number, number, number, number]): [number, number, number, number] =>
  [r4(q[0]), r4(q[1]), r4(q[2]), r4(q[3])];

export function encode(msg: NetMsg): string {
  if (msg.t !== 's') return JSON.stringify(msg);
  const rounded: SnapshotMsg = {
    ...msg,
    crates: msg.crates.map(c => ({ ...c, p: roundVec3(c.p) })),
    bodies: msg.bodies.map(b => ({ ...b, p: roundVec3(b.p), q: roundQuat(b.q), v: roundVec3(b.v) }))
  };
  return JSON.stringify(rounded);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inRange = (v: unknown, lo: number, hi: number): v is number => isNum(v) && v >= lo && v <= hi;
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isTeam = (v: unknown): v is 0 | 1 => v === 0 || v === 1;
const isVec3 = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(isNum);
const isQuat = (v: unknown): v is [number, number, number, number] => Array.isArray(v) && v.length === 4 && v.every(isNum);

const PHASES = new Set<SnapshotMsg['phase']>(['countdown', 'playing', 'suddenDeath', 'gameover']);
function decodeInput(r: Record<string, unknown>): InputMsg | null {
  if (!isInt(r.seq) || r.seq < 0) return null;
  if (!inRange(r.th, 0, 1)) return null;
  if (!inRange(r.br, 0, 1)) return null;
  if (!inRange(r.st, -1, 1)) return null;
  if (typeof r.j !== 'boolean') return null;
  if (typeof r.hb !== 'boolean') return null;
  if (!inRange(r.p, -1, 1)) return null;
  return { t: 'i', seq: r.seq, th: r.th, br: r.br, st: r.st, j: r.j, p: r.p, hb: r.hb };
}

function decodeBody(v: unknown): BodySnap | null {
  if (!isRecord(v)) return null;
  if (!isInt(v.id) || v.id < 0) return null;
  if (!isVec3(v.p)) return null;
  if (!isQuat(v.q)) return null;
  if (!isVec3(v.v)) return null;
  if (!isNum(v.d) || v.d < 0) return null;
  if (v.g !== 0 && v.g !== 1) return null;
  return { id: v.id, p: v.p, q: v.q, v: v.v, d: v.d, g: v.g };
}

/** A wave is four; the cap is only here so a peer cannot flood the decoder. */
const MAX_CRATES = 16;

function decodeCrate(v: unknown): CrateSnap | null {
  if (!isRecord(v)) return null;
  if (!isInt(v.i) || v.i < 0) return null;
  if (!isVec3(v.p)) return null;
  if (v.c !== null && (!isInt(v.c) || v.c < 0)) return null;
  if (v.d !== 0 && v.d !== 1) return null;
  return { i: v.i, p: v.p, c: v.c as number | null, d: v.d };
}

function decodeSnapshot(r: Record<string, unknown>): SnapshotMsg | null {
  if (!isInt(r.tick) || r.tick < 0) return null;
  if (!isNum(r.timeS) || r.timeS < 0) return null;
  if (!isNum(r.timeLeftS) || r.timeLeftS < 0) return null;
  if (typeof r.phase !== 'string' || !PHASES.has(r.phase as SnapshotMsg['phase'])) return null;
  if (!Array.isArray(r.scores) || r.scores.length !== 2 || !r.scores.every(n => isInt(n) && n >= 0)) return null;
  if (!Array.isArray(r.crates) || r.crates.length > MAX_CRATES) return null;
  const crates: CrateSnap[] = [];
  for (const c of r.crates) {
    const snap = decodeCrate(c);
    if (!snap) return null;
    crates.push(snap);
  }
  if (!Array.isArray(r.bodies)) return null;
  const bodies: BodySnap[] = [];
  for (const b of r.bodies) {
    const snap = decodeBody(b);
    if (!snap) return null;
    bodies.push(snap);
  }
  return {
    t: 's', tick: r.tick, timeS: r.timeS, timeLeftS: r.timeLeftS,
    phase: r.phase as SnapshotMsg['phase'], scores: r.scores as [number, number],
    crates, bodies
  };
}

const EVENT_VALIDATORS: { [K in NetEventName]: (p: unknown) => p is GameEventMap[K] } = {
  'contraband:pickup': (p): p is GameEventMap['contraband:pickup'] => isRecord(p) && isInt(p.vehicleId),
  'contraband:stolen': (p): p is GameEventMap['contraband:stolen'] =>
    isRecord(p) && isInt(p.attackerId) && isInt(p.victimId),
  'contraband:delivered': (p): p is GameEventMap['contraband:delivered'] => isRecord(p) && isTeam(p.team),
  'contraband:dropped': (p): p is GameEventMap['contraband:dropped'] => isRecord(p) && isInt(p.vehicleId),
  'vehicle:wrecked': (p): p is GameEventMap['vehicle:wrecked'] => isRecord(p) && isInt(p.vehicleId),
  'match:countdown': (p): p is GameEventMap['match:countdown'] => isRecord(p) && isInt(p.n) && p.n >= 0,
  'match:finalMinute': (p): p is GameEventMap['match:finalMinute'] => isRecord(p) && Object.keys(p).length === 0,
  'match:suddenDeath': (p): p is GameEventMap['match:suddenDeath'] => isRecord(p) && Object.keys(p).length === 0,
  'match:win': (p): p is GameEventMap['match:win'] => isRecord(p) && isTeam(p.team)
};

function decodeEvent(r: Record<string, unknown>): EventMsg | null {
  const name = r.name;
  if (typeof name !== 'string' || !(name in EVENT_VALIDATORS)) return null;
  const validate = EVENT_VALIDATORS[name as NetEventName];
  if (!validate(r.payload)) return null;
  return { t: 'e', name, payload: r.payload } as EventMsg;
}

function decodeRosterEntry(v: unknown): RosterEntry | null {
  if (!isRecord(v)) return null;
  if (!isInt(v.id) || v.id < 0) return null;
  if (typeof v.name !== 'string') return null;
  if (!isTeam(v.team)) return null;
  if (!isInt(v.vehicle) || v.vehicle < 0 || v.vehicle > 4) return null;
  if (v.owner !== null && typeof v.owner !== 'string') return null;
  return { id: v.id, name: v.name, team: v.team, vehicle: v.vehicle, owner: v.owner as string | null };
}

function decodeHello(r: Record<string, unknown>): HelloMsg | null {
  if (!isInt(r.seed)) return null;
  // a host older than versioning sent no v at all: call it 1 and let the
  // caller report the mismatch, rather than dropping the message into a timeout
  const v = isInt(r.v) ? r.v : 1;
  const map = decodeMatchMap(r.map);
  if (!map) return null;
  let key: string | undefined;
  if (r.key !== undefined) {
    if (typeof r.key !== 'string' || r.key.length === 0 || r.key.length > 128) return null;
    key = r.key;
  }
  if (!Array.isArray(r.roster)) return null;
  const roster: RosterEntry[] = [];
  for (const e of r.roster) {
    const entry = decodeRosterEntry(e);
    if (!entry) return null;
    roster.push(entry);
  }
  if (!Array.isArray(r.bases) || r.bases.length !== 2 || !isVec3(r.bases[0]) || !isVec3(r.bases[1])) return null;
  const bases: HelloMsg['bases'] = [r.bases[0], r.bases[1]];
  return key !== undefined
    ? { t: 'h', v, seed: r.seed, map, roster, bases, key }
    : { t: 'h', v, seed: r.seed, map, roster, bases };
}

function decodeJoin(r: Record<string, unknown>): JoinMsg | null {
  if (typeof r.uid !== 'string' || r.uid.length === 0 || r.uid.length > 128) return null;
  if (typeof r.token !== 'string' || r.token.length < 16 || r.token.length > 64) return null;
  return { t: 'j', uid: r.uid, token: r.token };
}

/** Strict: anything malformed returns null. Peers are a trust boundary. */
export function decode(text: unknown): NetMsg | null {
  if (typeof text !== 'string') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  switch (raw.t) {
    case 'i': return decodeInput(raw);
    case 's': return decodeSnapshot(raw);
    case 'e': return decodeEvent(raw);
    case 'h': return decodeHello(raw);
    case 'j': return decodeJoin(raw);
    case 'r': return { t: 'r' };
    default: return null;
  }
}

export function inputToMsg(input: VehicleInput, seq: number): InputMsg {
  return { t: 'i', seq, th: input.throttle, br: input.brake, st: input.steer, j: input.jump, p: input.pitch ?? 0, hb: input.handbrake ?? false };
}

export function inputFromMsg(m: InputMsg): VehicleInput {
  return { throttle: m.th, brake: m.br, steer: m.st, jump: m.j, pitch: m.p, handbrake: m.hb };
}
