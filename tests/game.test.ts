import { describe, it, expect } from 'vitest';
import { Game } from '../src/app/Game.ts';
import { EventBus, type GameEventMap } from '../src/app/events.ts';
import { createStore, type HudSnapshot } from '../src/app/store.ts';
import { Heightfield } from '../src/core/heightfield.ts';
import { createDesertTerrain } from '../src/core/terrain/ProceduralTerrain.ts';

const NEUTRAL = { throttle: 0, brake: 0, steer: 0, jump: false };

function makeGame(): Game {
  const terrain = createDesertTerrain(new Heightfield(840, 1, new Float32Array([0, 0, 0, 0])));
  const game = new Game(terrain, {
    events: new EventBus<GameEventMap>(),
    store: createStore<HudSnapshot>({} as HudSnapshot)
  });
  game.reset(terrain);
  return game;
}

describe('Game', () => {
  it('exposes the fraction of a step since the last one for pose interpolation', () => {
    const game = makeGame();
    game.update(0.025, NEUTRAL); // one 1/60 step, 0.00833 left over
    expect(game.alpha).toBeCloseTo(0.5, 5);
    const body = game.player!.body;
    expect(body.prevPos.distanceTo(body.pos)).toBeGreaterThanOrEqual(0);
  });

  it('lets a vehicle pick up contraband by driving onto it', () => {
    const game = makeGame();
    const player = game.player!.body;
    player.pos.copy(game.state.contrabandPos);
    game.update(0.02, NEUTRAL);
    expect(game.state.carrier).toBe(player);
  });

  it('keeps the contraband with the player across a vehicle switch', () => {
    const game = makeGame();
    const before = game.player!.body;
    before.pos.copy(game.state.contrabandPos);
    game.update(0.02, NEUTRAL);
    game.switchPlayerVehicle(0);
    const after = game.player!.body;
    expect(after).not.toBe(before);
    expect(game.state.carrier).toBe(after);
    // and the new body is the one the rules see from now on
    after.pos.copy(game.state.dropZonePos);
    game.update(0.02, NEUTRAL);
    expect(game.state.scores[0]).toBe(1);
  });
});
