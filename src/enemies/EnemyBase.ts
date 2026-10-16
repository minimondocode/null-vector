import * as THREE from 'three';
import { PLAY_Y } from '../game/config';
import type { DamageSource, Enemy, GameContext } from '../game/types';
import { rollDrop } from '../game/Pickups';

const _v = new THREE.Vector3();

export function glowColor(hex: number, k = 2.5) {
  return new THREE.Color(hex).multiplyScalar(k);
}

/**
 * Global enemy scaling, set by the Director per wave (on top of ctx.difficulty).
 * `tier` selects attack variants: 0 = sector 1, 1 = sector 2, 2 = sector 3 / late endless.
 */
export const tuning = { hp: 1, speed: 1, fire: 1, tier: 0 };

export function scaledHp(ctx: GameContext, base: number) {
  return base * ctx.difficulty.enemyHp * tuning.hp;
}
export function scaledSpeed(ctx: GameContext, base: number) {
  return base * ctx.difficulty.enemySpeed * tuning.speed;
}
/** Multiplier for cooldowns: >1 fires more often. */
export function fireRate(ctx: GameContext) {
  return ctx.difficulty.enemyFireRate * tuning.fire;
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

const geoCache = new Map<string, { geo: THREE.BufferGeometry; edges: THREE.BufferGeometry }>();

/** Cached geometry (fill + edges) shared by every instance of a kind. Not disposed with the enemy. */
export function sharedGeo(key: string, make: () => THREE.BufferGeometry) {
  let g = geoCache.get(key);
  if (!g) {
    const geo = make();
    const edges = new THREE.EdgesGeometry(geo, 15);
    geo.userData.shared = true;
    edges.userData.shared = true;
    g = { geo, edges };
    geoCache.set(key, g);
  }
  return g;
}

/** Same as neonMesh but with cached geometry — use for anything spawned often. */
export function neonShared(key: string, make: () => THREE.BufferGeometry, color: number, edgeBoost = 3, fillOpacity = 0.85) {
  const { geo, edges } = sharedGeo(key, make);
  const group = new THREE.Group();
  const fill = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(0.12), transparent: fillOpacity < 1, opacity: fillOpacity }),
  );
  const edgeMat = new THREE.LineBasicMaterial({ color: glowColor(color, edgeBoost), toneMapped: false });
  group.add(fill, new THREE.LineSegments(edges, edgeMat));
  return { group, edgeMat, fill };
}

/** Additive, unlit, floor-friendly material for telegraphs. */
export function telegraphMat(color: number, opacity = 0.5) {
  return new THREE.MeshBasicMaterial({
    color: glowColor(color, 2),
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
  });
}

/** Flat strip starting at origin and extending `length` along +Z (rotate.y = atan2(dx, dz) to aim). */
export function stripGeo(width: number, length: number) {
  const g = new THREE.PlaneGeometry(width, length);
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0, length / 2);
  return g;
}

