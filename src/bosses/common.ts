import * as THREE from 'three';
import { PLAY_Y } from '../game/config';
import type { Arena } from '../game/Arena';
import type { BossInfo, DamageSource, Enemy, Entity, GameContext } from '../game/types';

// ---------------------------------------------------------------------------------------------
// Shared boss toolkit: hittable parts, coroutine scripts, lasers, floor markers, bullet patterns,
// path trails and the encounter base class (warning -> intro -> phases -> death sequence).
// ---------------------------------------------------------------------------------------------

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _flashWhite = new THREE.Color(4, 4, 4);

export const TAU = Math.PI * 2;

export function glow(hex: number, k = 2.5) {
  return new THREE.Color(hex).multiplyScalar(k);
}

export function lineMat(hex: number, k = 3, opacity = 1) {
  return new THREE.LineBasicMaterial({ color: glow(hex, k), toneMapped: false, transparent: opacity < 1, opacity });
}

export function glowMat(hex: number, k = 2.5, opacity = 1, additive = false) {
  return new THREE.MeshBasicMaterial({
    color: glow(hex, k),
    toneMapped: false,
    transparent: opacity < 1 || additive,
    opacity,
    depthWrite: !(opacity < 1 || additive),
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: THREE.DoubleSide,
  });
}

/** Dark fill + bright edges (same look as enemies). */
export function neonBody(geo: THREE.BufferGeometry, hex: number, edgeK = 3, fillK = 0.12, fillOpacity = 0.9) {
  const group = new THREE.Group();
  const fillMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(fillK), transparent: fillOpacity < 1, opacity: fillOpacity });
  const fill = new THREE.Mesh(geo, fillMat);
  const edgeMat = lineMat(hex, edgeK);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 15), edgeMat);
  group.add(fill, edges);
  return { group, edgeMat, fillMat, fill, edges };
}

/** Pure wireframe (edges only). */
export function wire(geo: THREE.BufferGeometry, hex: number, k = 3, opacity = 1) {
  const mat = lineMat(hex, k, opacity);
  const ls = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 1), mat);
  geo.dispose();
  return { obj: ls, mat };
}

export function disposeTree(o: THREE.Object3D) {
  o.removeFromParent();
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}

export function angleTo(fx: number, fz: number, tx: number, tz: number) {
  return Math.atan2(tz - fz, tx - fx);
}

export function wrapAngle(a: number) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export function easeOutBack(t: number) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/** Distance along a ray until it leaves the arena (binary search, no allocation). */
export function rayToWall(arena: Arena, ox: number, oz: number, dx: number, dz: number, max = 80) {
  if (!arena.contains(ox, oz)) return 0;
  let lo = 0, hi = max;
  for (let i = 0; i < 14; i++) {
    const m = (lo + hi) * 0.5;
    if (arena.contains(ox + dx * m, oz + dz * m)) lo = m;
    else hi = m;
  }
  return lo;
}

// ---------------------------------------------------------------------------------------------
// BossPart: a hittable body driven by its controller (no AI, no knockback, no arena clamp).
// ---------------------------------------------------------------------------------------------

export class BossPart implements Enemy {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  hp: number;
  maxHp: number;
  alive = true;
  collidable = false;
  contactDamage = true;
  vulnerable = true;
  isBoss = true;
  countsForWave = false;
  object = new THREE.Group();
  /** hp never drops below this from damage (phase gates). Controller reacts when hp <= hpFloor. */
  hpFloor = 0;
  /** Damage multiplier (armor / weak points). */
  damageMul = 1;
  /** Seconds since last landed hit. */
  sinceHit = 99;
  onKilled?: (ctx: GameContext, part: BossPart) => void;
  private flash = 0;
  private sparkT = 0;
  private flashMats: THREE.LineBasicMaterial[] = [];
  private flashBase: THREE.Color[] = [];

  constructor(
    ctx: GameContext,
    public kind: string,
    public radius: number,
    hp: number,
    public color: number,
    public scoreValue: number,
  ) {
    this.hp = this.maxHp = hp;
    ctx.scene.add(this.object);
    ctx.addEnemy(this);
  }

  registerFlash(...mats: THREE.LineBasicMaterial[]) {
    for (const m of mats) {
      this.flashMats.push(m);
      this.flashBase.push(m.color.clone());
    }
  }

  /** Update the base colour of a registered material (charge glows etc.). */
  setFlashBase(mat: THREE.LineBasicMaterial, c: THREE.Color) {
    const i = this.flashMats.indexOf(mat);
    if (i >= 0) this.flashBase[i].copy(c);
    if (this.flash <= 0) mat.color.copy(c);
  }

