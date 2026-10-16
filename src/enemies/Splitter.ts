import * as THREE from 'three';
import type { GameContext } from '../game/types';
import { EnemyBase, neonShared, scaledHp, scaledSpeed } from './EnemyBase';

export const SPLITTER_COLOR = 0xa25bff;
const SIZE = [0.8, 1.25, 1.9];
const RADIUS = [0.5, 0.85, 1.3];
const HP = [1.5, 5, 12];
const SPEED = [7.5, 4.8, 3.0];
const SCORE = [40, 120, 300];
const _n = new THREE.Vector2();
const _t = new THREE.Vector3();

/**
 * "Splitter": a tumbling cube that drifts toward the player and bounces off walls.
 * Big -> 2 medium -> 2 small each. Smalls are fast. Inner counter-rotating cube shows the "payload".
 */
export class Splitter extends EnemyBase {
  kind = 'splitter';
  private speed: number;
  private shell = new THREE.Group();
  private inner: THREE.Object3D;
  private squash = 0;
  private spinAxis = new THREE.Vector3();

  constructor(ctx: GameContext, x: number, z: number, readonly size = 2, spawnTime = 1.0) {
    super(ctx, x, z, SPLITTER_COLOR, spawnTime);
    this.radius = RADIUS[size];
    this.hp = this.maxHp = scaledHp(ctx, HP[size]);
    this.scoreValue = SCORE[size];
    this.dropTier = size === 2 ? 2 : size === 1 ? 1 : 0.4;
    this.knockResist = size === 2 ? 0.3 : size === 1 ? 0.6 : 1;
    this.speed = scaledSpeed(ctx, SPEED[size]) * (0.9 + Math.random() * 0.2);
    const s = SIZE[size];
    const outer = neonShared(`splitter-${size}`, () => new THREE.BoxGeometry(s, s, s), this.color, size === 0 ? 3.4 : 3);
    this.shell.add(outer.group);
    const innerMesh = neonShared(`splitter-in-${size}`, () => new THREE.BoxGeometry(s * 0.45, s * 0.45, s * 0.45), 0xffffff, 1.6, 1);
    this.inner = innerMesh.group;
    this.inner.visible = size > 0;
    this.shell.add(this.inner);
    this.body.add(this.shell);
    this.registerEdges(outer.edgeMat);
    this.spinAxis.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
    const a = Math.random() * Math.PI * 2;
    this.vel.set(Math.cos(a), 0, Math.sin(a)).multiplyScalar(this.speed);
  }

  /** Children pop out with an initial kick. */
  kick(vx: number, vz: number) {
    this.vel.set(vx, 0, vz);
    this.knock.set(vx, 0, vz).multiplyScalar(0.6);
  }

  protected think(ctx: GameContext, dt: number) {
    // gentle homing, keeps momentum (DVD-style bounces)
    _t.subVectors(ctx.player.pos, this.pos).setY(0).normalize().multiplyScalar(this.speed);
    this.vel.lerp(_t, 1 - Math.exp(-(this.size === 0 ? 1.6 : 0.7) * dt));
    const sp = this.vel.length();
    if (sp > this.speed * 1.6) this.vel.multiplyScalar((this.speed * 1.6) / sp);
    this.separate(ctx, 0.4);
    this.pos.addScaledVector(this.vel, dt);
    if (ctx.arena.clamp(this.pos, this.radius, _n)) {
      const d = this.vel.x * _n.x + this.vel.z * _n.y;
      if (d < 0) {
        this.vel.x -= 2 * d * _n.x;
        this.vel.z -= 2 * d * _n.y;
        this.squash = 1;
      }
    }
    // tumble around an axis perpendicular to travel
    const roll = (sp / Math.max(0.3, this.radius)) * dt * 0.8;
    this.shell.rotation.x += this.vel.z * roll * 0.12;
    this.shell.rotation.z -= this.vel.x * roll * 0.12;
    this.shell.rotation.y += dt * 0.6;
    this.inner.rotation.x -= dt * 2.1;
    this.inner.rotation.y -= dt * 1.7;
    this.squash = Math.max(0, this.squash - dt * 5);
    const q = this.squash;
    this.body.scale.set(1 + q * 0.25, 1 - q * 0.3, 1 + q * 0.25);
    this.body.position.y = Math.abs(Math.sin(ctx.time * 3 + this.pos.x)) * 0.15 * (this.size + 1) * 0.5;
  }

  protected onDeath(ctx: GameContext) {
    if (this.size === 0) return;
    // split perpendicular to the killing direction-ish: use current velocity
    const a = Math.atan2(this.vel.x, this.vel.z) + Math.PI / 2;
    const kick = 7 + this.size * 2;
    for (const sgn of [-1, 1]) {
      const ox = Math.sin(a) * sgn, oz = Math.cos(a) * sgn;
      const c = new Splitter(ctx, this.pos.x + ox * this.radius * 0.6, this.pos.z + oz * this.radius * 0.6, this.size - 1, 0.18);
      c.kick(ox * kick, oz * kick);
      ctx.addEnemy(c);
    }
  }
}
