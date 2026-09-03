import { describe, it, expect } from 'vitest';
import { mulberry32 } from '../src/core/rng.ts';
import {
  makeRoomCode, assignTeam, canStart, parseRoom, validateName,
  MAX_PLAYERS, ROOM_CODE_ALPHABET, type LobbyRoom, type LobbyPlayer, type Team
} from '../src/net/lobby.ts';

function player(overrides: Partial<LobbyPlayer> = {}): LobbyPlayer {
  return { name: 'Driver', vehicle: 0, team: 0 as Team, ready: false, joinedAt: 0, ...overrides };
}

function room(overrides: Partial<LobbyRoom> = {}): LobbyRoom {
  return {
    code: 'ABCD', host: 'host-uid', createdAt: 1, phase: 'lobby', seed: 0,
    map: { kind: 'desert' }, keyShared: false, players: { 'host-uid': player() }, ...overrides
  };
}

describe('makeRoomCode', () => {
  it('is 4 characters, all from the alphabet', () => {
    const code = makeRoomCode(mulberry32(1));
    expect(code).toHaveLength(4);
    for (const ch of code) expect(ROOM_CODE_ALPHABET).toContain(ch);
  });

  it('is deterministic from a seeded rng', () => {
    expect(makeRoomCode(mulberry32(42))).toBe(makeRoomCode(mulberry32(42)));
  });

  it('differs across seeds (overwhelmingly likely)', () => {
    expect(makeRoomCode(mulberry32(1))).not.toBe(makeRoomCode(mulberry32(2)));
  });
});

describe('assignTeam', () => {
  it('picks 0 when empty (a tie)', () => {
    expect(assignTeam({})).toBe(0);
  });

  it('picks the smaller team', () => {
    const players = { a: player({ team: 0 }), b: player({ team: 0 }), c: player({ team: 1 }) };
    expect(assignTeam(players)).toBe(1);
  });

  it('picks 0 on a tie', () => {
    const players = { a: player({ team: 0 }), b: player({ team: 1 }) };
    expect(assignTeam(players)).toBe(0);
  });
});

describe('canStart', () => {
  it('true for the host alone in the lobby', () => {
    expect(canStart(room(), 'host-uid')).toBe(true);
  });

  it('false for a non-host', () => {
    expect(canStart(room(), 'someone-else')).toBe(false);
  });

  it('false once playing', () => {
    expect(canStart(room({ phase: 'playing' }), 'host-uid')).toBe(false);
  });

  it('false while a guest is not ready', () => {
    const r = room({ players: { 'host-uid': player(), guest: player({ ready: false }) } });
    expect(canStart(r, 'host-uid')).toBe(false);
  });

  it('true once every guest is ready (host need not be)', () => {
    const r = room({ players: { 'host-uid': player({ ready: false }), guest: player({ ready: true }) } });
    expect(canStart(r, 'host-uid')).toBe(true);
  });
});

describe('parseRoom', () => {
  it('accepts a valid snapshot', () => {
    const raw = {
      host: 'host-uid', createdAt: 1, phase: 'lobby', seed: 7,
      map: { kind: 'city', query: 'Portland', label: 'Portland, OR, USA', lat: 45.5152, lon: -122.6784 },
      keyShared: true,
      players: { 'host-uid': { name: 'Ann', vehicle: 2, team: 1, ready: true, joinedAt: 5 } }
    };
    expect(parseRoom(raw, 'WXYZ')).toEqual({ code: 'WXYZ', ...raw });
  });

  it('accepts a desert map, and treats a missing keyShared as not shared', () => {
    const raw = { host: 'h', createdAt: 1, phase: 'lobby', seed: 0, map: { kind: 'desert' }, players: {} };
    expect(parseRoom(raw, 'ABCD')?.map).toEqual({ kind: 'desert' });
    expect(parseRoom(raw, 'ABCD')?.keyShared).toBe(false);
  });

  it('rejects a city room that never resolved its centre', () => {
    // without lat/lon two players would geocode the text separately and could
    // land in different places; the room is unusable, not merely incomplete
    const raw = {
      host: 'h', createdAt: 1, phase: 'lobby', seed: 0,
      map: { kind: 'city', query: 'Portland' }, players: {}
    };
    expect(parseRoom(raw, 'ABCD')).toBeNull();
  });

  it('rejects a non-object', () => {
    expect(parseRoom(null, 'ABCD')).toBeNull();
    expect(parseRoom('nope', 'ABCD')).toBeNull();
    expect(parseRoom(42, 'ABCD')).toBeNull();
  });

  it('rejects a missing host', () => {
    const raw = { createdAt: 1, phase: 'lobby', seed: 0, map: { kind: 'desert' }, players: {} };
    expect(parseRoom(raw, 'ABCD')).toBeNull();
  });

  it('rejects a bad phase', () => {
    const raw = { host: 'h', createdAt: 1, phase: 'starting', seed: 0, map: { kind: 'desert' }, players: {} };
    expect(parseRoom(raw, 'ABCD')).toBeNull();
  });

  it('rejects a vehicle out of range', () => {
    const raw = {
      host: 'h', createdAt: 1, phase: 'lobby', seed: 0, map: { kind: 'desert' },
      players: { h: { name: 'Ann', vehicle: 5, team: 0, ready: false, joinedAt: 0 } }
    };
    expect(parseRoom(raw, 'ABCD')).toBeNull();
  });

  it('rejects a player field of the wrong type', () => {
    const raw = {
      host: 'h', createdAt: 1, phase: 'lobby', seed: 0, map: { kind: 'desert' },
      players: { h: { name: 'Ann', vehicle: 0, team: 0, ready: 'yes', joinedAt: 0 } }
    };
    expect(parseRoom(raw, 'ABCD')).toBeNull();
  });

  it('rejects a room whose kind is neither desert nor city', () => {
    const raw = { host: 'h', createdAt: 1, phase: 'lobby', seed: 0, map: { kind: 'moon' }, players: {} };
    expect(parseRoom(raw, 'ABCD')).toBeNull();
  });
});

describe('validateName', () => {
  it('keeps a normal name', () => {
    expect(validateName('Ann')).toBe('Ann');
  });

  it('trims whitespace', () => {
    expect(validateName('  Ann  ')).toBe('Ann');
  });

  it('falls back to Driver when empty', () => {
    expect(validateName('')).toBe('Driver');
    expect(validateName('   ')).toBe('Driver');
  });

  it('truncates to 24 characters', () => {
    const long = 'x'.repeat(40);
    expect(validateName(long)).toHaveLength(24);
  });
});

describe('MAX_PLAYERS', () => {
  it('is 8', () => {
    expect(MAX_PLAYERS).toBe(8);
  });
});