  place(x: number, z: number, y = PLAY_Y) {
    this.pos.set(x, 0, z);
    this.object.position.set(x, y, z);
  }

  update(_ctx: GameContext, dt: number) {
    this.sinceHit += dt;
    this.sparkT -= dt;
    if (this.flash > 0) {
      this.flash -= dt;
      const k = Math.max(0, this.flash / 0.08);
      for (let i = 0; i < this.flashMats.length; i++) this.flashMats[i].color.copy(this.flashBase[i]).lerp(_flashWhite, k);
    }
  }

  damage(ctx: GameContext, amount: number, from: THREE.Vector3, _source: DamageSource): boolean {
    if (!this.alive || !this.collidable) return false;
    if (!this.vulnerable || this.damageMul <= 0) {
      this.flash = Math.max(this.flash, 0.03);
      if (this.sparkT <= 0) {
        this.sparkT = 0.07;
        ctx.vfx.burst(_v.set(from.x, PLAY_Y, from.z), 0xffffff, 3, 6, 0.18, 0.5);
      }
      return false;
    }
    this.hp = Math.max(this.hpFloor, this.hp - amount * this.damageMul);
    this.flash = 0.08;
    this.sinceHit = 0;
    ctx.bus.emit('enemyHit', { pos: this.pos.clone(), kind: this.kind, color: this.color });
    if (this.hp <= 0) this.die(ctx);
    return true;
  }

  /** Killed by the player: score + explosion + callback. */
  die(ctx: GameContext) {
    if (!this.alive) return;
    this.alive = false;
    this.collidable = false;
    this.award(ctx);
    ctx.bus.emit('explosion', { pos: this.pos.clone(), color: this.color, size: Math.max(1, this.radius * 1.6) });
    this.onKilled?.(ctx, this);
  }

  /** Emit the kill event (score) without removing the part (boss cores keep their visuals for the death sequence). */
  award(ctx: GameContext) {
    ctx.bus.emit('enemyKilled', { pos: this.pos.clone(), kind: this.kind, color: this.color, size: this.radius, score: this.scoreValue });
  }

  /** Remove silently (optional visual pop, no score). */
  remove(ctx?: GameContext, pop = false) {
    if (!this.alive) return;
    this.alive = false;
    this.collidable = false;
    if (pop && ctx) {
      ctx.vfx.burst(_v.set(this.pos.x, PLAY_Y, this.pos.z), this.color, 10, 7, 0.4, 0.8);
      ctx.bus.emit('explosion', { pos: this.pos.clone(), color: this.color, size: Math.max(0.8, this.radius) });
    }
  }

  dispose() {
    disposeTree(this.object);
  }
}

// ---------------------------------------------------------------------------------------------
// Script: generator coroutines. `yield seconds` waits (world time); `yield 0` waits one frame.
// ---------------------------------------------------------------------------------------------

export type Seq = Generator<number, void, unknown>;

export class Script {
  private gen: Seq | null = null;
  private wait = 0;
  get running() {
    return this.gen !== null;
  }
  run(g: Seq) {
    this.stop();
    this.gen = g;
    this.wait = 0;
  }
  stop() {
    const g = this.gen;
    this.gen = null;
    if (g) {
      try {
        g.return(undefined);
      } catch {
        /* generator was executing; it is dropped anyway */
      }
    }
  }
  update(dt: number) {
    if (!this.gen) return;
    this.wait -= dt;
    let guard = 0;
    while (this.gen && this.wait <= 0 && guard++ < 64) {
      const g: Seq = this.gen;
      const r = g.next();
      if (this.gen !== g) return; // replaced from inside
      if (r.done) {
        this.gen = null;
        break;
      }
      if (r.value <= 0) {
        this.wait = 0;
        break;
      }
      this.wait += r.value;
    }
  }
}

/** Wait `t` seconds while calling `fn(k)` every frame with k going 0..1. */
export function* tween(t: number, fn: (k: number) => void, clock: { dt: number }): Seq {
  let e = 0;
  fn(0);
  while (e < t) {
    yield 0;
    e += clock.dt;
    fn(Math.min(1, e / t));
  }
}

// ---------------------------------------------------------------------------------------------
// Laser: telegraph line -> thick sweeping beam with its own collision against the player.
// ---------------------------------------------------------------------------------------------

const _laserGeo = (() => {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  g.translate(0.5, 0, 0);
  return g;
})();

