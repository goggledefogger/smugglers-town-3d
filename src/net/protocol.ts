/**
 * The wire protocol: message shapes, plus encode/decode between them and the
 * JSON strings that actually cross the wire. See docs/MULTIPLAYER.md.
 */
import type { GameEventMap } from '../app/events.ts';
import type { VehicleInput } from '../core/physics/vehicleStats.ts';

export type PeerId = string;

/** Client → host, ~30 Hz. Latest seq wins. */
export interface InputMsg { t: 'i'; seq: number; th: number; br: number; st: number; j: boolean; p: number }

export interface BodySnap { id: number; p: [number, number, number]; q: [number, number, number, number]; v: [number, number, number]; d: number; g: 0 | 1 }

/** Host → all, ~20 Hz. */
export interface SnapshotMsg {
  t: 's'; tick: number; timeS: number; timeLeftS: number;
  phase: 'countdown' | 'playing' | 'suddenDeath' | 'gameover';
  scores: [number, number]; carrier: number | null; crate: [number, number, number];
  bodies: BodySnap[];
}

type NetEventName = Exclude<keyof GameEventMap, 'location:changed'>;

/** Host → all, reliable, once per gameplay event. A typed union over GameEventMap minus 'location:changed'. */
export type EventMsg = { [K in NetEventName]: { t: 'e'; name: K; payload: GameEventMap[K] } }[NetEventName];

/** owner null = bot */
export interface RosterEntry { id: number; name: string; team: 0 | 1; vehicle: number; owner: PeerId | null }

/** Host → a joining client: everything needed to build the world. */
export interface HelloMsg {
  t: 'h'; seed: number; map: { kind: 'desert' | 'city'; query?: string }; roster: RosterEntry[];
  /** The host's base positions; clients cannot derive them, their colliders differ. */
  bases: [[number, number, number], [number, number, number]];
}

/** Client → host on connect: which lobby seat this peer is, proven by the seat's token. */
export interface JoinMsg { t: 'j'; uid: string; token: string }

export type NetMsg = InputMsg | SnapshotMsg | EventMsg | HelloMsg | JoinMsg;

const r2 = (n: number): number => Math.round(n * 100) / 100;
const r4 = (n: number): number => Math.round(n * 10000) / 10000;
const roundVec3 = (v: readonly [number, number, number]): [number, number, number] => [r2(v[0]), r2(v[1]), r2(v[2])];
const roundQuat = (q: readonly [number, number, number, number]): [number, number, number, number] =>
  [r4(q[0]), r4(q[1]), r4(q[2]), r4(q[3])];

export function encode(msg: NetMsg): string {
  if (msg.t !== 's') return JSON.stringify(msg);
  const rounded: SnapshotMsg = {
    ...msg,
    crate: roundVec3(msg.crate),
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
const MAP_KINDS = new Set<HelloMsg['map']['kind']>(['desert', 'city']);

function decodeInput(r: Record<string, unknown>): InputMsg | null {
  if (!isInt(r.seq) || r.seq < 0) return null;
  if (!inRange(r.th, 0, 1)) return null;
  if (!inRange(r.br, 0, 1)) return null;
  if (!inRange(r.st, -1, 1)) return null;
  if (typeof r.j !== 'boolean') return null;
  if (!inRange(r.p, -1, 1)) return null;
  return { t: 'i', seq: r.seq, th: r.th, br: r.br, st: r.st, j: r.j, p: r.p };
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

function decodeSnapshot(r: Record<string, unknown>): SnapshotMsg | null {
  if (!isInt(r.tick) || r.tick < 0) return null;
  if (!isNum(r.timeS) || r.timeS < 0) return null;
  if (!isNum(r.timeLeftS) || r.timeLeftS < 0) return null;
  if (typeof r.phase !== 'string' || !PHASES.has(r.phase as SnapshotMsg['phase'])) return null;
  if (!Array.isArray(r.scores) || r.scores.length !== 2 || !r.scores.every(n => isInt(n) && n >= 0)) return null;
  if (r.carrier !== null && (!isInt(r.carrier) || r.carrier < 0)) return null;
  if (!isVec3(r.crate)) return null;
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
    carrier: r.carrier as number | null, crate: r.crate, bodies
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
  if (!isRecord(r.map)) return null;
  if (typeof r.map.kind !== 'string' || !MAP_KINDS.has(r.map.kind as HelloMsg['map']['kind'])) return null;
  let query: string | undefined;
  if (r.map.query !== undefined) {
    if (typeof r.map.query !== 'string') return null;
    query = r.map.query;
  }
  if (!Array.isArray(r.roster)) return null;
  const roster: RosterEntry[] = [];
  for (const e of r.roster) {
    const entry = decodeRosterEntry(e);
    if (!entry) return null;
    roster.push(entry);
  }
  if (!Array.isArray(r.bases) || r.bases.length !== 2 || !isVec3(r.bases[0]) || !isVec3(r.bases[1])) return null;
  const kind = r.map.kind as HelloMsg['map']['kind'];
  const map = query !== undefined ? { kind, query } : { kind };
  return { t: 'h', seed: r.seed, map, roster, bases: [r.bases[0], r.bases[1]] };
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
    default: return null;
  }
}

export function inputToMsg(input: VehicleInput, seq: number): InputMsg {
  return { t: 'i', seq, th: input.throttle, br: input.brake, st: input.steer, j: input.jump, p: input.pitch ?? 0 };
}

export function inputFromMsg(m: InputMsg): VehicleInput {
  return { throttle: m.th, brake: m.br, steer: m.st, jump: m.j, pitch: m.p };
}
