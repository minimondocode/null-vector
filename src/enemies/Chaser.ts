import * as THREE from 'three';
import type { GameContext } from '../game/types';
import { EnemyBase, neonMesh } from './EnemyBase';

/** "Seeker": a diamond that homes in on the player. Fodder. */
export class Chaser extends EnemyBase {
  kind = 'seeker';
  private speed: number;

  constructor(ctx: GameContext, x: number, z: number) {
    super(ctx, x, z, 0xff3d7f);
    this.radius = 0.6;
    this.hp = this.maxHp = 2 * ctx.difficulty.enemyHp;
    this.scoreValue = 50;
    this.speed = 6.5 * ctx.difficulty.enemySpeed * (0.9 + Math.random() * 0.2);
    const geo = new THREE.OctahedronGeometry(0.65, 0);
    geo.scale(1, 0.55, 1.25);
    const { group, edgeMat } = neonMesh(geo, this.color);
    this.body.add(group);
    this.registerEdges(edgeMat);
  }

  protected think(ctx: GameContext, dt: number) {
    this.seek(ctx.player.pos, this.speed, 4, dt);
    this.separate(ctx, 0.8);
    this.pos.addScaledVector(this.vel, dt);
    this.faceVelocity(dt);
    this.body.rotation.z = Math.sin(ctx.time * 6 + this.pos.x) * 0.3;
  }
}