/**
 * Shared enemy behaviour: spawn-in telegraph, hit flash, hit punch, knockback, death event, drops.
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
  protected spawnDuration: number;
  protected flash = 0;
  /** 0..1 squash "punch" on hit; applied to `object.scale`. */
  protected punch = 0;
  protected edgeMats: THREE.LineBasicMaterial[] = [];
  private baseEdgeColors: THREE.Color[] = [];
  private spawnRing: THREE.Mesh;
  private announced = false;
  /** Knockback velocity, decays quickly. */
  protected knock = new THREE.Vector3();
  /** Multiplier on knockback received. 0 = immovable. */
  protected knockResist = 1;
  /** Pickup drop weight on death (0 = never drops). */
  protected dropTier = 0;
  /** Last dash id that hurt this enemy. */
  lastDashId = -1;

  constructor(ctx: GameContext, x: number, z: number, color: number, spawnTime = 0.8) {
    this.color = color;
    this.pos.set(x, 0, z);
    this.spawnTime = spawnTime;
    this.spawnDuration = Math.max(0.0001, spawnTime);
    this.object.add(this.body);
    this.spawnRing = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.0, 32),
      new THREE.MeshBasicMaterial({ color: glowColor(color, 2), transparent: true, opacity: 0.8, side: THREE.DoubleSide, toneMapped: false, depthWrite: false }),
    );
    this.spawnRing.rotation.x = -Math.PI / 2;
    this.spawnRing.position.y = -PLAY_Y + 0.05;
    this.object.add(this.spawnRing);
    this.object.position.set(x, PLAY_Y, z);
    if (spawnTime <= 0) {
      this.collidable = true;
      this.spawnRing.visible = false;
    } else {
      this.body.scale.setScalar(0.01);
    }
    ctx.scene.add(this.object);
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
    if (!this.announced) {
      this.announced = true;
      ctx.bus.emit('enemySpawn', { pos: this.pos.clone(), kind: this.kind });
    }
    if (this.spawnTime > 0) {
      this.spawnTime -= dt;
      const t = 1 - Math.max(0, this.spawnTime) / this.spawnDuration;
      // overshoot pop at the end of the materialise
      const s = t < 0.8 ? (t / 0.8) ** 2 : 1 + Math.sin(((t - 0.8) / 0.2) * Math.PI) * 0.18;
      this.body.scale.setScalar(Math.max(0.01, s));
      this.body.rotation.y += dt * (1 - t) * 14;
      this.spawnRing.scale.setScalar((1 - t) * 2.5 + this.radius);
      (this.spawnRing.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t) + 0.1;
      this.object.position.set(this.pos.x, PLAY_Y, this.pos.z);
      if (this.spawnTime <= 0) {
        this.collidable = true;
        this.spawnRing.visible = false;
        this.body.scale.setScalar(1);
        this.onSpawned(ctx);
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
      for (let i = 0; i < this.edgeMats.length; i++) this.edgeMats[i].color.copy(this.baseEdgeColors[i]).lerp(_white, k);
    }
    if (this.punch > 0) {
      this.punch = Math.max(0, this.punch - dt * 7);
      const p = this.punch;
      this.object.scale.set(1 + p * 0.28, 1 - p * 0.2, 1 + p * 0.28);
    } else if (this.object.scale.x !== 1) {
      this.object.scale.setScalar(1);
    }
  }

  /** Called once when the spawn telegraph finishes. */
  protected onSpawned(_ctx: GameContext) {}

  damage(ctx: GameContext, amount: number, from: THREE.Vector3, source: DamageSource): boolean {
    if (!this.alive || !this.collidable) return false;
    if (!this.vulnerable) {
      this.flash = 0.04;
      return false;
    }
    this.hp -= amount;
    this.flash = 0.08;
    this.punch = Math.min(1, this.punch + 0.6);
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
    if (this.dropTier > 0) rollDrop(ctx, this.pos, this.dropTier);
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
      if (m.geometry && !m.geometry.userData.shared) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
  }

  // ---------- helpers ----------

  protected seek(target: THREE.Vector3, speed: number, turn: number, dt: number) {
    _v.subVectors(target, this.pos).setY(0);
    if (_v.lengthSq() > 0.0001) _v.normalize().multiplyScalar(speed);
    this.vel.lerp(_v, 1 - Math.exp(-turn * dt));
  }

  /** Push away from nearby enemies so groups don't stack. */
  protected separate(ctx: GameContext, strength: number, range = this.radius * 2.4) {
    for (const o of ctx.enemies) {
      if (o === this || !o.alive || o.isBoss || !o.countsForWave) continue;
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

  /** Steer away from arena walls when closer than `margin`. */
  protected avoidWalls(ctx: GameContext, margin: number, strength: number) {
    const d = ctx.arena.distanceToEdge(this.pos.x, this.pos.z);
    if (d >= margin) return;
    const l = Math.hypot(this.pos.x, this.pos.z) || 1;
    const f = ((margin - d) / margin) * strength;
    this.vel.x -= (this.pos.x / l) * f;
    this.vel.z -= (this.pos.z / l) * f;
  }

  protected faceVelocity(dt: number, rate = 10) {
    if (this.vel.lengthSq() < 0.01) return;
    const target = Math.atan2(this.vel.x, this.vel.z);
    let d = target - this.body.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.body.rotation.y += d * Math.min(1, rate * dt);
  }

  /** Fire one enemy bullet along `angle` (atan2(x, z) convention). Speed/bullet scaling applied. */
  protected shoot(ctx: GameContext, angle: number, speed: number, color: number, radius = 0.3, offset = 0.9, accel = 0, curve = 0) {
    const sp = speed * ctx.difficulty.enemyBulletSpeed;
    const sx = Math.sin(angle), cz = Math.cos(angle);
    ctx.enemyBullets.spawn({
      x: this.pos.x + sx * offset,
      z: this.pos.z + cz * offset,
      vx: sx * sp,
      vz: cz * sp,
      life: 5,
      radius,
      color,
      accel,
      curve,
      tag: (Math.random() * 100) | 0,
    });
  }

  protected angleToPlayer(ctx: GameContext) {
    return Math.atan2(ctx.player.pos.x - this.pos.x, ctx.player.pos.z - this.pos.z);
  }

  protected distToPlayer(ctx: GameContext) {
    return Math.hypot(ctx.player.pos.x - this.pos.x, ctx.player.pos.z - this.pos.z);
  }
}

/** Shortest signed angle difference a->b. */
export function angleDiff(a: number, b: number) {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return d;
}

const _white = new THREE.Color(4, 4, 4);
