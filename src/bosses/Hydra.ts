import * as THREE from 'three';
import { PLAY_Y } from '../game/config';
import type { GameContext } from '../game/types';
import {
  BossEncounter, BossPart, TAU, angleTo, fanShot, glowMat, interval, ringShot, shoot, tween, wire, type Seq,
} from './common';
import { Serpent, type SerpentOpts } from './Serpent';

// ---- tuning knobs ----
const SEGMENTS = 10;
const SEG_HP = 42;
const HEAD_HP = 1300;
/** Phase 2 starts (head unarmored) when attached segments <= this. */
const P2_SEGMENTS = 5;
/** Phase 3 at this fraction of head hp. */
const P3_AT = 0.45;
const MAX_MINIS = 3;
const SCORE = 40000;

const MAGENTA = 0xff2bd6;
const VIOLET = 0x8a2bff;
const GREEN = 0x39ff8b;
const LIME = 0xb6ff3b;

const _v = new THREE.Vector3();

/**
 * HYDRA.DLL — serpent with destructible body. Each lost segment either splits the tail off as a
 * mini-serpent (rear segments) or replicates a small one from the wound while the body closes the gap.
 * P1: head armored; spit cones, spiral barrages, telegraphed lunges.
 * P2 (<= 5 segments): head exposed, faster, lunges end with a wall burst.
 * P3 (head < 45%): enraged — twin spit cones, 4-arm alternating spirals, double lunges.
 */
export class Hydra extends BossEncounter {
  private serpent: Serpent;
  private spawn = new THREE.Vector3();
  private armor: THREE.LineSegments;
  private armorMat: THREE.LineBasicMaterial;
  private armorK = 1;
  private segMax: number;
  private portal: THREE.Mesh;
  private portalMat: THREE.MeshBasicMaterial;
  private lunging = false;
  private baseSpeed = 7;
  private allParts: BossPart[] = [];

