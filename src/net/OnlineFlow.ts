/**
 * The online flow: lobby screen → room → peer connection → a HostSession or
 * a ClientSession running the match. The composition root hands in how to
 * build a terrain and a host game and gets back a `RunningMatch` to render;
 * everything about Firebase, Trystero and the lobby stays in here.
 *
 * A match plays on the seeded desert, or anywhere on Earth. The room record
 * carries the geocoded centre, so every player builds the identical world from
 * the same coordinates rather than each geocoding the text and drifting. The
 * lobby only ever resolves a place; the world itself loads once, at start.
 */
import type { Game, Seat } from '../app/Game.ts';
import type { GameEvents } from '../app/events.ts';
import type { HudSnapshot, Store } from '../app/store.ts';
import type { WorldView } from '../app/WorldView.ts';
import { VEHICLE_TYPES, type VehicleInput } from '../core/physics/vehicleStats.ts';
import type { TerrainProvider } from '../core/terrain/TerrainProvider.ts';
import type { LobbyScreen, CityMap } from '../ui/screens/LobbyScreen.ts';
import { previewPlace } from '../services/relocate.ts';
import { firebaseApp, firebaseConfig, identity, remoteLogSink } from '../services/firebase.ts';
import { attachRemoteLog, dumpLogs, logger } from '../app/log.ts';
import { canStart, createLobby, joinLobby, seatsFor, validateName, type Lobby, type LobbyRoom } from './lobby.ts';
import { connectTrystero } from './TrysteroTransport.ts';
import type { Transport } from './Transport.ts';
import { HostSession } from './HostSession.ts';
import { ClientSession } from './ClientSession.ts';
import { decode, encode, PROTOCOL_VERSION, type HelloMsg, type MatchMap } from './protocol.ts';

export interface RunningMatch {
  readonly world: WorldView;
  readonly seed: number;
  tick(dt: number, input: VehicleInput | null): void;
  dispose(): void;
}

export interface OnlineDeps {
  readonly events: GameEvents;
  readonly store: Store<HudSnapshot>;
  readonly lobbyEl: LobbyScreen;
  /**
   * The world for this match. Async because a city streams elevation, imagery
   * and building tiles; apiKey is null only for a desert.
   */
  makeTerrain(seed: number, map: MatchMap, apiKey: string | null): Promise<TerrainProvider>;
  /** Host only: a fresh, seeded Game on this terrain with these seats, colliders set and the match reset. */
  makeHostGame(seed: number, terrain: TerrainProvider, seats: readonly Seat[]): Game;
  onMatch(match: RunningMatch, terrain: TerrainProvider): void;
  onLeave(): void;
}

/** How long the host holds the countdown for players still connecting. */
const PEER_WAIT_MS = 10000;
/** How long a client waits for the host's hello before giving up. */
const HELLO_WAIT_MS = 20000;
/**
 * How long the host holds the start for players still building their world.
 * A city is tens of seconds of streaming; past this one straggler is not worth
 * everyone else's wait, and they drop into the match when they finish.
 */
const READY_WAIT_MS = 20000;
/** How long a loaded client waits for the host to actually begin. */
const START_WAIT_MS = 25000;
const NAME_KEY = 'stt_name';
/** The same slot the single-player relocate bar uses, so a key is pasted once. */
const MAPS_KEY = 'gmap_key';
const log = logger('online');

export class OnlineFlow {
  private lobby: Lobby | null = null;
  private unsubRoom: (() => void) | null = null;
  private vehicle = 2;
  private starting = false;
  /** This browser's Maps key: pasted here, remembered from the relocate bar, or handed over by the host. */
  private mapsKey: string | null = null;

