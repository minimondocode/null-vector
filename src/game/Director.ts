import { Chaser } from '../enemies/Chaser';
import type { GameContext } from './types';

/**
 * Run pacing: sectors -> waves -> boss. STUB — spawns seekers forever.
 * The content pass replaces this with the full campaign + endless director.
 */
export class Director {
  private timer = 0;

  start(ctx: GameContext) {
    this.timer = 1;
    ctx.bus.emit('sectorStart', { sector: 0, name: ctx.theme.name });
  }

  update(ctx: GameContext, dt: number) {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 1.2;
      const p = ctx.arena.randomEdgePoint(3);
      ctx.addEnemy(new Chaser(ctx, p.x, p.z));
    }
  }
}
