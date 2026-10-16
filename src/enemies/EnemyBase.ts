import * as THREE from 'three';
import { PLAY_Y } from '../game/config';
import type { DamageSource, Enemy, GameContext } from '../game/types';

const _v = new THREE.Vector3();

export function glowColor(hex: number, k = 2.5) {
  return new THREE.Color(hex).multiplyScalar(k);
}

/**
 * Neon body: near-black fill + bright edge lines. Returns the group and the edge material
 * (so hit-flash can tint it).
 */
export function neonMesh(geo: THREE.BufferGeometry, color: number, edgeBoost = 3, fillOpacity = 0.85) {
  const group = new THREE.Group();
  const fill = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(0.12), transparent: fillOpacity < 1, opacity: fillOpacity }),
  );
  const edgeMat = new THREE.LineBasicMaterial({ color: glowColor(color, edgeBoost), toneMapped: false });
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 15), edgeMat);
  group.add(fill, edges);
  return { group, edgeMat, fill };
}

/**
 * Shared enemy behaviour: spawn-in telegraph, hit flash, knockback, death event.
 * Subclasses implement `think(ctx, dt)` and build `this.body` in their constructor.
 */
export abstract class EnemyBase implements Enemy {
  abstract kind: string;
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  radius = 0.7;
  hp = 3;
  maxHp = 3;
  alive = true;
  collidable = false;
  contactDamage = true;
  vulnerable = true;
  scoreValue = 100;
  color: number;
  isBoss = false;
  countsForWave = true;
  object = new THREE.Group();
  /** Visual body (rotated/scaled freely by subclasses). */
  body = new THREE.Group();
  /** Seconds of spawn telegraph left. */
  spawnTime: number;
  protected flash = 0;
  protected edgeMats: THREE.LineBasicMaterial[] = [];
  private baseEdgeColors: THREE.Color[] = [];
  private spawnRing: THREE.Mesh;
  /** Knockback velocity, decays quickly. */
  protected knock = new THREE.Vector3();
  /** Multiplier on knockback received. 0 = immovable. */
  protected knockResist = 1;
  /** Last dash id that hurt this enemy. */
  lastDashId = -1;

  constructor(ctx: GameContext, x: number, z: number, color: number, spawnTime = 0.8) {
    this.color = color;
    this.pos.set(x, 0, z);
    this.spawnTime = spawnTime;
    this.object.add(this.body);
    this.spawnRing = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.0, 32),
      new THREE.MeshBasicMaterial({ color: glowColor(color, 2), transparent: true, opacity: 0.8, side: THREE.DoubleSide, toneMapped: false, depthWrite: false }),
    );
    this.spawnRing.rotation.x = -Math.PI / 2;
    this.spawnRing.position.y = -PLAY_Y + 0.05;
    this.object.add(this.spawnRing);
    this.object.position.set(x, PLAY_Y, z);
    ctx.scene.add(this.object);
    ctx.bus.emit('enemySpawn', { pos: this.pos.clone(), kind: this.constructor.name });
  }

  /** Register edge materials for hit flash. Call after building the body. */
  protected registerEdges(...mats: THREE.LineBasicMaterial[]) {
    for (const m of mats) {
      this.edgeMats.push(m);
      this.baseEdgeColors.push(m.color.clone());
    }
  }

  protected abstract think(ctx: GameContext, dt: number): void;

  update(ctx: GameContext, dt: number) {
    if (this.spawnTime > 0) {
      this.spawnTime -= dt;
      const t = 1 - Math.max(0, this.spawnTime) / 0.8;
      this.body.scale.setScalar(Math.max(0.01, t * t));
      this.spawnRing.scale.setScalar((1 - t) * 2.5 + this.radius);
      (this.spawnRing.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t) + 0.1;
      this.object.position.set(this.pos.x, PLAY_Y, this.pos.z);
      if (this.spawnTime <= 0) {
        this.collidable = true;
        this.spawnRing.visible = false;
        this.body.scale.setScalar(1);
      }
      return;
    }
    this.think(ctx, dt);
    this.pos.addScaledVector(this.knock, dt);
    this.knock.multiplyScalar(Math.exp(-8 * dt));
    ctx.arena.clamp(this.pos, this.radius);
    this.object.position.set(this.pos.x, PLAY_Y, this.pos.z);
    if (this.flash > 0) {
      this.flash -= dt;
      const k = Math.max(0, this.flash / 0.08);
      this.edgeMats.forEach((m, i) => m.color.copy(this.baseEdgeColors[i]).lerp(_white, k));
    }
  }

  damage(ctx: GameContext, amount: number, from: THREE.Vector3, source: DamageSource): boolean {
    if (!this.alive || !this.collidable) return false;
    if (!this.vulnerable) {
      this.flash = 0.04;
      return false;
    }
    this.hp -= amount;
    this.flash = 0.08;
    _v.subVectors(this.pos, from).setY(0);
    if (_v.lengthSq() > 0.0001) this.knock.addScaledVector(_v.normalize(), (source === 'dash' ? 16 : 4) * this.knockResist);
    ctx.bus.emit('enemyHit', { pos: this.pos.clone(), kind: this.kind, color: this.color });
    if (this.hp <= 0) this.die(ctx);
    return true;
  }

  die(ctx: GameContext) {
    if (!this.alive) return;
    this.alive = false;
    ctx.bus.emit('enemyKilled', { pos: this.pos.clone(), kind: this.kind, color: this.color, size: this.radius, score: this.scoreValue });
    ctx.bus.emit('explosion', { pos: this.pos.clone(), color: this.color, size: Math.max(1, this.radius * 1.6) });
    this.onDeath(ctx);
  }

  /** Hook for splitters etc. */
  protected onDeath(_ctx: GameContext) {}

  /** Remove without score/explosion (sector transitions). */
  despawn() {
    this.alive = false;
  }

  dispose() {
    this.object.removeFromParent();
    this.object.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
  }

  // ---------- steering helpers ----------

  protected seek(target: THREE.Vector3, speed: number, turn: number, dt: number) {
    _v.subVectors(target, this.pos).setY(0);
    if (_v.lengthSq() > 0.0001) _v.normalize().multiplyScalar(speed);
    this.vel.lerp(_v, 1 - Math.exp(-turn * dt));
  }

  /** Push away from nearby enemies so groups don't stack. */
  protected separate(ctx: GameContext, strength: number, range = this.radius * 2.4) {
    for (const o of ctx.enemies) {
      if (o === this || !o.alive || o.isBoss) continue;
      const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      const r = range + o.radius;
      if (d2 < r * r && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        const f = ((r - d) / r) * strength;
        this.vel.x += (dx / d) * f;
        this.vel.z += (dz / d) * f;
      }
    }
  }

  protected faceVelocity(dt: number, rate = 10) {
    if (this.vel.lengthSq() < 0.01) return;
    const target = Math.atan2(this.vel.x, this.vel.z);
    let d = target - this.body.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.body.rotation.y += d * Math.min(1, rate * dt);
  }
}

const _white = new THREE.Color(4, 4, 4);
