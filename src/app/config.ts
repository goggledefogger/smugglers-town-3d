/**
 * Central config for every tunable in the game. Sections mirror the layers
 * they configure. All values ported from the prototype unless noted.
 */
export const config = {
  world: {
    /** Half-extent of the play field in world units. */
    mapHalf: 420,
    /** World units per real-world meter (terrain + 3D tile scale). */
    worldMPerM: 0.15
  },
  physics: {
    gravity: 22,
    driveForce: 62,
    maxSpeed: 78,
    brakeForce: 80,
    turnRate: 2.6,
    jumpBoost: 1.55,
    airControl: 2.1,
    rollRecover: 4.2,
    groundClearance: 1.0
  },
  scoring: {
    scoreGoal: 5,
    deliveryRadius: 22,
    contrabandRadius: 4.5,
    transferCooldownS: 0.6,
    spawnClearance: 40
  },
  ram: {
    ramRadius: 4.2
  },
  ai: {
    reevaluateS: 0.5,
    steerGain: 1.8,
    slowTurnAngle: 1.3,
    slowTurnSpeed: 20
  },
  match: {
    /** Player + N allies on team 0. */
    teamSize: 4
  },
  camera: {
    fovBase: 62,
    fovPerZoom: 2.4,
    chaseBack: 14,
    chaseUp: 6,
    farBack: 24,
    farUp: 10,
    hoodFwd: 6
  },
  loop: {
    /** Fixed simulation timestep (seconds). */
    step: 1 / 60,
    /** Clamp on frame delta to avoid physics blowups on tab-switch. */
    maxFrameDt: 0.05
  }
} as const;

export type Config = typeof config;
