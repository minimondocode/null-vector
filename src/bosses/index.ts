import type { GameContext } from '../game/types';
import type { BossEncounter } from './common';
import { Firewall } from './Firewall';
import { Hydra } from './Hydra';
import { Root } from './Root';

export type BossId = 'firewall' | 'hydra' | 'root';

/**
 * Spawn a boss encounter: WARNING (bossWarning) -> ~2.5s in-world materialisation -> bossSpawn ->
 * phased fight -> death sequence -> bossKilled -> `onDefeated()` (called exactly once).
 * Safe to call standalone, e.g. `game.startRun('campaign'); spawnBoss(game, 'root', () => {})`.
 */
export function spawnBoss(ctx: GameContext, id: BossId, onDefeated: () => void): BossEncounter {
  let boss: BossEncounter;
  switch (id) {
    case 'hydra':
      boss = new Hydra(ctx, onDefeated);
      break;
    case 'root':
      boss = new Root(ctx, onDefeated);
      break;
    default:
      boss = new Firewall(ctx, onDefeated);
  }
  ctx.addEntity(boss);
  boss.start();
  return boss;
}