export class Laser {
  readonly group = new THREE.Group();
  ox = 0;
  oz = 0;
  angle = 0;
  angVel = 0;
  width = 1.2;
  /** 0 idle, 1 warn, 2 fire, 3 fade */
  state = 0;
  private t = 0;
  private warnTime = 1;
  private fireTime = 2;
  private len = 10;
  private maxLen = 60;
  private warnMesh: THREE.Mesh;
  private glowMesh: THREE.Mesh;
  private coreMesh: THREE.Mesh;
  private flare: THREE.Mesh;
  private warnMat: THREE.MeshBasicMaterial;
  private glowMat: THREE.MeshBasicMaterial;
  private coreMat: THREE.MeshBasicMaterial;
  private flareMat: THREE.MeshBasicMaterial;
  private ghost: THREE.Mesh;
  private ghostMat: THREE.MeshBasicMaterial;
  private ghostAngle = 0;

  constructor(scene: THREE.Scene, private color: number, private warnColor = 0xff2a2a) {
    this.warnMat = glowMat(warnColor, 3, 0.6, true);
    this.ghostMat = glowMat(warnColor, 2, 0.25, true);
    this.glowMat = glowMat(color, 2.4, 0.55, true);
    this.coreMat = glowMat(0xffffff, 3, 1, true);
    this.flareMat = glowMat(color, 3, 0.9, true);
    this.warnMesh = new THREE.Mesh(_laserGeo, this.warnMat);
    this.ghost = new THREE.Mesh(_laserGeo, this.ghostMat);
    this.glowMesh = new THREE.Mesh(_laserGeo, this.glowMat);
    this.coreMesh = new THREE.Mesh(_laserGeo, this.coreMat);
    this.flare = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), this.flareMat);
    for (const m of [this.warnMesh, this.ghost, this.glowMesh, this.coreMesh, this.flare]) {
      m.renderOrder = 7;
      m.frustumCulled = false;
    }
    this.ghost.position.y = -0.02;
    this.coreMesh.position.y = 0.02;
    this.group.add(this.warnMesh, this.ghost, this.glowMesh, this.coreMesh, this.flare);
    this.group.visible = false;
    scene.add(this.group);
  }

  get active() {
    return this.state !== 0;
  }
  get firing() {
    return this.state === 2;
  }

  /**
   * Start: telegraph for `warn` seconds at `angle`, then fire for `fire` seconds rotating at `angVel`.
   * `fire` = 0 -> telegraph only (used for lunges). A dim ghost line marks the sweep end.
   */
  start(ox: number, oz: number, angle: number, warn: number, fire: number, angVel = 0, width = 1.2, maxLen = 60) {
    this.ox = ox;
    this.oz = oz;
    this.angle = angle;
    this.warnTime = warn;
    this.fireTime = fire;
    this.angVel = angVel;
    this.width = width;
    this.maxLen = maxLen;
    this.ghostAngle = angle + angVel * fire;
    this.state = 1;
    this.t = 0;
    this.group.visible = true;
  }

  cancel() {
    if (this.state === 1 || this.state === 2) {
      this.state = 3;
      this.t = 0;
    }
  }

  hide() {
    this.state = 0;
    this.group.visible = false;
  }

  update(ctx: GameContext, dt: number) {
    if (this.state === 0) return;
    this.t += dt;
    const dx = Math.cos(this.angle), dz = Math.sin(this.angle);
    this.len = rayToWall(ctx.arena, this.ox, this.oz, dx, dz, this.maxLen);
    this.group.position.set(this.ox, PLAY_Y - 0.25, this.oz);
    this.group.rotation.y = -this.angle;
    const pulse = 0.5 + 0.5 * Math.sin(ctx.time * 28);

    if (this.state === 1) {
      const k = Math.min(1, this.t / this.warnTime);
      this.warnMesh.visible = true;
      this.glowMesh.visible = this.coreMesh.visible = false;
      this.warnMat.opacity = 0.25 + 0.45 * pulse * (0.4 + k * 0.6);
      this.warnMesh.scale.set(this.len, 1, 0.08 + k * 0.22 + (k > 0.8 ? pulse * 0.25 : 0));
      const showGhost = this.angVel !== 0 && this.fireTime > 0;
      const lane = this.fireTime <= 0;
      this.ghost.visible = showGhost || lane;
      if (lane) {
        // telegraph-only (lunge): faint full-width lane
        this.ghost.rotation.y = 0;
        this.ghost.scale.set(this.len, 1, this.width * (0.6 + 0.4 * k));
        this.ghostMat.opacity = 0.1 + 0.15 * pulse * k;
      } else if (showGhost) {
        this.ghostMat.opacity = 0.25;
        this.ghost.rotation.y = -(this.ghostAngle - this.angle);
        const gl = rayToWall(ctx.arena, this.ox, this.oz, Math.cos(this.ghostAngle), Math.sin(this.ghostAngle), this.maxLen);
        this.ghost.scale.set(gl, 1, 0.08);
      }
      this.flare.visible = true;
      this.flare.scale.setScalar(0.3 + k * 0.6 * (0.8 + pulse * 0.4));
      if (this.t >= this.warnTime) {
        if (this.fireTime <= 0) {
          this.hide();
          return;
        }
        this.state = 2;
        this.t = 0;
        ctx.bus.emit('enemyShoot', { pos: _v.set(this.ox, 0, this.oz).clone(), kind: 'laser' });
        ctx.vfx.shake(0.25);
        ctx.vfx.burst(_v.set(this.ox + dx * 1.5, PLAY_Y, this.oz + dz * 1.5), this.color, 14, 12, 0.35, 1);
      }
    } else if (this.state === 2) {
      this.angle += this.angVel * dt;
      this.warnMesh.visible = this.ghost.visible = false;
      this.glowMesh.visible = this.coreMesh.visible = true;
      const grow = Math.min(1, this.t / 0.08);
      const w = this.width * grow * (1 + 0.1 * Math.sin(ctx.time * 60));
      this.glowMesh.scale.set(this.len, 1, w * 1.7);
      this.coreMesh.scale.set(this.len, 1, w * 0.45);
      this.flare.scale.setScalar(this.width * (1.1 + pulse * 0.3));
      this.collide(ctx);
      if (this.t >= this.fireTime) {
        this.state = 3;
        this.t = 0;
      }
    } else {
      const k = 1 - Math.min(1, this.t / 0.22);
      this.warnMesh.visible = this.ghost.visible = false;
      this.glowMesh.scale.set(this.len, 1, this.width * 1.7 * k);
      this.coreMesh.scale.set(this.len, 1, this.width * 0.45 * k);
      this.flare.scale.setScalar(this.width * k);
      if (k <= 0) this.hide();
    }
  }

  private collide(ctx: GameContext) {
    const p = ctx.player;
    if (!p.alive) return;
    const dx = Math.cos(this.angle), dz = Math.sin(this.angle);
    const px = p.pos.x - this.ox, pz = p.pos.z - this.oz;
    const t = Math.max(0, Math.min(this.len, px * dx + pz * dz));
    const cx = this.ox + dx * t, cz = this.oz + dz * t;
    const r = this.width * 0.5 + p.radius * 0.45;
    const ex = p.pos.x - cx, ez = p.pos.z - cz;
    if (ex * ex + ez * ez < r * r) p.hurt(ctx, _v2.set(cx, 0, cz));
  }

  dispose() {
    this.group.removeFromParent();
    this.flare.geometry.dispose();
    this.warnMat.dispose();
    this.ghostMat.dispose();
    this.glowMat.dispose();
    this.coreMat.dispose();
    this.flareMat.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Marker: pulsing floor ring + faint fill (danger zones, spawn portals).
// ---------------------------------------------------------------------------------------------

export class Marker {
  readonly group = new THREE.Group();
  private ringMat: THREE.MeshBasicMaterial;
  private fillMat: THREE.MeshBasicMaterial;
  private t = 0;
  private dur = 1;
  active = false;
  x = 0;
  z = 0;
  radius = 1;

  constructor(scene: THREE.Scene, color: number, private fillOpacity = 0.1) {
    this.ringMat = glowMat(color, 3, 0.8, true);
    this.fillMat = glowMat(color, 1.5, fillOpacity, true);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 96), this.ringMat);
    const fill = new THREE.Mesh(new THREE.CircleGeometry(1, 64), this.fillMat);
    ring.rotation.x = fill.rotation.x = -Math.PI / 2;
    fill.position.y = -0.01;
    ring.renderOrder = fill.renderOrder = 4;
    this.group.add(ring, fill);
    this.group.visible = false;
    scene.add(this.group);
  }

  show(x: number, z: number, radius: number, dur: number) {
    this.x = x;
    this.z = z;
    this.radius = radius;
    this.dur = dur;
    this.t = 0;
    this.active = true;
    this.group.visible = true;
  }

  hide() {
    this.active = false;
    this.group.visible = false;
  }

  update(ctx: GameContext, dt: number) {
    if (!this.active) return;
    this.t += dt;
    const k = Math.min(1, this.t / this.dur);
    const pulse = 0.5 + 0.5 * Math.sin(ctx.time * (14 + k * 20));
    this.ringMat.opacity = (0.35 + 0.55 * pulse) * (k > 0.9 ? (1 - k) * 10 : 1);
    this.fillMat.opacity = this.fillOpacity * (0.5 + k);
    this.group.position.set(this.x, 0.06, this.z);
    this.group.scale.setScalar(Math.max(0.01, this.radius));
    if (this.t >= this.dur) this.hide();
  }

  dispose() {
    disposeTree(this.group);
  }
}