  constructor(private readonly deps: OnlineDeps) {
    const el = deps.lobbyEl;
    el.addEventListener('lobby-create', e => {
      const d = (e as CustomEvent<{ name: string; map: MatchMap; shareKey: boolean }>).detail;
      void this.create(d.name, d.map, d.shareKey);
    });
    el.addEventListener('lobby-check', e => {
      const d = (e as CustomEvent<{ query: string; key: string }>).detail;
      void this.checkPlace(d.query, d.key);
    });
    el.addEventListener('lobby-key', e => {
      this.useKey((e as CustomEvent<{ key: string }>).detail.key);
      el.status = '';
    });
    el.addEventListener('lobby-join', e => {
      const d = (e as CustomEvent<{ code: string; name: string }>).detail;
      void this.join(d.code, d.name);
    });
    el.addEventListener('lobby-ready', e => void this.lobby?.setReady((e as CustomEvent<{ ready: boolean }>).detail.ready));
    el.addEventListener('lobby-vehicle', e => {
      this.vehicle = (e as CustomEvent<{ vehicle: number }>).detail.vehicle;
      el.vehicle = this.vehicle;
      void this.lobby?.setVehicle(this.vehicle);
    });
    el.addEventListener('lobby-team', e => void this.lobby?.setTeam((e as CustomEvent<{ team: 0 | 1 }>).detail.team));
    el.addEventListener('lobby-start', () => void this.hostStart());
    el.addEventListener('lobby-leave', () => void this.leave());
    el.addEventListener('lobby-back', () => {
      void this.leave();
      el.hidden = true;
      deps.onLeave();
    });
    el.addEventListener('lobby-logs', () => {
      navigator.clipboard.writeText(dumpLogs()).then(
        () => { el.status = 'Debug log copied; paste it to whoever is looking into it'; },
        () => { el.status = 'Could not copy; run stt.dump() in the browser console'; }
      );
    });
  }

  private remoteLogs = false;

  /** Ship logs to the database once signed in, buffered entries included. */
  private enableRemoteLogs(): void {
    if (this.remoteLogs) return;
    this.remoteLogs = true;
    identity().then(uid => attachRemoteLog(remoteLogSink(uid))).catch(err => log.error('remote log unavailable', err));
  }

  /** Remember a key for this browser and tell the screen it has one. */
  private useKey(key: string): void {
    this.mapsKey = key;
    write(MAPS_KEY, key);
    this.deps.lobbyEl.hasKey = true;
  }

  /**
   * Resolve a place for the room. One geocode and one thumbnail: nothing of
   * the world loads here, so trying five cities costs five lookups.
   */
  private async checkPlace(query: string, key: string): Promise<void> {
    const el = this.deps.lobbyEl;
    el.checking = true;
    el.mapStatus = '';
    try {
      const { map, thumbnailUrl } = await previewPlace(query, key);
      this.useKey(key);
      el.place = map as CityMap;
      el.thumbnailUrl = thumbnailUrl;
      log.info('place checked', { label: map.label, lat: map.lat, lon: map.lon });
    } catch (err) {
      log.error('place check failed', err);
      el.place = null;
      el.thumbnailUrl = '';
      el.mapStatus = describePlace(err);
    } finally {
      el.checking = false;
    }
  }

  /** Show the lobby with the garage's vehicle pick. */
  open(vehicle: number): void {
    const el = this.deps.lobbyEl;
    this.vehicle = vehicle;
    el.vehicle = vehicle;
    el.defaultName = read(NAME_KEY) ?? '';
    this.mapsKey = read(MAPS_KEY);
    el.defaultKey = this.mapsKey ?? '';
    el.hasKey = this.mapsKey !== null && this.mapsKey.length > 0;
    el.mapKind = 'desert';
    el.place = null;
    el.thumbnailUrl = '';
    el.mapStatus = '';
    el.status = '';
    el.busy = false;
    el.room = null;
    el.hidden = false;
    log.info('lobby opened', { vehicle, hasKey: el.hasKey });
    this.enableRemoteLogs();
  }

  private async create(rawName: string, map: MatchMap, shareKey: boolean): Promise<void> {
    const name = validateName(rawName);
    write(NAME_KEY, name);
    await this.busy('Creating a room', () => createLobby(name, this.vehicle, map, shareKey));
  }

  private async join(code: string, rawName: string): Promise<void> {
    const name = validateName(rawName);
    write(NAME_KEY, name);
    await this.busy('Joining', () => joinLobby(code.trim().toUpperCase(), name, this.vehicle));
  }

  private async busy(what: string, work: () => Promise<Lobby>): Promise<void> {
    const el = this.deps.lobbyEl;
    el.busy = true;
    el.status = `${what}…`;
    log.info(what);
    try {
      this.attach(await work());
      el.status = '';
    } catch (err) {
      log.error(`${what} failed`, err);
      el.status = describe(err);
    } finally {
      el.busy = false;
    }
  }

