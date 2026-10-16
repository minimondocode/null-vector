import * as THREE from 'three';
import type { GameContext } from '../game/types';
import { EnemyBase, angleDiff, neonShared, scaledHp, scaledSpeed } from './EnemyBase';

export const SEEKER_COLOR = 0xff2b4e;
const _t = new THREE.Vector3();

/**
 * "Seeker": a flat diamond that homes in on the player. Fodder.
 * Weaves side-to-side while far away (so a pack never lines up), commits straight in when close.
 * Banks into turns, stretches with speed, spins its inner core.
 */
export class Chaser extends EnemyBase {
  kind = 'seeker';
  private speed: number;
  private phase = Math.random() * Math.PI * 2;
  private hull = new THREE.Group();
  private core: THREE.Object3D;
  private lastHeading = 0;
  private bank = 0;

  constructor(ctx: GameContext, x: number, z: number) {
    super(ctx, x, z, SEEKER_COLOR, 0.7);
    this.radius = 0.6;
    this.hp = this.maxHp = scaledHp(ctx, 2);
    this.scoreValue = 50;
    this.dropTier = 1;
    this.speed = scaledSpeed(ctx, 6.5) * (0.9 + Math.random() * 0.2);
    const outer = neonShared(
      'seeker',
      () => {
        const g = new THREE.OctahedronGeometry(0.65, 0);
        g.scale(1, 0.5, 1.3);
        return g;
      },
      this.color,
    );
    const inner = neonShared('seeker-core', () => new THREE.OctahedronGeometry(0.2, 0), 0xffffff, 2.5, 1);
    this.core = inner.group;
    this.core.position.y = 0.22;
    this.hull.add(outer.group, this.core);
    this.body.add(this.hull);
    this.registerEdges(outer.edgeMat);
  }

  protected think(ctx: GameContext, dt: number) {
    const p = ctx.player.pos;
    const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    // lateral weave fades out as it closes in
    const weave = Math.min(1, Math.max(0, (d - 4) / 8)) * 2.2 * Math.sin(ctx.time * 2.4 + this.phase);
    _t.set(p.x - (dz / d) * weave, 0, p.z + (dx / d) * weave);
    this.seek(_t, this.speed, 4, dt);
    this.separate(ctx, 0.8);
    this.pos.addScaledVector(this.vel, dt);
    this.faceVelocity(dt, 9);

    // bank into the turn
    const h = this.body.rotation.y;
    const turn = angleDiff(this.lastHeading, h) / Math.max(dt, 1e-4);
    this.lastHeading = h;
    this.bank += (THREE.MathUtils.clamp(-turn * 0.12, -0.7, 0.7) - this.bank) * Math.min(1, dt * 10);
    this.hull.rotation.z = this.bank;
    // stretch with speed + idle breathing
    const sp = this.vel.length() / this.speed;
    const breathe = Math.sin(ctx.time * 7 + this.phase) * 0.05;
    this.hull.scale.set(1 - sp * 0.1 + breathe, 1, 1 + sp * 0.15 - breathe);
    this.core.rotation.y += dt * 6;
  }
}