// ---------------------------------------------------------------------------------------------
// Bullet patterns (speeds scaled by difficulty here).
// ---------------------------------------------------------------------------------------------

export interface ShotOpts {
  radius?: number;
  life?: number;
  accel?: number;
  curve?: number;
}

export function shoot(ctx: GameContext, x: number, z: number, angle: number, speed: number, color: number, o?: ShotOpts) {
  const s = speed * ctx.difficulty.enemyBulletSpeed;
  ctx.enemyBullets.spawn({
    x,
    z,
    vx: Math.cos(angle) * s,
    vz: Math.sin(angle) * s,
    color,
    radius: o?.radius ?? 0.32,
    life: o?.life ?? 7,
    accel: o?.accel ?? 0,
    curve: o?.curve ?? 0,
    tag: (Math.random() * 100) | 0,
  });
}

/**
 * Ring of `count` bullets starting at `offset`, skipping `gaps` evenly spaced gaps of `gapWidth` radians
 * centred at `gapAt` (+k*TAU/gaps). `startR` spawns them away from the centre.
 */
export function ringShot(
  ctx: GameContext, x: number, z: number, count: number, speed: number, color: number,
  offset = 0, gaps = 0, gapAt = 0, gapWidth = 0, startR = 0, o?: ShotOpts,
) {
  for (let i = 0; i < count; i++) {
    const a = offset + (i / count) * TAU;
    if (gaps > 0) {
      let skip = false;
      for (let g = 0; g < gaps; g++) {
        if (Math.abs(wrapAngle(a - (gapAt + (g / gaps) * TAU))) < gapWidth * 0.5) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
    }
    shoot(ctx, x + Math.cos(a) * startR, z + Math.sin(a) * startR, a, speed, color, o);
  }
}

export function fanShot(ctx: GameContext, x: number, z: number, angle: number, count: number, spread: number, speed: number, color: number, startR = 0, o?: ShotOpts) {
  for (let i = 0; i < count; i++) {
    const a = count > 1 ? angle - spread / 2 + (spread * i) / (count - 1) : angle;
    shoot(ctx, x + Math.cos(a) * startR, z + Math.sin(a) * startR, a, speed, color, o);
  }
}

/** Fire-rate scaled interval. */
export function interval(ctx: GameContext, s: number) {
  return s / ctx.difficulty.enemyFireRate;
}

// ---------------------------------------------------------------------------------------------
// PathTrail: fixed-step ring buffer of head positions; sample any distance behind the head.
// ---------------------------------------------------------------------------------------------

export class PathTrail {
  private xs: Float32Array;
  private zs: Float32Array;
  private head = 0;
  private count = 0;
  curX = 0;
  curZ = 0;

  constructor(readonly step: number, private n = 512) {
    this.xs = new Float32Array(n);
    this.zs = new Float32Array(n);
  }

  reset(x: number, z: number) {
    this.head = 0;
    this.count = 1;
    this.xs[0] = x;
    this.zs[0] = z;
    this.curX = x;
    this.curZ = z;
  }

  /** Seed from a polyline ordered head -> tail. */
  seed(pts: { x: number; z: number }[]) {
    const last = pts[pts.length - 1];
    this.reset(last.x, last.z);
    for (let i = pts.length - 2; i >= 0; i--) this.move(pts[i].x, pts[i].z);
  }

  move(x: number, z: number) {
    this.curX = x;
    this.curZ = z;
    let lx = this.xs[this.head], lz = this.zs[this.head];
    let dx = x - lx, dz = z - lz;
    let d = Math.hypot(dx, dz);
    let guard = 0;
    while (d >= this.step && guard++ < 256) {
      lx += (dx / d) * this.step;
      lz += (dz / d) * this.step;
      this.head = (this.head + 1) % this.n;
      this.xs[this.head] = lx;
      this.zs[this.head] = lz;
      this.count = Math.min(this.count + 1, this.n);
      dx = x - lx;
      dz = z - lz;
      d = Math.hypot(dx, dz);
    }
  }

  sample(dist: number, out: THREE.Vector3) {
    const hx = this.xs[this.head], hz = this.zs[this.head];
    const d0 = Math.hypot(this.curX - hx, this.curZ - hz);
    if (dist <= d0) {
      const k = d0 > 0 ? dist / d0 : 0;
      return out.set(this.curX + (hx - this.curX) * k, 0, this.curZ + (hz - this.curZ) * k);
    }
    const r = (dist - d0) / this.step;
    const i = Math.floor(r);
    if (i >= this.count - 1) {
      const idx = (this.head - (this.count - 1) + this.n * 2) % this.n;
      return out.set(this.xs[idx], 0, this.zs[idx]);
    }
    const f = r - i;
    const a = (this.head - i + this.n) % this.n;
    const b = (this.head - i - 1 + this.n) % this.n;
    return out.set(this.xs[a] + (this.xs[b] - this.xs[a]) * f, 0, this.zs[a] + (this.zs[b] - this.zs[a]) * f);
  }
}

// ---------------------------------------------------------------------------------------------
// BossEncounter base: warning -> materialise intro -> fight (phases) -> death sequence.
// ---------------------------------------------------------------------------------------------

export interface Killable extends Entity {
  kill(ctx: GameContext, pop: boolean): void;
}

export abstract class BossEncounter implements Entity {
  alive = true;
  phase = 1;
  /** 'intro' | 'fight' | 'transition' | 'dying' | 'done' */
  mode: 'intro' | 'fight' | 'transition' | 'dying' | 'done' = 'intro';
  /** World dt of the current frame (for tweens inside scripts). */
  readonly clock = { dt: 0 };
  readonly root = new THREE.Group();
  protected main = new Script();
  protected aux = new Script();
  protected fx = new Script();
  protected lasers: Laser[] = [];
  protected markers: Marker[] = [];
  protected minions: Killable[] = [];
  /** 0..1 materialise progress during intro. */
  protected introK = 0;
  protected info: BossInfo;
  protected ctx: GameContext;

  constructor(
    ctx: GameContext,
    readonly name: string,
    readonly title: string,
    readonly phases: number,
    protected onDefeated: () => void,
  ) {
    this.ctx = ctx;
    ctx.scene.add(this.root);
    const self = this;
    this.info = {
      name,
      title,
      phase: 1,
      phases,
      health: () => self.health(),
    };
  }

  /** All hittable parts (for global invulnerability / collidable toggles). */
  protected abstract parts(): BossPart[];
  abstract health(): number;
  /** Centre of the intro effect. */
  protected abstract introCenter(out: THREE.Vector3): THREE.Vector3;
  /** Radius the boss occupies on spawn (player gets pushed out of it). */
  protected abstract footprint(): number;
  protected abstract onSpawned(ctx: GameContext): void;
  /** Start attack scripts for a phase. */
  protected abstract beginPhase(ctx: GameContext, phase: number): void;
  /** Per-frame visuals / movement / threshold checks. */
  protected abstract tick(ctx: GameContext, dt: number): void;
  /** Points to explode during the death sequence. */
  protected abstract deathPoint(i: number, out: THREE.Vector3): THREE.Vector3;
  protected abstract deathColor(): number;
  protected onDeathStart(_ctx: GameContext) {}
  protected onDeathEnd(_ctx: GameContext) {}
  /** Called during transitions (k 0..1) for the visual flourish. */
  protected onTransition(_ctx: GameContext, _k: number) {}

  start() {
    this.ctx.bus.emit('bossWarning', { name: this.name, title: this.title });
    this.fx.run(this.introSeq(this.ctx));
  }

  protected addLaser(color: number, warnColor?: number) {
    const l = new Laser(this.ctx.scene, color, warnColor);
    this.lasers.push(l);
    return l;
  }

  protected addMarker(color: number, fill = 0.1) {
    const m = new Marker(this.ctx.scene, color, fill);
    this.markers.push(m);
    return m;
  }

  protected freeLaser() {
    for (const l of this.lasers) if (!l.active) return l;
    return this.lasers[0];
  }

  protected freeMarker() {
    for (const m of this.markers) if (!m.active) return m;
    return this.markers[0];
  }

  update(ctx: GameContext, dt: number) {
    this.ctx = ctx;
    this.clock.dt = dt;
    this.fx.update(dt);
    if (this.mode === 'fight') {
      this.main.update(dt);
      this.aux.update(dt);
    }
    for (let i = this.minions.length - 1; i >= 0; i--) if (!this.minions[i].alive) this.minions.splice(i, 1);
    this.tick(ctx, dt);
    for (const l of this.lasers) l.update(ctx, dt);
    for (const m of this.markers) m.update(ctx, dt);
  }

  protected setCollidable(on: boolean) {
    for (const p of this.parts()) if (p.alive) p.collidable = on;
  }

  protected cancelHazards() {
    for (const l of this.lasers) l.cancel();
    for (const m of this.markers) m.hide();
  }

  // ---------- intro ----------

  private *introSeq(ctx: GameContext): Seq {
    this.mode = 'intro';
    const c = this.introCenter(new THREE.Vector3());
    const fp = this.footprint();
    const warn = this.addMarker(0xff3030, 0.08);
    warn.show(c.x, c.z, fp + 1, 2.5);
    const total = 2.5;
    let e = 0;
    let ringT = 0;
    let burstT = 0;
    const col = this.deathColor();
    const p = new THREE.Vector3();
    while (e < total) {
      yield 0;
      const dt = this.clock.dt;
      e += dt;
      ringT -= dt;
      burstT -= dt;
      this.introK = Math.min(1, e / total);
      ctx.vfx.shake(dt * 0.35 * this.introK);
      if (ringT <= 0) {
        ringT = 0.45 - this.introK * 0.25;
        ctx.vfx.ring(p.set(c.x, PLAY_Y, c.z), col, fp * (2.4 - this.introK * 1.2), 0.5);
        ctx.vfx.gridImpulse(p, 0.6 + this.introK, fp * 2);
      }
      if (burstT <= 0) {
        burstT = 0.06;
        // particles spiral in toward the centre
        const a = e * 7;
        const r = (1 - this.introK) * fp * 3 + 1;
        ctx.vfx.burst(p.set(c.x + Math.cos(a) * r, PLAY_Y, c.z + Math.sin(a) * r), col, 4, 3, 0.4, 0.8);
        ctx.vfx.burst(p.set(c.x - Math.cos(a) * r, PLAY_Y, c.z - Math.sin(a) * r), 0xffffff, 2, 3, 0.3, 0.6);
      }
    }
    this.introK = 1;
    warn.hide();
    // push the player out of the footprint rather than hurting them
    const pl = ctx.player;
    const dx = pl.pos.x - c.x, dz = pl.pos.z - c.z;
    const d = Math.hypot(dx, dz);
    const need = fp + pl.radius + 1.2;
    if (d < need) {
      const nx = d > 0.01 ? dx / d : 0, nz = d > 0.01 ? dz / d : 1;
      pl.pos.set(c.x + nx * need, 0, c.z + nz * need);
      ctx.arena.clamp(pl.pos, pl.radius);
      pl.invuln = Math.max(pl.invuln, 0.6);
      ctx.vfx.burst(p.set(pl.pos.x, PLAY_Y, pl.pos.z), 0xffffff, 12, 8, 0.4, 0.8);
    }
    ctx.bus.emit('bossSpawn', { name: this.name });
    ctx.bus.emit('explosion', { pos: c.clone(), color: col, size: 4 });
    ctx.vfx.flash(col, 0.6);
    ctx.vfx.shake(0.7);
    ctx.vfx.ring(p.set(c.x, PLAY_Y, c.z), col, fp * 4, 0.8);
    ctx.vfx.ring(p, 0xffffff, fp * 2.5, 0.5);
    ctx.vfx.gridImpulse(p, 3, fp * 5);
    ctx.setBoss(this.info);
    this.onSpawned(ctx);
    this.setCollidable(true);
    this.mode = 'fight';
    this.beginPhase(ctx, 1);
  }

  // ---------- phases ----------

  protected transitionTo(phase: number, duration = 1.8) {
    if (this.mode !== 'fight') return;
    const ctx = this.ctx;
    this.mode = 'transition';
    this.main.stop();
    this.aux.stop();
    this.cancelHazards();
    this.phase = phase;
    this.info.phase = phase;
    const parts = this.parts().slice();
    const vul = parts.map((p) => p.vulnerable);
    for (const p of parts) p.vulnerable = false;
    ctx.bus.emit('bossPhase', { name: this.name, phase });
    const self = this;
    this.fx.run(
      (function* (): Seq {
        const c = self.introCenter(new THREE.Vector3());
        // clear hostile fire so the phase change is a breather, not an ambush
        for (const b of ctx.enemyBullets.items) {
          if (b.active) {
            b.active = false;
            ctx.vfx.burst(_v.set(b.x, PLAY_Y, b.z), b.color.getHex(), 1, 2, 0.25, 0.5);
          }
        }
        ctx.vfx.flash(0xffffff, 0.45);
        ctx.vfx.shake(0.6);
        ctx.hitStop(0.12);
        ctx.bus.emit('explosion', { pos: c.clone(), color: self.deathColor(), size: 3 });
        let e = 0;
        let rt = 0;
        while (e < duration) {
          yield 0;
          e += self.clock.dt;
          rt -= self.clock.dt;
          self.introCenter(c);
          if (rt <= 0) {
            rt = 0.3;
            ctx.vfx.ring(_v.set(c.x, PLAY_Y, c.z), self.deathColor(), self.footprint() * 2.2, 0.45);
            ctx.vfx.gridImpulse(_v, 1.2, self.footprint() * 3);
          }
          self.onTransition(ctx, Math.min(1, e / duration));
        }
        parts.forEach((p, i) => (p.vulnerable = vul[i]));
        self.mode = 'fight';
        self.beginPhase(ctx, phase);
      })(),
    );
  }

  // ---------- death ----------

  protected killMinions(ctx: GameContext) {
    for (const m of this.minions) m.kill(ctx, true);
    this.minions.length = 0;
  }

  protected startDeath(core: BossPart) {
    if (this.mode === 'dying' || this.mode === 'done') return;
    const ctx = this.ctx;
    this.mode = 'dying';
    this.main.stop();
    this.aux.stop();
    this.cancelHazards();
    core.hp = 0;
    core.award(ctx);
    this.setCollidable(false);
    for (const p of this.parts()) p.contactDamage = false;
    this.info.phase = this.phases;
    const self = this;
    this.fx.run(
      (function* (): Seq {
        ctx.hitStop(0.25);
        ctx.vfx.flash(0xffffff, 0.8);
        for (const b of ctx.enemyBullets.items) {
          if (b.active) {
            b.active = false;
            ctx.vfx.burst(_v.set(b.x, PLAY_Y, b.z), b.color.getHex(), 1, 2, 0.3, 0.5);
          }
        }
        self.killMinions(ctx);
        self.onDeathStart(ctx);
        const n = 12;
        const p = new THREE.Vector3();
        for (let i = 0; i < n; i++) {
          const k = i / (n - 1);
          self.deathPoint(i, p);
          ctx.bus.emit('explosion', { pos: p.clone(), color: i % 3 === 0 ? 0xffffff : self.deathColor(), size: 1.5 + k * 3.5 });
          ctx.vfx.burst(_v.set(p.x, PLAY_Y, p.z), self.deathColor(), 14 + i * 2, 8 + k * 8, 0.6, 1.2);
          ctx.vfx.shake(0.15 + k * 0.2);
          if (i % 4 === 3) ctx.vfx.flash(self.deathColor(), 0.25 + k * 0.3);
          yield 0.17 - k * 0.06;
        }
        self.introCenter(p);
        ctx.hitStop(0.35);
        ctx.vfx.flash(0xffffff, 1);
        ctx.vfx.shake(1);
        ctx.bus.emit('explosion', { pos: p.clone(), color: 0xffffff, size: 9 });
        ctx.bus.emit('explosion', { pos: p.clone(), color: self.deathColor(), size: 7 });
        ctx.vfx.ring(_v.set(p.x, PLAY_Y, p.z), self.deathColor(), 30, 1.2);
        ctx.vfx.ring(_v, 0xffffff, 18, 0.8);
        ctx.vfx.gridImpulse(_v, 6, 30);
        ctx.vfx.burst(_v, 0xffffff, 80, 22, 1.2, 1.6);
        ctx.vfx.burst(_v, self.deathColor(), 120, 16, 1.6, 1.4);
        for (const part of self.parts()) part.remove();
        self.root.visible = false;
        self.onDeathEnd(ctx);
        yield 0.5;
        ctx.setBoss(null);
        ctx.bus.emit('bossKilled', { name: self.name, pos: p.clone() });
        self.mode = 'done';
        self.alive = false;
        const cb = self.onDefeated;
        self.onDefeated = () => {};
        cb();
      })(),
    );
  }

  dispose() {
    this.main.stop();
    this.aux.stop();
    this.fx.stop();
    for (const p of this.parts()) p.remove();
    for (const m of this.minions) m.kill(this.ctx, false);
    for (const l of this.lasers) l.dispose();
    for (const m of this.markers) m.dispose();
    this.lasers.length = 0;
    this.markers.length = 0;
    disposeTree(this.root);
  }
}