  private attach(lobby: Lobby): void {
    this.detach();
    this.lobby = lobby;
    const el = this.deps.lobbyEl;
    el.selfId = lobby.selfId;
    this.unsubRoom = lobby.subscribe(room => {
      el.room = room;
      el.canStart = room ? canStart(room, lobby.selfId) : false;
      if (!room) {
        if (this.lobby === lobby && !this.starting) {
          el.status = 'The room closed';
          this.detach();
        }
        return;
      }
      if (room.phase === 'playing' && !lobby.isHost && !this.starting) {
        this.starting = true;
        void this.runClient(lobby, room);
      }
    });
  }

  private detach(): void {
    this.unsubRoom?.();
    this.unsubRoom = null;
    this.lobby = null;
    this.deps.lobbyEl.room = null;
  }

  private async leave(): Promise<void> {
    const lobby = this.lobby;
    this.detach();
    this.deps.lobbyEl.status = '';
    await lobby?.leave().catch(() => undefined);
  }

  private async hostStart(): Promise<void> {
    const lobby = this.lobby;
    const room = lobby?.room();
    if (!lobby || !room || !lobby.isHost || this.starting) return;
    this.starting = true;
    const el = this.deps.lobbyEl;
    el.busy = true;
    try {
      const seed = (Math.random() * 2 ** 32) >>> 0;
      await lobby.start(seed);
      await this.runHost(lobby, room, seed);
    } catch (err) {
      el.status = describe(err);
      el.busy = false;
      this.starting = false;
    }
  }

  private async runHost(lobby: Lobby, room: LobbyRoom, seed: number): Promise<void> {
    const el = this.deps.lobbyEl;
    el.status = 'Connecting players…';
    const tokens = await lobby.tokens();
    const transport = await connect(room.code);
    const host = new HostSession(transport, this.deps.events, tokens);
    const others = Object.keys(room.players).filter(u => u !== lobby.selfId);
    const missing = await host.waitForPeers(others, PEER_WAIT_MS);
    log.info('host peers', { expected: others.length, missing });
    if (missing.length > 0) el.status = `${missing.length} player(s) did not connect; their seats go to bots`;
    const seats = seatsFor(room, lobby.selfId, missing);
    el.status = room.map.kind === 'city' ? `Loading ${room.map.label}…` : 'Building the world…';
    const terrain = await this.deps.makeTerrain(seed, room.map, this.mapsKey);
    const game = this.deps.makeHostGame(seed, terrain, seats);
    const hello: Omit<HelloMsg, 't'> = {
      v: PROTOCOL_VERSION,
      seed,
      map: room.map,
      // only to seats that already proved their token, and only if the host said so
      ...(room.keyShared && this.mapsKey ? { key: this.mapsKey } : {}),
      roster: game.vehicles.map(a => ({
        id: a.body.id,
        name: a.control === 'local' ? room.players[lobby.selfId]?.name ?? 'Host' : a.label,
        team: a.team,
        vehicle: Math.max(0, VEHICLE_TYPES.indexOf(a.body.stats)),
        owner: a.control === 'bot' ? null : a.control === 'local' ? lobby.selfId : a.control
      })),
      bases: [vec(game.state.bases[0]), vec(game.state.bases[1])]
    };
    host.start(game, hello);
    // everyone builds their own city from Google; starting now would drop the
    // slow ones into a match already in progress
    const expected = others.filter(u => !missing.includes(u));
    if (expected.length > 0) {
      el.status = 'Waiting for players to load the map…';
      const slow = await host.waitForReady(expected, READY_WAIT_MS);
      log.info('ready barrier', { expected: expected.length, slow });
      if (slow.length > 0) el.status = `${slow.length} player(s) still loading; they will join once ready`;
    }
    this.finish(lobby, {
      world: game,
      seed,
      tick: (dt, input) => host.update(dt, input),
      dispose: () => host.dispose()
    }, terrain);
  }

