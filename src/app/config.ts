/**
 * Central config for every tunable in the game. Sections mirror the layers
 * they configure. All values ported from the prototype unless noted.
 */
export const config = {
  world: {
    /** Half-extent of the play field in world units. */
    mapHalf: 2800
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
    /** Crates in play at once; a fresh set lands only when all four are home. */
    crateCount: 4,
    scoreGoal: 5,
    deliveryRadius: 22,
    contrabandRadius: 4.5,
    transferCooldownS: 0.6
  },
  ai: {
    reevaluateS: 0.2,
    steerGain: 2.4,
    slowTurnAngle: 1.55,
    slowTurnSpeed: 45,
    interceptLead: 1.0,
    ramDist: 40
  },
  match: {
    /** Player + N allies on team 0. */
    teamSize: 4,
    /** Round length (s); the leader wins at the buzzer, a tie goes to sudden death. */
    roundS: 300,
    /** Start countdown (s): cars settle, nobody drives. */
    countdownS: 3,
    /** Warning banner when this much time is left (s). */
    finalMinuteS: 60
  },
  spawn: {
    /** Mid-game respawn height (m) after a wreck: quick drop (~1s). */
    dropHeight: 14,
    /** Match start drop height (m): falls for ~2.5s and lands right as countdown finishes. */
    initialDropHeight: 65
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

