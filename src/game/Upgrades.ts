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
}

/** STUB list — the content pass expands this. */
export const UPGRADES: UpgradeDef[] = [
  { id: 'rate', name: 'OVERCLOCK', description: '+25% fire rate', rarity: 'common', maxStacks: 5, glyph: '>>', apply: (p) => (p.stats.fireRate *= 1.25) },
  { id: 'multi', name: 'FORK()', description: '+1 projectile per shot', rarity: 'rare', maxStacks: 4, glyph: '⋔', apply: (p) => (p.stats.projectiles += 1) },
  { id: 'dmg', name: 'PAYLOAD+', description: '+30% damage', rarity: 'common', maxStacks: 5, glyph: '▲', apply: (p) => (p.stats.damage *= 1.3) },
];

export function rollUpgrades(owned: Map<string, number>, n = 3): UpgradeDef[] {
  const pool = UPGRADES.filter((u) => (owned.get(u.id) ?? 0) < u.maxStacks);
  const weight = (u: UpgradeDef) => (u.rarity === 'common' ? 6 : u.rarity === 'rare' ? 3 : 1);
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
  return out;
}
