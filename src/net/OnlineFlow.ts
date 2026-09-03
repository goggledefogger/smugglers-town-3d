/**
 * The online flow: lobby screen → room → peer connection → a HostSession or
 * a ClientSession running the match. The composition root hands in how to
 * build a terrain and a host game and gets back a `RunningMatch` to render;
 * everything about Firebase, Trystero and the lobby stays in here.
 *
 * Version 1 plays on the desert only: the seed rebuilds the same dunes and
 * the same rocks on every machine, so nobody needs a Maps key to join.
 */
import { config } from '../app/config.ts';
import type { Game, Seat } from '../app/Game.ts';
import type { GameEvents } from '../app/events.ts';
import type { HudSnapshot, Store } from '../app/store.ts';
import type { WorldView } from '../app/WorldView.ts';
import { VEHICLE_TYPES, type VehicleInput } from '../core/physics/vehicleStats.ts';
import type { TerrainProvider } from '../core/terrain/TerrainProvider.ts';
import type { LobbyScreen } from '../ui/screens/LobbyScreen.ts';
import { firebaseApp, firebaseConfig } from '../services/firebase.ts';
import { canStart, createLobby, joinLobby, validateName, type Lobby, type LobbyRoom } from './lobby.ts';
import { connectTrystero } from './TrysteroTransport.ts';
import type { Transport } from './Transport.ts';
import { HostSession } from './HostSession.ts';
import { ClientSession } from './ClientSession.ts';
import { decode, encode, type HelloMsg } from './protocol.ts';

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
  makeTerrain(seed: number): TerrainProvider;
  /** Host only: a fresh, seeded Game on this terrain with these seats, colliders set and the match reset. */
  makeHostGame(seed: number, terrain: TerrainProvider, seats: readonly Seat[]): Game;
  onMatch(match: RunningMatch, terrain: TerrainProvider): void;
  onLeave(): void;
}

/** How long the host holds the countdown for players still connecting. */
const PEER_WAIT_MS = 10000;
/** How long a client waits for the host's hello before giving up. */
const HELLO_WAIT_MS = 20000;
const NAME_KEY = 'stt_name';

export class OnlineFlow {
  private lobby: Lobby | null = null;
  private unsubRoom: (() => void) | null = null;
  private vehicle = 2;
  private starting = false;

  constructor(private readonly deps: OnlineDeps) {
    const el = deps.lobbyEl;
    el.addEventListener('lobby-create', e => void this.create((e as CustomEvent<{ name: string }>).detail.name));
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
  }

  /** Show the lobby with the garage's vehicle pick. */
  open(vehicle: number): void {
    const el = this.deps.lobbyEl;
    this.vehicle = vehicle;
    el.vehicle = vehicle;
    el.defaultName = read(NAME_KEY) ?? '';
    el.status = '';
    el.busy = false;
    el.room = null;
    el.hidden = false;
  }

  private async create(rawName: string): Promise<void> {
    const name = validateName(rawName);
    write(NAME_KEY, name);
    await this.busy('Creating a room', () => createLobby(name, this.vehicle, { kind: 'desert' }));
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
    try {
      this.attach(await work());
      el.status = '';
    } catch (err) {
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
    const transport = await connect(room.code);
    const host = new HostSession(transport, this.deps.events);
    const others = Object.keys(room.players).filter(u => u !== lobby.selfId);
    const missing = await host.waitForPeers(others, PEER_WAIT_MS);
    if (missing.length > 0) el.status = `${missing.length} player(s) did not connect; their seats go to bots`;
    const seats = seatsFor(room, lobby.selfId, missing);
    const terrain = this.deps.makeTerrain(seed);
    const game = this.deps.makeHostGame(seed, terrain, seats);
    const hello: Omit<HelloMsg, 't'> = {
      seed,
      map: room.map,
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
      const join = encode({ t: 'j', uid: lobby.selfId });
      transport.send(join);
      transport.onPeerJoin(() => transport.send(join));
      el.status = 'Waiting for the host…';
      const hello = await waitHello(transport, HELLO_WAIT_MS);
      const terrain = this.deps.makeTerrain(hello.seed);
      const client = new ClientSession(hello, lobby.selfId, transport, this.deps.events, this.deps.store, terrain);
      this.finish(lobby, {
        world: client,
        seed: hello.seed,
        tick: (dt, input) => client.update(dt, input),
        dispose: () => client.dispose()
      }, terrain);
    } catch (err) {
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

/** Lobby players in join order take seats; the rest of 4v4 are bots, teams filled evenly. */
export function seatsFor(room: LobbyRoom, selfId: string, missing: readonly string[] = []): Seat[] {
  const seats: Seat[] = Object.entries(room.players)
    .filter(([uid]) => !missing.includes(uid))
    .sort((a, b) => a[1].joinedAt - b[1].joinedAt)
    .map(([uid, p]) => ({ name: p.name, team: p.team, vehicle: p.vehicle, control: uid === selfId ? 'local' : uid }));
  for (const team of [0, 1] as const) {
    while (seats.filter(s => s.team === team).length < config.match.teamSize) {
      seats.push({ name: '', team, vehicle: null, control: 'bot' });
    }
  }
  return seats;
}

async function connect(code: string): Promise<Transport> {
  return connectTrystero(code, await firebaseApp(), firebaseConfig.databaseURL);
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
    case 'started': return 'That match already started';
    default: return msg;
  }
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
