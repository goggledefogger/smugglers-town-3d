import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { Game, type RoundConfig } from '../src/app/Game.ts';
import { EventBus, type GameEventMap } from '../src/app/events.ts';
import { createStore, type HudSnapshot } from '../src/app/store.ts';
import { Heightfield } from '../src/core/heightfield.ts';
import { createDesertTerrain } from '../src/core/terrain/ProceduralTerrain.ts';

const NEUTRAL = { throttle: 0, brake: 0, steer: 0, jump: false };
const NO_COUNTDOWN: RoundConfig = { roundS: 300, countdownS: 0, finalMinuteS: 60 };

function makeGame(round: RoundConfig = NO_COUNTDOWN): { game: Game; events: EventBus<GameEventMap> } {
  const terrain = createDesertTerrain(new Heightfield(840, 1, new Float32Array([0, 0, 0, 0])));
  const events = new EventBus<GameEventMap>();
  const game = new Game(terrain, { events, store: createStore<HudSnapshot>({} as HudSnapshot), round });
  game.reset(terrain);
  return { game, events };
}

describe('Game round structure', () => {
  it('holds everyone still through the countdown, then releases', () => {
    const { game, events } = makeGame({ roundS: 300, countdownS: 1, finalMinuteS: 60 });
    const ticks: number[] = [];
    events.on('match:countdown', ({ n }) => ticks.push(n));
    const player = game.player!.body;
    for (let t = 0; t < 0.5; t += 0.02) game.update(0.02, { ...NEUTRAL, throttle: 1 });
    expect(game.matchPhase).toBe('countdown');
    expect(player.speed).toBeLessThan(0.5);
    for (let t = 0; t < 1.5; t += 0.02) game.update(0.02, { ...NEUTRAL, throttle: 1 });
    expect(game.matchPhase).toBe('playing');
    expect(player.speed).toBeGreaterThan(5);
    expect(ticks).toEqual([1, 0]);
  });

  it('gives a tied buzzer to sudden death and the next delivery', () => {
    const { game, events } = makeGame({ roundS: 0.5, countdownS: 0, finalMinuteS: 0.25 });
    const seen: string[] = [];
    events.on('match:finalMinute', () => seen.push('final'));
    events.on('match:suddenDeath', () => seen.push('sudden'));
    events.on('match:win', ({ team }) => seen.push('win' + team));
    for (let t = 0; t < 0.6; t += 0.02) game.update(0.02, NEUTRAL);
    expect(game.matchPhase).toBe('suddenDeath');
    const player = game.player!.body;
    player.pos.copy(game.state.contrabandPos);
    game.update(0.02, NEUTRAL);
    player.pos.copy(game.state.bases[0]);
    game.update(0.02, NEUTRAL);
    expect(game.matchPhase).toBe('gameover');
    expect(seen).toEqual(['final', 'sudden', 'win0']);
  });

  it('stops a car at a building box found through the broadphase', () => {
    const { game } = makeGame();
    const player = game.player!.body;
    player.pos.set(0, 1, 0);
    player.quat.identity(); // facing -z
    player.vel.set(0, 0, 0);
    game.setBuildingColliders([
      { min: new Vector3(-20, 0, -30), max: new Vector3(20, 20, -27) },  // wall ahead
      { min: new Vector3(300, 0, 300), max: new Vector3(320, 20, 320) }  // irrelevant, far away
    ]);
    for (let t = 0; t < 2; t += 0.02) game.update(0.02, { ...NEUTRAL, throttle: 1 });
    expect(player.pos.z).toBeGreaterThan(-30);
    expect(player.pos.z).toBeLessThan(-15);
  });

  it('routes bots around building colliders', () => {
    const { game } = makeGame();
    expect(game.route('contraband', new Vector3(-10, 0, 0), new Vector3(10, 0, 0))).toBeNull();
    game.setBuildingColliders([{ min: new Vector3(-1.5, 0, -15), max: new Vector3(1.5, 20, 15) }]);
    const wp = game.route('contraband', new Vector3(-10, 0, 0), new Vector3(10, 0, 0));
    expect(wp).not.toBeNull();
    expect(Math.abs(wp!.z)).toBeGreaterThan(3);
  });
});

describe('Game', () => {
  it('exposes the fraction of a step since the last one for pose interpolation', () => {
    const { game } = makeGame();
    game.update(0.025, NEUTRAL); // one 1/60 step, 0.00833 left over
    expect(game.alpha).toBeCloseTo(0.5, 5);
    const body = game.player!.body;
    expect(body.prevPos.distanceTo(body.pos)).toBeGreaterThanOrEqual(0);
  });

  it('reports the bearing to the contraband clockwise from straight ahead', () => {
    const { game } = makeGame();
    const player = game.player!.body;
    player.quat.identity(); // facing -z
    const c = game.state.contrabandPos;
    player.pos.set(c.x, c.y, c.z + 100);            // contraband straight ahead
    expect(game.targetBearing()).toBeCloseTo(0, 6);
    player.pos.set(c.x - 100, c.y, c.z);            // to the right (+x)
    expect(game.targetBearing()).toBeCloseTo(Math.PI / 2, 6);
    player.pos.set(c.x + 100, c.y, c.z);            // to the left
    expect(game.targetBearing()).toBeCloseTo(-Math.PI / 2, 6);
    player.pos.set(c.x + 100, c.y, c.z - 100);      // behind-left
    expect(game.targetBearing()).toBeCloseTo(-3 * Math.PI / 4, 6);
  });

  it('lets a vehicle pick up contraband by driving onto it', () => {
    const { game } = makeGame();
    const player = game.player!.body;
    player.pos.copy(game.state.contrabandPos);
    game.update(0.02, NEUTRAL);
    expect(game.state.carrier).toBe(player);
  });

  it('wrecks a car at zero integrity: crate drops there, car respawns near its base', () => {
    const { game } = makeGame();
    const player = game.player!.body;
    player.pos.copy(game.state.contrabandPos);
    game.update(0.02, NEUTRAL);
    expect(game.state.carrier).toBe(player);
    const where = player.pos.clone();
    player.damage = 1;
    game.update(0.02, NEUTRAL);
    expect(game.state.carrier).toBeNull();
    expect(game.state.contrabandPos.distanceTo(where)).toBeLessThan(10);
    expect(player.damage).toBe(0);
    expect(player.pos.distanceTo(game.state.bases[0])).toBeLessThan(80);
  });

  it('keeps the contraband with the player across a vehicle switch', () => {
    const { game } = makeGame();
    const before = game.player!.body;
    before.pos.copy(game.state.contrabandPos);
    game.update(0.02, NEUTRAL);
    game.switchPlayerVehicle(0);
    const after = game.player!.body;
    expect(after).not.toBe(before);
    expect(game.state.carrier).toBe(after);
    // and the new body is the one the rules see from now on
    after.pos.copy(game.state.bases[0]);
    game.update(0.02, NEUTRAL);
    expect(game.state.scores[0]).toBe(1);
  });
});
