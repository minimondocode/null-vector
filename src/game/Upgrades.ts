import type { Player } from './Player';
import type { GameContext } from './types';

export type Rarity = 'common' | 'rare' | 'epic';

export interface UpgradeDef {
  id: string;
  name: string;
  description: string;
  rarity: Rarity;
  maxStacks: number;
  /** Short glyph shown on the card (ASCII/unicode). */
  glyph: string;
  apply(player: Player, ctx: GameContext): void;
  /** Optional gate: not offered while this returns false (e.g. heals at full HP). */
  available?(player: Player, ctx: GameContext): boolean;
}

/**
 * Every upgrade only touches PlayerStats (read by Player / Game / Pickups), so stacking is
 * just arithmetic. Numbers in descriptions are per stack and match the code.
 */
export const UPGRADES: UpgradeDef[] = [
  // ---------- offense ----------
  {
    id: 'rate', name: 'OVERCLOCK', glyph: '>>', rarity: 'common', maxStacks: 5,
    description: '+20% fire rate.',
    apply: (p) => (p.stats.fireRate *= 1.2),
  },
  {
    id: 'dmg', name: 'PAYLOAD+', glyph: '▲', rarity: 'common', maxStacks: 5,
    description: '+25% bullet damage.',
    apply: (p) => (p.stats.damage *= 1.25),
  },
  {
    id: 'multi', name: 'FORK()', glyph: '⋔', rarity: 'rare', maxStacks: 3,
    description: '+1 projectile per shot, wider spread.',
    apply: (p) => {
      p.stats.projectiles += 1;
      p.stats.spread += 0.1;
    },
  },
  {
    id: 'pierce', name: 'PIERCE.SYS', glyph: '→|', rarity: 'rare', maxStacks: 3,
    description: 'Bullets pass through +1 enemy.',
    apply: (p) => (p.stats.pierce += 1),
  },
  {
    id: 'ricochet', name: 'RICOCHET', glyph: '↯', rarity: 'common', maxStacks: 3,
    description: 'Bullets bounce off walls +1 time.',
    apply: (p) => (p.stats.ricochet += 1),
  },
  {
    id: 'homing', name: 'HOMING DAEMON', glyph: '◎', rarity: 'rare', maxStacks: 2,
    description: 'Bullets curve toward nearby enemies (+35% steering).',
    apply: (p) => (p.stats.homing += 0.35),
  },
  {
    id: 'crit', name: 'CRIT MODULE', glyph: '✶', rarity: 'common', maxStacks: 4,
    description: '+8% chance for a critical hit (x2.5 damage).',
    apply: (p) => (p.stats.critChance += 0.08),
  },
  {
    id: 'overflow', name: 'BUFFER OVERFLOW', glyph: '●', rarity: 'rare', maxStacks: 3,
    description: '+35% bullet size and +15% damage.',
    apply: (p) => {
      p.stats.bulletSize *= 1.35;
      p.stats.damage *= 1.15;
    },
  },
  {
    id: 'bandwidth', name: 'BANDWIDTH', glyph: '≫', rarity: 'common', maxStacks: 2,
    description: '+25% bullet speed and +10% damage.',
    apply: (p) => {
      p.stats.projectileSpeed *= 1.25;
      p.stats.damage *= 1.1;
    },
  },
  {
    id: 'rear', name: 'REAR ARRAY', glyph: '⇅', rarity: 'common', maxStacks: 2,
    description: 'Adds a rear-facing gun (60% damage). Stacks add extra rear barrels.',
    apply: (p) => (p.stats.rearGuns += 1),
  },
  {
    id: 'drone', name: 'DRONE SUBPROCESS', glyph: '◇', rarity: 'epic', maxStacks: 3,
    description: '+1 orbiting drone that auto-targets the nearest enemy.',
    apply: (p) => (p.stats.drones += 1),
  },
  {
    id: 'coredump', name: 'CORE DUMP', glyph: '✺', rarity: 'epic', maxStacks: 3,
    description: 'Kills detonate (2.6 radius, +0.9 per stack), chaining through crowds.',
    apply: (p) => (p.stats.deathBlast = p.stats.deathBlast > 0 ? p.stats.deathBlast + 0.9 : 2.6),
  },
  {
    id: 'sudo', name: 'SUDO RM -RF', glyph: '#', rarity: 'epic', maxStacks: 1,
    description: '+60% damage, but -1 max HP. Root access has a price.',
    available: (p) => p.stats.maxHp >= 3,
    apply: (p, ctx) => {
      p.stats.damage *= 1.6;
      p.stats.maxHp -= 1;
      if (p.hp > p.stats.maxHp) p.hp = p.stats.maxHp;
      ctx.bus.emit('playerHeal', { hp: p.hp });
    },
  },
  // ---------- mobility / dash ----------
  {
    id: 'phase', name: 'PHASE SHIFT', glyph: '»', rarity: 'common', maxStacks: 3,
    description: '-20% dash cooldown, +1 dash distance.',
    apply: (p) => {
      p.stats.dashCooldown *= 0.8;
      p.stats.dashDistance += 1;
    },
  },
  {
    id: 'kernel', name: 'KERNEL PANIC', glyph: '⚡', rarity: 'rare', maxStacks: 3,
    description: 'Dash trail deals +3 damage.',
    apply: (p) => (p.stats.dashDamage += 3),
  },
  {
    id: 'thread', name: 'THREAD BOOST', glyph: '⇡', rarity: 'common', maxStacks: 3,
    description: '+10% move speed.',
    apply: (p) => (p.stats.moveSpeed *= 1.1),
  },
  // ---------- defense ----------
  {
    id: 'shield', name: 'FIREWALL SHARD', glyph: '⬡', rarity: 'rare', maxStacks: 2,
    description: '+1 shield charge that absorbs a hit. Recharges after 9s.',
    apply: (p) => (p.stats.shield += 1),
  },
  {
    id: 'patch', name: 'PATCH', glyph: '+', rarity: 'common', maxStacks: 4,
    description: '+1 max HP and restore 1 HP.',
    apply: (p, ctx) => {
      p.stats.maxHp += 1;
      p.heal(ctx, 1);
    },
  },
  {
    id: 'hotfix', name: 'HOTFIX', glyph: '♥', rarity: 'common', maxStacks: 99,
    description: 'Restore 2 HP.',
    available: (p) => p.hp < p.stats.maxHp,
    apply: (p, ctx) => p.heal(ctx, 2),
  },
  // ---------- economy / overdrive / combo ----------
  {
    id: 'gc', name: 'GARBAGE COLLECTOR', glyph: '♻', rarity: 'common', maxStacks: 3,
    description: '+40% overdrive meter gain.',
    apply: (p) => (p.stats.overdriveGain *= 1.4),
  },
  {
    id: 'timeslice', name: 'TIME SLICE', glyph: '◷', rarity: 'rare', maxStacks: 2,
    description: '+1.5s overdrive slow-motion.',
    apply: (p) => (p.stats.overdriveDuration += 1.5),
  },
  {
    id: 'latency', name: 'LATENCY', glyph: '∞', rarity: 'common', maxStacks: 3,
    description: '+0.8s combo window.',
    apply: (p) => (p.stats.comboWindow += 0.8),
  },
  {
    id: 'scavenger', name: 'SCAVENGER.EXE', glyph: '⌖', rarity: 'common', maxStacks: 2,
    description: '+50% shard drop rate, +60% pickup magnet range.',
    apply: (p) => {
      p.stats.dropRate *= 1.5;
      p.stats.pickupMagnet *= 1.6;
    },
  },
];