  constructor(ctx: GameContext, onDefeated: () => void) {
    super(ctx, 'HYDRA.DLL', 'SELF-REPLICATING PAYLOAD', 3, onDefeated);
    const hp = ctx.difficulty.enemyHp;
    // emerge on the side of the arena away from the player
    const p = ctx.player.pos;
    const pl = Math.hypot(p.x, p.z);
    const r = ctx.arena.size * 0.45;
    if (pl > 0.5) this.spawn.set((-p.x / pl) * r, 0, (-p.z / pl) * r);
    else this.spawn.set(0, 0, -r);

    const opts: SerpentOpts = {
      kind: 'hydra',
      segments: SEGMENTS,
      headRadius: 1.6,
      segRadius: 1.15,
      tailRadius: 0.75,
      spacing: 1.75,
      headHp: HEAD_HP * hp,
      segHp: SEG_HP * hp,
      color: MAGENTA,
      accent: GREEN,
      bulletColor: GREEN,
      speed: 0,
      turnRate: 2.2,
      headScore: SCORE,
      segScore: 700,
      ai: false,
    };
    const heading = angleTo(this.spawn.x, this.spawn.z, p.x, p.z);
    this.serpent = new Serpent(ctx, this.spawn.x, this.spawn.z, heading, opts);
    this.segMax = SEG_HP * hp * SEGMENTS;
    this.serpent.head.vulnerable = false;
    this.serpent.head.hpFloor = this.serpent.head.maxHp * P3_AT;
    this.serpent.onSegmentLost = (c, i, tail) => this.onSegmentLost(c, i, tail);
    for (const s of this.serpent.segs) s.object.visible = false;

    // armor cage around the head (phase 1)
    const a = wire(new THREE.IcosahedronGeometry(2.3, 0), LIME, 2.2, 0.8);
    this.armor = a.obj;
    this.armorMat = a.mat;
    this.serpent.head.object.add(this.armor);

    // spawn portal
    this.portalMat = glowMat(VIOLET, 2.5, 0.8, true);
    this.portal = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.4, 6), this.portalMat);
    this.portal.rotation.x = -Math.PI / 2;
    this.portal.position.set(this.spawn.x, 0.08, this.spawn.z);
    this.root.add(this.portal);

    this.addLaser(GREEN, 0xff2a6a);
    this.addMarker(GREEN, 0.08);
    this.addMarker(GREEN, 0.08);
  }

  protected parts() {
    this.allParts.length = 0;
    return this.serpent.allParts(this.allParts);
  }

  health() {
    const h = this.serpent.head;
    let seg = 0;
    for (const s of this.serpent.segs) if (s.alive) seg += Math.max(0, s.hp);
    return Math.max(0, 0.3 * (seg / this.segMax) + 0.7 * (h.hp / h.maxHp));
  }

  protected introCenter(out: THREE.Vector3) {
    if (this.mode === 'intro') return out.copy(this.spawn);
    return out.set(this.serpent.pos.x, 0, this.serpent.pos.z);
  }
  protected footprint() {
    return 3;
  }
  protected deathColor() {
    return MAGENTA;
  }
  protected deathPoint(i: number, out: THREE.Vector3) {
    const segs = this.serpent.segs;
    if (i % 2 === 0 || segs.length === 0) return out.set(this.serpent.pos.x + (Math.random() - 0.5) * 2, 0, this.serpent.pos.z + (Math.random() - 0.5) * 2);
    const s = segs[Math.floor(Math.random() * segs.length)];
    return out.set(s.pos.x, 0, s.pos.z);
  }

  protected onSpawned(ctx: GameContext) {
    for (const s of this.serpent.segs) s.object.visible = true;
    this.serpent.speed = this.baseSpeed;
    ctx.addEntity(this.serpent);
  }

  private onSegmentLost(ctx: GameContext, index: number, tail: BossPart[]) {
    const wound = new THREE.Vector3();
    this.serpent.trail.sample(1.6 * index + 2, wound);
    ctx.vfx.ring(_v.set(wound.x, PLAY_Y, wound.z), GREEN, 3.5, 0.35);
    const canSpawn = this.minions.length < MAX_MINIS && this.mode === 'fight';
    if (tail.length > 0 && tail.length <= 3) {
      // rear split: the tail breaks off as its own serpent
      if (canSpawn && tail.length >= 2) {
        const seed = tail.map((t) => ({ x: t.pos.x, z: t.pos.z }));
        const h = tail[0];
        const heading = tail.length > 1 ? angleTo(tail[1].pos.x, tail[1].pos.z, h.pos.x, h.pos.z) : Math.random() * TAU;
        this.spawnMini(ctx, h.pos.x, h.pos.z, heading, tail.length - 1, seed);
        for (const t of tail) t.remove(ctx, false);
        ctx.vfx.burst(_v.set(h.pos.x, PLAY_Y, h.pos.z), GREEN, 16, 8, 0.4, 0.9);
      } else {
        this.serpent.pop(tail);
      }
    } else {
      // body closes the gap; the wound replicates a small serpent
      this.serpent.reattach(tail);
      if (canSpawn) this.spawnMini(ctx, wound.x, wound.z, this.serpent.heading + Math.PI * (Math.random() < 0.5 ? 0.5 : -0.5), 2);
    }
  }

  private spawnMini(ctx: GameContext, x: number, z: number, heading: number, segs: number, seed?: { x: number; z: number }[]) {
    const hp = ctx.difficulty.enemyHp;
    const m = new Serpent(
      ctx, x, z, heading,
      {
        kind: 'hydra-mini',
        segments: Math.max(1, Math.min(3, segs)),
        headRadius: 0.85,
        segRadius: 0.65,
        tailRadius: 0.5,
        spacing: 1.05,
        headHp: 24 * hp,
        segHp: 12 * hp,
        color: VIOLET,
        accent: GREEN,
        bulletColor: LIME,
        speed: 6 * ctx.difficulty.enemySpeed,
        turnRate: 2.6,
        headScore: 400,
        segScore: 150,
        ai: true,
      },
      seed,
    );
    m.setCollidable(true);
    ctx.addEntity(m);
    this.minions.push(m);
    ctx.bus.emit('enemySpawn', { pos: m.pos.clone(), kind: 'hydra-mini' });
  }

  // ---------------- per-frame ----------------

  protected tick(ctx: GameContext, dt: number) {
    const s = this.serpent;
    if (this.mode === 'intro') {
      const k = this.introK;
      s.head.object.visible = k > 0.6 || Math.random() < k;
      s.head.object.scale.setScalar(Math.max(0.01, k));
      s.head.object.rotation.y += dt * (1 - k) * 10;
      this.portal.scale.setScalar(0.3 + k * 1.2);
      this.portal.rotation.z += dt * 3;
      this.portalMat.opacity = 0.8;
      return;
    }
    // portal closes after spawn
    if (this.portalMat.opacity > 0) {
      this.portalMat.opacity = Math.max(0, this.portalMat.opacity - dt * 0.6);
      this.portal.rotation.z += dt * 3;
      this.portal.visible = this.portalMat.opacity > 0;
    }
    s.head.object.visible = true;
    // armor cage
    const want = s.head.vulnerable ? 0 : 1;
    this.armorK += (want - this.armorK) * Math.min(1, dt * 4);
    this.armor.visible = this.armorK > 0.02;
    this.armor.scale.setScalar(1 + (1 - this.armorK) * 0.8);
    this.armorMat.opacity = 0.8 * this.armorK;
    this.armor.rotation.x += dt * 1.1;
    this.armor.rotation.z += dt * 0.7;

    if (this.mode === 'dying') {
      s.speed += (0 - s.speed) * Math.min(1, dt * 2);
      s.turnRate = 6;
      return;
    }
    if (!this.lunging) s.target.copy(ctx.player.pos);
    // no segments left -> exposed head takes extra damage
    if (s.segs.length === 0 && this.phase >= 2) s.head.damageMul = 1.5;

    if (this.mode === 'fight') {
      if (this.phase === 1 && s.segs.length <= P2_SEGMENTS) this.transitionTo(2, 1.8);
      else if (this.phase === 2 && s.head.hp <= s.head.hpFloor) this.transitionTo(3, 2);
      else if (this.phase === 3 && s.head.hp <= s.head.hpFloor) this.startDeath(s.head);
    }
  }

  protected onTransition(ctx: GameContext, k: number) {
    const s = this.serpent;
    s.speed = 3;
    s.turnRate = 5;
    s.wobble = 1.4;
    s.charge = Math.sin(k * Math.PI);
    s.target.set(0, 0, 0);
    this.lunging = false;
  }

  // ---------------- phases & attacks ----------------

  protected beginPhase(ctx: GameContext, phase: number) {
    const s = this.serpent;
    s.charge = 0;
    s.wobble = 0.55;
    s.turnRate = phase === 3 ? 2.8 : 2.2;
    this.baseSpeed = (phase === 1 ? 7 : phase === 2 ? 8 : 9) * ctx.difficulty.enemySpeed;
    s.speed = this.baseSpeed;
    this.lunging = false;
    if (phase === 1) {
      s.head.vulnerable = false;
      this.main.run(this.phase1());
    } else if (phase === 2) {
      s.head.vulnerable = true;
      s.head.hpFloor = s.head.maxHp * P3_AT;
      this.main.run(this.phase2());
    } else {
      s.head.vulnerable = true;
      s.head.hpFloor = 0.01;
      this.main.run(this.phase3());
    }
  }

  private *roam(t: number): Seq {
    this.serpent.speed = this.baseSpeed;
    this.serpent.turnRate = this.phase === 3 ? 2.8 : 2.2;
    yield t;
  }

  private *phase1(): Seq {
    yield* this.roam(1.5);
    while (true) {
      yield* this.spit(1);
      yield* this.roam(1.6);
      yield* this.spiral(3, 1);
      yield* this.roam(1.4);
      yield* this.spit(1);
      yield* this.roam(1.0);
      yield* this.lunge(1, false);
      yield* this.roam(1.6);
    }
  }

  private *phase2(): Seq {
    yield* this.roam(1.0);
    while (true) {
      yield* this.lunge(1, true);
      yield* this.roam(1.2);
      yield* this.spit(2);
      yield* this.roam(1.0);
      yield* this.spiral(3, -1);
      yield* this.roam(1.2);
      yield* this.lunge(1, true);
      yield* this.roam(1.0);
      yield* this.spit(2);
      yield* this.roam(1.4);
    }
  }

  private *phase3(): Seq {
    yield* this.roam(0.8);
    while (true) {
      yield* this.lunge(2, true);
      yield* this.roam(1.0);
      yield* this.spiral(4, 0);
      yield* this.roam(0.9);
      yield* this.spit(3);
      yield* this.roam(1.0);
      yield* this.lunge(1, true);
      yield* this.spit(2);
      yield* this.roam(1.2);
    }
  }

  /** Telegraphed aimed cone(s) of green bullets. */
  private *spit(times: number): Seq {
    const ctx = this.ctx;
    const s = this.serpent;
    for (let n = 0; n < times; n++) {
      s.speed = this.baseSpeed * 0.45;
      yield* tween(0.55, (k) => (s.charge = k), this.clock);
      s.charge = 0;
      const a = angleTo(s.pos.x, s.pos.z, ctx.player.pos.x, ctx.player.pos.z);
      const count = this.phase === 1 ? 7 : 9;
      fanShot(ctx, s.pos.x, s.pos.z, a, count, this.phase === 1 ? 0.9 : 1.1, 10, GREEN, 1.8, { radius: 0.34 });
      if (this.phase === 3) fanShot(ctx, s.pos.x, s.pos.z, a, count - 1, 0.95, 7, LIME, 1.8, { radius: 0.3 });
      ctx.bus.emit('enemyShoot', { pos: s.pos.clone(), kind: 'hydra-spit' });
      ctx.vfx.burst(_v.set(s.pos.x, PLAY_Y, s.pos.z), GREEN, 10, 8, 0.3, 0.8);
      yield interval(ctx, 0.45);
    }
    s.speed = this.baseSpeed;
  }

  /** Head coils (slows, circles) and emits rotating bullet arms. dir 0 = alternating arms. */
  private *spiral(arms: number, dir: number): Seq {
    const ctx = this.ctx;
    const s = this.serpent;
    s.speed = this.baseSpeed * 0.35;
    s.turnRate = 3.5;
    const m = this.freeMarker();
    m.show(s.pos.x, s.pos.z, 3.5, 0.7);
    yield* tween(0.7, (k) => {
      s.charge = k;
      m.x = s.pos.x;
      m.z = s.pos.z;
    }, this.clock);
    s.charge = 0.5;
    ctx.bus.emit('enemyShoot', { pos: s.pos.clone(), kind: 'hydra-spiral' });
    const dur = 2.6;
    const step = interval(ctx, this.phase === 3 ? 0.11 : 0.12);
    let rot = Math.random() * TAU;
    const sp = 2.1 * (dir === 0 ? 1 : dir);
    for (let e = 0; e < dur; e += step) {
      for (let i = 0; i < arms; i++) {
        const sign = dir === 0 && i % 2 === 1 ? -1 : 1;
        const a = rot * sign + (i / arms) * TAU;
        shoot(ctx, s.pos.x, s.pos.z, a, 7.5, i % 2 ? LIME : GREEN, { radius: 0.3, life: 6 });
      }
      rot += sp * step;
      yield step;
    }
    s.charge = 0;
    s.speed = this.baseSpeed;
  }

  /** Stop, aim (warning line), then dash along the locked line. */
  private *lunge(times: number, wallBurst: boolean): Seq {
    const ctx = this.ctx;
    const s = this.serpent;
    for (let n = 0; n < times; n++) {
      this.lunging = true;
      // slow down and turn toward the player
      s.speed = 1.5;
      s.turnRate = 6;
      s.wobble = 0;
      s.target.copy(ctx.player.pos);
      yield* tween(0.35, () => s.target.copy(ctx.player.pos), this.clock);
      const a = angleTo(s.pos.x, s.pos.z, ctx.player.pos.x, ctx.player.pos.z);
      s.heading = a;
      s.turnRate = 0;
      s.speed = 0;
      const warn = n === 0 ? 0.85 : 0.65;
      this.lasers[0].start(s.pos.x, s.pos.z, a, warn, 0, 0, 3.2, 30);
      yield* tween(warn, (k) => (s.charge = k), this.clock);
      s.charge = 1;
      ctx.bus.emit('enemyShoot', { pos: s.pos.clone(), kind: 'hydra-lunge' });
      ctx.vfx.burst(_v.set(s.pos.x, PLAY_Y, s.pos.z), MAGENTA, 18, 10, 0.4, 1);
      s.speed = 30 * ctx.difficulty.enemySpeed;
      let e = 0;
      const sx = s.pos.x, sz = s.pos.z;
      while (e < 1.2) {
        yield 0;
        e += this.clock.dt;
        if (s.hitWall || Math.hypot(s.pos.x - sx, s.pos.z - sz) > 28) break;
      }
      s.speed = 0;
      s.charge = 0;
      if (s.hitWall) {
        ctx.vfx.shake(0.5);
        ctx.vfx.gridImpulse(_v.set(s.pos.x, 0, s.pos.z), 2.5, 8);
        ctx.bus.emit('explosion', { pos: s.pos.clone(), color: MAGENTA, size: 2 });
        if (wallBurst) {
          ringShot(ctx, s.pos.x, s.pos.z, this.phase === 3 ? 18 : 14, 6, LIME, Math.random(), 0, 0, 0, 1.5);
          ctx.bus.emit('enemyShoot', { pos: s.pos.clone(), kind: 'hydra-burst' });
        }
      }
      // turn back toward the arena
      s.heading = angleTo(s.pos.x, s.pos.z, 0, 0);
      yield 0.35;
      s.turnRate = 2.2;
      s.wobble = 0.55;
      this.lunging = false;
      s.speed = this.baseSpeed;
      if (n < times - 1) yield 0.3;
    }
  }

  protected onDeathStart(ctx: GameContext) {
    this.serpent.charge = 1;
  }

  protected onDeathEnd(ctx: GameContext) {
    this.serpent.kill(ctx, true);
  }

  dispose() {
    super.dispose();
    this.serpent.dispose();
  }
}