  private async runClient(lobby: Lobby, room: LobbyRoom): Promise<void> {
    const el = this.deps.lobbyEl;
    try {
      el.busy = true;
      el.status = 'Connecting to the host…';
      const transport = await connect(room.code);
      // the host learns which seat we are from this; repeat it to every peer
      // that appears, since the host may connect after us
      const join = encode({ t: 'j', uid: lobby.selfId, token: lobby.token });
      transport.send(join);
      transport.onPeerJoin(() => transport.send(join));
      // the room already names the place and the seed, so start building the
      // world now rather than after the hello: otherwise the host's load and
      // ours run back to back and a city takes twice as long to reach
      const early = room.map.kind === 'desert' || this.mapsKey
        ? this.deps.makeTerrain(room.seed, room.map, this.mapsKey).catch(() => null)
        : null;
      el.status = 'Waiting for the host…';
      log.info('client connected, waiting for hello', { code: room.code, headStart: early !== null });
      const hello = await waitHello(transport, HELLO_WAIT_MS);
      log.info('hello', { v: hello.v, seed: hello.seed, roster: hello.roster.length, map: hello.map.kind, sharedKey: hello.key !== undefined });
      if (hello.v !== PROTOCOL_VERSION) throw new Error('version-mismatch');
      if (hello.key) this.useKey(hello.key);
      if (hello.map.kind === 'city' && !this.mapsKey) throw new Error('no-maps-key');
      el.status = hello.map.kind === 'city' ? `Loading ${hello.map.label}…` : 'Building the world…';
      // the head start is only usable if the host is running the world we bet on
      const headStart = hello.seed === room.seed && sameMap(hello.map, room.map) ? await early : null;
      const terrain = headStart ?? await this.deps.makeTerrain(hello.seed, hello.map, this.mapsKey);
      // tell the host we can play, then wait for it to actually begin, so we
      // do not sit in an empty world while a slower player finishes loading
      transport.send(encode({ t: 'r' }));
      el.status = 'Waiting for the other players…';
      await waitFirstSnapshot(transport, START_WAIT_MS);
      const client = new ClientSession(hello, lobby.selfId, transport, this.deps.events, this.deps.store, terrain);
      this.finish(lobby, {
        world: client,
        seed: hello.seed,
        tick: (dt, input) => client.update(dt, input),
        dispose: () => client.dispose()
      }, terrain);
    } catch (err) {
      log.error('client start failed', err);
      el.status = describe(err);
      el.busy = false;
      this.starting = false;
      await this.leave();
    }
  }

  private finish(lobby: Lobby, match: RunningMatch, terrain: TerrainProvider): void {
    this.unsubRoom?.();
    this.unsubRoom = null;
    this.lobby = null;
    this.starting = false;
    const el = this.deps.lobbyEl;
    el.busy = false;
    el.hidden = true;
    const dispose = match.dispose;
    this.deps.onMatch({
      ...match,
      dispose: () => {
        dispose();
        void lobby.leave().catch(() => undefined);
      }
    }, terrain);
  }
}


async function connect(code: string): Promise<Transport> {
  return connectTrystero(code, await firebaseApp(), firebaseConfig.databaseURL);
}

const sameMap = (a: MatchMap, b: MatchMap): boolean =>
  a.kind === b.kind && (a.kind !== 'city' || b.kind !== 'city' || (a.lat === b.lat && a.lon === b.lon));

/**
 * Resolve on the host's first snapshot, or give up and enter anyway — a match
 * that never starts is worse than one entered a moment early.
 */
function waitFirstSnapshot(transport: Transport, timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    const done = (): void => {
      clearTimeout(timer);
      off();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const off = transport.onMessage(data => {
      const m = decode(data);
      if (m && m.t === 's') done();
    });
  });
}

function waitHello(transport: Transport, timeoutMs: number): Promise<HelloMsg> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('The host never answered'));
    }, timeoutMs);
    const off = transport.onMessage(data => {
      const m = decode(data);
      if (!m || m.t !== 'h') return;
      clearTimeout(timer);
      off();
      resolve(m);
    });
  });
}

const vec = (v: { x: number; y: number; z: number }): [number, number, number] => [v.x, v.y, v.z];

function describe(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  switch (msg) {
    case 'not-found': return 'No room with that code';
    case 'full': return 'That room is full';
    case 'started': return 'That match already started; ask the host for a new room after it ends';
    case 'self-host': return 'That is your own room: this browser is signed in as its host. Join from another browser profile or device';
    case 'no-maps-key': return 'This room plays in a real city and needs a Google Maps key';
    case 'version-mismatch': return 'The host is running a different version of the game. Both of you reload the page and try again';
    default: return msg;
  }
}

/** Google's failures are opaque; name the one that is almost always the cause. */
function describePlace(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('ZERO_RESULTS')) return 'No such place — try adding a city or country';
  if (msg.includes('REQUEST_DENIED')) {
    // the JS API binds its key at script load, so a new key needs a fresh page
    return 'That key was refused. Enable the Geocoding API and check its restrictions, then reload the page before trying another key';
  }
  if (msg.includes('OVER_QUERY_LIMIT')) return 'That key is over its query limit';
  return msg;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode: the name just does not stick
  }
}