/** The Director binds the run context so availability gates (HP etc.) can be checked. */
let bound: GameContext | null = null;
export function bindUpgradeContext(ctx: GameContext | null) {
  bound = ctx;
}

const WEIGHT: Record<Rarity, number> = { common: 6, rare: 3, epic: 1.2 };

export function rollUpgrades(owned: Map<string, number>, n = 3): UpgradeDef[] {
  const ctx = bound;
  const pool = UPGRADES.filter(
    (u) => (owned.get(u.id) ?? 0) < u.maxStacks && (!u.available || !ctx || u.available(ctx.player, ctx)),
  );
  // slight bias toward things already owned (build identity), and epics get likelier later in a run
  const late = ctx ? Math.min(1, ctx.runTime / 480) : 0;
  const weight = (u: UpgradeDef) => {
    let w = WEIGHT[u.rarity];
    if (u.rarity === 'epic') w *= 1 + late;
    if ((owned.get(u.id) ?? 0) > 0) w *= 1.25;
    if (u.id === 'hotfix' && ctx) w *= 1 + 2 * (1 - ctx.player.hp / ctx.player.stats.maxHp);
    return w;
  };
  const out: UpgradeDef[] = [];
  while (out.length < n && pool.length) {
    const total = pool.reduce((s, u) => s + weight(u), 0);
    let r = Math.random() * total;
    let i = 0;
    for (; i < pool.length; i++) {
      r -= weight(pool[i]);
      if (r <= 0) break;
    }
    out.push(pool.splice(Math.min(i, pool.length - 1), 1)[0]);
  }
  // every offer carries at least one raw-DPS option so a run can't starve on damage
  if (out.length === n && !out.some((u) => CORE_DPS.includes(u.id))) {
    const dps = pool.filter((u) => CORE_DPS.includes(u.id));
    if (dps.length) out[n - 1] = dps[Math.floor(Math.random() * dps.length)];
  }
  return out;
}

const CORE_DPS = ['rate', 'dmg', 'multi', 'pierce', 'crit', 'overflow'];
