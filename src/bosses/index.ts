import type { GameContext } from '../game/types';

export type BossId = 'firewall' | 'hydra' | 'root';

/**
 * Spawn a boss encounter (warning, intro, fight). Calls `onDefeated` once the boss is dead
 * and its death sequence has finished. STUB — the boss pass implements the real encounters.
 */
export function spawnBoss(ctx: GameContext, id: BossId, onDefeated: () => void): void {
  ctx.bus.emit('bossWarning', { name: id.toUpperCase(), title: 'STUB' });
  setTimeout(onDefeated, 1000);
}
