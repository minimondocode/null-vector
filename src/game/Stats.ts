/** Mutable stats that upgrades modify. One instance per run, owned by Player. */
export interface PlayerStats {
  maxHp: number;
  moveSpeed: number;
  /** Shots per second. */
  fireRate: number;
  damage: number;
  projectileSpeed: number;
  /** Projectiles per shot. */
  projectiles: number;
  /** Total fan angle in radians when projectiles > 1. */
  spread: number;
  /** Enemies a bullet passes through before dying. */
  pierce: number;
  /** Bounces off arena walls / to next enemy. */
  ricochet: number;
  bulletSize: number;
  /** Chance (0..1) a bullet is critical (x2.5 dmg, bigger). */
  critChance: number;
  /** Fraction of bullets that home toward enemies (0..1 strength). */
  homing: number;
  dashCooldown: number;
  dashDistance: number;
  /** Damage dealt to enemies the dash trail crosses. */
  dashDamage: number;
  /** Seconds of overdrive slow motion. */
  overdriveDuration: number;
  /** Multiplier on overdrive meter gain. */
  overdriveGain: number;
  /** Seconds the combo survives without a kill. */
  comboWindow: number;
  /** Rear-firing extra bullets. */
  rearGuns: number;
  /** Orbiting drones that shoot. */
  drones: number;
  /** Radius of an explosion when an enemy dies (0 = off). */
  deathBlast: number;
  /** Shield charges that absorb a hit and recharge. */
  shield: number;
}

export function baseStats(maxHp: number): PlayerStats {
  return {
    maxHp,
    moveSpeed: 11,
    fireRate: 8,
    damage: 1,
    projectileSpeed: 42,
    projectiles: 1,
    spread: 0.22,
    pierce: 0,
    ricochet: 0,
    bulletSize: 1,
    critChance: 0.05,
    homing: 0,
    dashCooldown: 1.1,
    dashDistance: 6.5,
    dashDamage: 2,
    overdriveDuration: 4,
    overdriveGain: 1,
    comboWindow: 2.6,
    rearGuns: 0,
    drones: 0,
    deathBlast: 0,
    shield: 0,
  };
}
