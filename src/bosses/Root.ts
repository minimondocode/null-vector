import * as THREE from 'three';
import { PLAY_Y } from '../game/config';
import type { GameContext } from '../game/types';
import {
  BossEncounter, BossPart, TAU, angleTo, fanShot, glow, glowMat, interval, neonBody, ringShot, shoot, tween, wire, type Seq,
} from './common';
import { Serpent } from './Serpent';

// ---- tuning knobs ----
const CORE_HP = 2900;
const NODE_HP = 45;
const NODES = 6;
/** Core damage multiplier while any shield node survives (phase 1). */
const NODE_ARMOR = 0.4;
const P2_AT = 0.66;
const P3_AT = 0.33;
/** Phase 3 arena radius as a fraction of the original. */
const SHRINK = 0.64;
const MAX_TENDRILS = 2;
const SCORE = 75000;

const GOLD = 0xffb000;
const RED = 0xff3b1f;
const WALL = 0x7df9ff;
const PINK = 0xff4fd8;
const PALE = 0xd8f6ff;

const _v = new THREE.Vector3();
const _hot = new THREE.Color();

interface Node {
  part: BossPart;
  emitter: THREE.MeshBasicMaterial;
}

/**
 * ROOT — final boss. Nested rotating polyhedra with orbiting rings.
 * P1: shield nodes (core armored while they live), Firewall-style gapped walls, rotating spokes, node volleys.
 * P2: Hydra reprise — tendril serpents, counter-rotating spirals, curving flower rings, spit cones.
 * P3: arena collapses, gap walls + slow spiral weave, rotating laser cross; desperation reversing cross.
 */
export class Root extends BossEncounter {
  private core: BossPart;
  private nodes: Node[] = [];
  private center = new THREE.Vector3();
  private outer: THREE.Object3D;
  private mid: THREE.Object3D;
  private inner: THREE.Mesh;
  private innerMat: THREE.MeshBasicMaterial;
  private rings: THREE.Mesh[] = [];
  private halo: THREE.Mesh;
  private halo2: THREE.Mesh;
  private charge = 0;
  private nodeCharge = 0;
  private nodeRot = 0;
  private spinBoost = 0;
  private origSize: number;
  private origShape: string;
  private arenaTarget: number;
  private arenaSet: number;
  private arenaRefreshT = 0;
  private desperate = false;
  private baseGold = glow(GOLD, 2);
  private hotWhite = glow(0xffffff, 5);
  private nodeBase = glow(RED, 1.8);

  constructor(ctx: GameContext, onDefeated: () => void) {
    super(ctx, 'ROOT', 'KERNEL OF THE CORRUPTION', 3, onDefeated);
    const hp = ctx.difficulty.enemyHp;
    this.origSize = this.arenaTarget = this.arenaSet = ctx.arena.size;
    this.origShape = ctx.arena.shape;

    // ---- core: nested polyhedra ----
    this.core = new BossPart(ctx, 'root-core', 3.1, CORE_HP * hp, GOLD, SCORE);
    this.core.hpFloor = this.core.maxHp * P2_AT;
    this.core.damageMul = NODE_ARMOR;
    const o = neonBody(new THREE.IcosahedronGeometry(3.0, 0), GOLD, 3.2, 0.1, 0.75);
    this.outer = o.group;
    const m = wire(new THREE.DodecahedronGeometry(2.0, 0), RED, 3.2);
    this.mid = m.obj;
    this.innerMat = new THREE.MeshBasicMaterial({ color: this.baseGold.clone(), toneMapped: false });
    this.inner = new THREE.Mesh(new THREE.OctahedronGeometry(0.95, 0), this.innerMat);
    this.core.object.add(this.outer, this.mid, this.inner);
    this.core.registerFlash(o.edgeMat, m.mat);

    // ---- orbit rings + floor halo (root group) ----
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(4.3 + i * 0.7, 0.05, 6, 96), glowMat(i === 1 ? RED : GOLD, 3));
      this.rings.push(ring);
      this.root.add(ring);
    }
    this.halo = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 128), glowMat(GOLD, 1.6, 0.35, true));
    this.halo.rotation.x = -Math.PI / 2;
    this.halo2 = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 3), glowMat(RED, 1.5, 0.3, true));
    this.halo2.rotation.x = -Math.PI / 2;
    this.root.add(this.halo, this.halo2);

    // ---- shield nodes ----
    for (let i = 0; i < NODES; i++) {
      const part = new BossPart(ctx, 'root-node', 1.0, NODE_HP * hp, GOLD, 800);
      const b = neonBody(new THREE.OctahedronGeometry(0.95, 0), GOLD, 3);
      part.object.add(b.group);
      const emitter = new THREE.MeshBasicMaterial({ color: this.nodeBase.clone(), toneMapped: false });
      part.object.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.38, 0), emitter));
      part.registerFlash(b.edgeMat);
      part.onKilled = (c) => this.onNodeKilled(c, part);
      this.nodes.push({ part, emitter });
    }

    for (let i = 0; i < 4; i++) this.addLaser(0xff7a1f, 0xff2a6a);
    this.addMarker(GOLD, 0.06);
    this.addMarker(GOLD, 0.06);
    this.layout(ctx, 0);
  }

  protected parts() {
    const out: BossPart[] = [this.core];
    for (const n of this.nodes) out.push(n.part);
    return out;
  }

  health() {
    return Math.max(0, this.core.hp / this.core.maxHp);
  }

  protected introCenter(out: THREE.Vector3) {
    return out.copy(this.center);
  }
  protected footprint() {
    return 7;
  }
  protected deathColor() {
    return GOLD;
  }
  protected deathPoint(i: number, out: THREE.Vector3) {
    const a = Math.random() * TAU, r = i % 3 === 0 ? Math.random() : 1 + Math.random() * 4;
    return out.set(this.center.x + Math.cos(a) * r, 0, this.center.z + Math.sin(a) * r);
  }

  protected onSpawned(_ctx: GameContext) {}

  private aliveNodes() {
    let n = 0;
    for (const x of this.nodes) if (x.part.alive) n++;
    return n;
  }

  private onNodeKilled(ctx: GameContext, part: BossPart) {
    ctx.vfx.ring(_v.set(part.pos.x, PLAY_Y, part.pos.z), GOLD, 4, 0.4);
    ctx.vfx.gridImpulse(_v, 1.5, 6);
    if (this.aliveNodes() === 0) {
      this.core.damageMul = 1;
      ctx.vfx.flash(GOLD, 0.3);
      ctx.vfx.ring(_v.set(this.center.x, PLAY_Y, this.center.z), 0xffffff, 8, 0.5);
      ctx.bus.emit('explosion', { pos: this.center.clone(), color: GOLD, size: 2.5 });
    }
  }

  // ---------------- per-frame ----------------

  protected tick(ctx: GameContext, dt: number) {
    if (this.mode === 'intro') {
      const k = this.introK;
      const vis = k > 0.7 || Math.random() < k;
      this.core.object.visible = this.root.visible = vis;
      for (const n of this.nodes) n.part.object.visible = vis;
      this.core.object.scale.setScalar(Math.max(0.01, k * k));
      this.spinBoost = (1 - k) * 8;
    } else {
      this.core.object.visible = true;
      for (const n of this.nodes) n.part.object.visible = true;
      if (this.mode !== 'done') this.root.visible = true;
      this.spinBoost += ((this.mode === 'dying' ? 10 : 0) - this.spinBoost) * Math.min(1, dt * 1.5);
      const s = 1 + this.charge * 0.1 * Math.sin(ctx.time * 40);
      this.core.object.scale.setScalar(this.mode === 'dying' ? s * (1 + Math.random() * 0.08) : s);
    }
    this.layout(ctx, dt);
    this.updateArena(ctx, dt);

    if (this.mode === 'fight' && this.core.hp <= this.core.hpFloor) {
      if (this.phase === 1) this.transitionTo(2, 2);
      else if (this.phase === 2) this.transitionTo(3, 2.6);
      else this.startDeath(this.core);
    }
    if (this.mode === 'fight' && this.phase === 3 && !this.desperate && this.core.hp < this.core.maxHp * 0.12) {
      this.desperate = true;
      ctx.vfx.flash(RED, 0.4);
      ctx.vfx.shake(0.5);
    }
  }

  private layout(ctx: GameContext, dt: number) {
    const c = this.center;
    const t = ctx.time;
    this.core.place(c.x, c.z, PLAY_Y + 0.8 + Math.sin(t * 1.3) * 0.25);
    const sb = 1 + this.spinBoost;
    this.outer.rotation.y += dt * 0.35 * sb;
    this.outer.rotation.x += dt * 0.2 * sb;
    this.mid.rotation.y -= dt * 0.9 * sb;
    this.mid.rotation.z += dt * 0.5 * sb;
    this.inner.rotation.y += dt * (2 + this.charge * 10);
    this.inner.scale.setScalar(1 + 0.15 * Math.sin(t * 5) + this.charge * 0.5);
    _hot.copy(this.baseGold).lerp(this.hotWhite, this.charge);
    this.innerMat.color.copy(_hot);
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      r.position.set(c.x, PLAY_Y + 0.8, c.z);
      r.rotation.set(Math.PI / 2 + Math.sin(t * (0.4 + i * 0.2) + i) * 0.9, t * (0.3 + i * 0.25) * sb, i * 1.1);
      const k = this.mode === 'intro' ? this.introK : 1;
      r.scale.setScalar(Math.max(0.01, k) * (1 + this.charge * 0.12));
    }
    this.halo.position.set(c.x, 0.05, c.z);
    this.halo.scale.setScalar(6.5 + Math.sin(t * 2) * 0.3);
    this.halo2.position.set(c.x, 0.04, c.z);
    this.halo2.scale.setScalar(8.5);
    this.halo2.rotation.z = t * 0.25;

    this.nodeRot += dt * 0.7 * (1 + this.spinBoost * 0.3);
    const pulse = 0.5 + 0.5 * Math.sin(t * 30);
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      if (!n.part.alive) continue;
      const a = this.nodeRot + (i / NODES) * TAU;
      const r = 6 + Math.sin(t * 1.5 + i) * 0.4 + (this.mode === 'intro' ? (1 - this.introK) * 10 : 0);
      n.part.place(c.x + Math.cos(a) * r, c.z + Math.sin(a) * r, PLAY_Y + 0.3);
      n.part.object.rotation.y = -a + t;
      n.emitter.color.copy(this.nodeBase).lerp(this.hotWhite, this.nodeCharge * (0.7 + 0.3 * pulse));
    }
  }

  /** Smoothly drives the arena radius toward arenaTarget; pushes the player inside. */
  private updateArena(ctx: GameContext, dt: number) {
    if (ctx.arena.shape !== this.origShape) return;
    const cur = this.arenaSet;
    if (Math.abs(cur - this.arenaTarget) < 0.001) return;
    const rate = this.arenaTarget < cur ? 4.5 : 7;
    const next = cur < this.arenaTarget ? Math.min(this.arenaTarget, cur + rate * dt) : Math.max(this.arenaTarget, cur - rate * dt);
    this.setArena(ctx, next, next === this.arenaTarget);
  }

  private setArena(ctx: GameContext, size: number, forceRefresh: boolean) {
    this.arenaSet = size;
    ctx.arena.setSize(size);
    this.arenaRefreshT -= this.clock.dt;
    if (forceRefresh || this.arenaRefreshT <= 0) {
      this.arenaRefreshT = 0.1;
      ctx.vfx.refreshArena(ctx.arena);
    }
    // keep the player safely inside (with a little breathing room and brief grace)
    const p = ctx.player;
    if (!ctx.arena.contains(p.pos.x, p.pos.z, p.radius + 0.4)) {
      ctx.arena.clamp(p.pos, p.radius + 0.4);
      p.invuln = Math.max(p.invuln, 0.25);
    }
    // bullets outside the new wall die on their own next update (pool clamps them)
  }

  protected onTransition(ctx: GameContext, k: number) {
    this.charge = Math.sin(k * Math.PI);
    this.spinBoost = Math.sin(k * Math.PI) * 6;
    if (this.phase === 3 && this.arenaTarget === this.origSize) {
      this.arenaTarget = this.origSize * SHRINK;
      ctx.vfx.flash(RED, 0.5);
      ctx.vfx.shake(0.6);
    }
  }

  // ---------------- phases & attacks ----------------

  protected beginPhase(ctx: GameContext, phase: number) {
    this.charge = 0;
    this.nodeCharge = 0;
    if (phase === 1) {
      this.core.hpFloor = this.core.maxHp * P2_AT;
      this.main.run(this.phase1());
    } else if (phase === 2) {
      this.core.hpFloor = this.core.maxHp * P3_AT;
      this.core.damageMul = 1;
      for (const n of this.nodes) n.part.remove(ctx, true);
      this.main.run(this.phase2());
      this.aux.run(this.tendrils());
    } else {
      this.core.hpFloor = 0.01;
      this.core.damageMul = 1;
      this.killMinions(ctx);
      this.main.run(this.phase3());
    }
  }

  private *phase1(): Seq {
    yield 1;
    while (true) {
      yield* this.walls(3, 2, 6.5, 0.62);
      yield 0.6;
      yield* this.nodeVolley(2);
      yield 0.8;
      yield* this.spokes(3);
      yield 0.8;
      yield* this.walls(2, 3, 7.5, 0.6);
      yield 0.6;
      yield* this.nodeVolley(1);
      yield 0.9;
    }
  }

  private *phase2(): Seq {
    yield 1;
    while (true) {
      yield* this.doubleSpiral(3);
      yield 0.9;
      yield* this.flower(3);
      yield 0.9;
      yield* this.spit(3);
      yield 0.8;
      yield* this.walls(2, 2, 6.5, 0.7);
      yield 1;
    }
  }

  private *phase3(): Seq {
    yield 0.8;
    while (true) {
      yield* this.laserCross();
      yield 0.8;
      yield* this.weave(4.5);
      yield 0.8;
      yield* this.flower(2);
      yield 0.8;
      yield* this.spit(2);
      yield 0.9;
    }
  }

  private *chargeUp(t: number, radius = 4.5): Seq {
    this.freeMarker().show(this.center.x, this.center.z, radius, t);
    yield* tween(t, (k) => (this.charge = k), this.clock);
    this.charge = 0;
    this.ctx.bus.emit('enemyShoot', { pos: this.center.clone(), kind: 'root' });
    this.ctx.vfx.ring(_v.set(this.center.x, PLAY_Y, this.center.z), GOLD, 5, 0.3);
  }

  /** Firewall reprise: expanding bullet walls with gaps that rotate between walls. */
  private *walls(count: number, gaps: number, speed: number, gapWidth: number): Seq {
    const ctx = this.ctx;
    let gapAt = Math.random() * TAU;
    const dir = Math.random() < 0.5 ? 1 : -1;
    yield* this.chargeUp(0.6);
    for (let i = 0; i < count; i++) {
      ringShot(ctx, this.center.x, this.center.z, 60, speed, WALL, i * 0.05, gaps, gapAt, gapWidth, 3.2, { radius: 0.34, life: 9 });
      if (i > 0) ctx.bus.emit('enemyShoot', { pos: this.center.clone(), kind: 'root' });
      ctx.vfx.ring(_v.set(this.center.x, PLAY_Y, this.center.z), WALL, 4, 0.25);
      gapAt += dir * 0.5;
      yield interval(ctx, 1.15);
    }
  }

  private *nodeVolley(times: number): Seq {
    const ctx = this.ctx;
    for (let n = 0; n < times; n++) {
      if (this.aliveNodes() === 0) return;
      yield* tween(0.55, (k) => (this.nodeCharge = k), this.clock);
      this.nodeCharge = 0;
      for (const node of this.nodes) {
        if (!node.part.alive) continue;
        const p = node.part.pos;
        const a = angleTo(p.x, p.z, ctx.player.pos.x, ctx.player.pos.z);
        fanShot(ctx, p.x, p.z, a, 3, 0.3, 9, PINK, 1, { radius: 0.3 });
      }
      ctx.bus.emit('enemyShoot', { pos: this.center.clone(), kind: 'root-node' });
      yield interval(ctx, 0.7);
    }
  }

  /** Four rotating bullet streams, start lines telegraphed. */
  private *spokes(dur: number): Seq {
    const ctx = this.ctx;
    const a0 = Math.random() * TAU;
    const dir = Math.random() < 0.5 ? 1 : -1;
    for (let i = 0; i < 4; i++) this.lasers[i].start(this.center.x, this.center.z, a0 + (i * TAU) / 4, 0.8, 0, 0, 0.6, 40);
    yield* this.chargeUp(0.8);
    const step = interval(ctx, 0.1);
    let rot = a0;
    for (let e = 0; e < dur; e += step) {
      for (let i = 0; i < 4; i++) shoot(ctx, this.center.x + Math.cos(rot + (i * TAU) / 4) * 3, this.center.z + Math.sin(rot + (i * TAU) / 4) * 3, rot + (i * TAU) / 4, 9, WALL, { radius: 0.3 });
      rot += dir * 0.55 * step;
      yield step;
    }
  }

  /** Hydra reprise: tendril serpents emerge from the core and hunt the player. */
  private *tendrils(): Seq {
    const ctx = this.ctx;
    yield 1.5;
    while (true) {
      if (this.minions.length < MAX_TENDRILS) {
        const a = angleTo(this.center.x, this.center.z, ctx.player.pos.x, ctx.player.pos.z) + (Math.random() - 0.5) * 2;
        const x = this.center.x + Math.cos(a) * 4, z = this.center.z + Math.sin(a) * 4;
        this.freeMarker().show(x, z, 1.6, 0.6);
        yield 0.6;
        const hp = ctx.difficulty.enemyHp;
        const t = new Serpent(ctx, x, z, a, {
          kind: 'root-tendril',
          segments: 5,
          headRadius: 0.9,
          segRadius: 0.7,
          tailRadius: 0.45,
          spacing: 1.0,
          headHp: 30 * hp,
          segHp: 14 * hp,
          color: RED,
          accent: GOLD,
          bulletColor: PALE,
          speed: 6.5 * ctx.difficulty.enemySpeed,
          turnRate: 2.8,
          headScore: 500,
          segScore: 150,
          ai: true,
        });
        t.setCollidable(true);
        ctx.addEntity(t);
        this.minions.push(t);
        ctx.vfx.burst(_v.set(x, PLAY_Y, z), RED, 16, 8, 0.4, 0.9);
        ctx.bus.emit('enemySpawn', { pos: t.pos.clone(), kind: 'root-tendril' });
        yield 2;
      }
      yield 5.5;
    }
  }

  private *doubleSpiral(dur: number): Seq {
    const ctx = this.ctx;
    yield* this.chargeUp(0.7);
    const step = interval(ctx, 0.14);
    let rot = Math.random() * TAU;
    for (let e = 0; e < dur; e += step) {
      for (let i = 0; i < 2; i++) {
        const off = i * Math.PI;
        shoot(ctx, this.center.x, this.center.z, rot + off, 7, PINK, { radius: 0.3 });
        shoot(ctx, this.center.x, this.center.z, -rot + off + 0.4, 6, WALL, { radius: 0.3 });
      }
      rot += 1.6 * step;
      yield step;
    }
  }

  /** Curving rings that cross into a lattice. */
  private *flower(waves: number): Seq {
    const ctx = this.ctx;
    yield* this.chargeUp(0.6);
    for (let w = 0; w < waves; w++) {
      const off = Math.random() * TAU;
      ringShot(ctx, this.center.x, this.center.z, 16, 5.5, PINK, off, 0, 0, 0, 3, { curve: 0.45, life: 6 });
      ringShot(ctx, this.center.x, this.center.z, 16, 5.5, WALL, off + Math.PI / 16, 0, 0, 0, 3, { curve: -0.45, life: 6 });
      if (w > 0) ctx.bus.emit('enemyShoot', { pos: this.center.clone(), kind: 'root' });
      yield interval(ctx, 1.1);
    }
  }

  private *spit(times: number): Seq {
    const ctx = this.ctx;
    for (let n = 0; n < times; n++) {
      yield* tween(0.45, (k) => (this.charge = k), this.clock);
      this.charge = 0;
      const a = angleTo(this.center.x, this.center.z, ctx.player.pos.x, ctx.player.pos.z);
      fanShot(ctx, this.center.x, this.center.z, a, 7, 0.8, 10, PINK, 3.2, { radius: 0.34 });
      ctx.bus.emit('enemyShoot', { pos: this.center.clone(), kind: 'root-spit' });
      yield interval(ctx, 0.4);
    }
  }

  /** Phase 3: single-gap walls woven with a slow, sparse spiral. */
  private *weave(dur: number): Seq {
    const ctx = this.ctx;
    yield* this.chargeUp(0.6);
    let wallT = 0;
    let gapAt = angleTo(this.center.x, this.center.z, ctx.player.pos.x, ctx.player.pos.z);
    const dir = Math.random() < 0.5 ? 1 : -1;
    let rot = Math.random() * TAU;
    const step = interval(ctx, 0.2);
    for (let e = 0; e < dur; e += step) {
      wallT -= step;
      if (wallT <= 0) {
        wallT = interval(ctx, 1.5);
        ringShot(ctx, this.center.x, this.center.z, 54, 6, WALL, 0, 1, gapAt, 0.9, 3.2, { radius: 0.34, life: 9 });
        ctx.bus.emit('enemyShoot', { pos: this.center.clone(), kind: 'root' });
        gapAt += dir * 0.6;
      }
      for (let i = 0; i < 3; i++) shoot(ctx, this.center.x, this.center.z, rot + (i * TAU) / 3, 5, PINK, { radius: 0.28 });
      rot -= dir * 1.2 * step;
      yield step;
    }
  }

  /** Four beams in a +, telegraphed, then rotating. Desperation: longer, reverses mid-way. */
  private *laserCross(): Seq {
    const ctx = this.ctx;
    const a0 = Math.random() * TAU;
    let dir = Math.random() < 0.5 ? 1 : -1;
    const speed = this.desperate ? 0.6 : 0.5;
    const dur = this.desperate ? 3.2 : 5;
    for (let i = 0; i < 4; i++) this.lasers[i].start(this.center.x, this.center.z, a0 + (i * TAU) / 4, 1.4, dur, dir * speed, 1.4, 60);
    yield* this.chargeUp(1.4, 6);
    this.charge = 0.7;
    ctx.vfx.flash(RED, 0.25);
    ctx.vfx.shake(0.5);
    let shotT = 0.6;
    let e = 0;
    while (e < dur) {
      yield 0;
      e += this.clock.dt;
      shotT -= this.clock.dt;
      if (shotT <= 0) {
        shotT = interval(ctx, 1.0);
        const a = angleTo(this.center.x, this.center.z, ctx.player.pos.x, ctx.player.pos.z);
        fanShot(ctx, this.center.x, this.center.z, a, 3, 0.25, 7.5, PINK, 3.2, { radius: 0.3 });
        ctx.bus.emit('enemyShoot', { pos: this.center.clone(), kind: 'root-spit' });
      }
    }
    if (this.desperate) {
      // reverse: beams thin (telegraph) then sweep the other way
      dir = -dir;
      const angle = this.lasers[0].angle;
      yield 0.25;
      for (let i = 0; i < 4; i++) this.lasers[i].start(this.center.x, this.center.z, angle + (i * TAU) / 4, 0.8, 3.2, dir * 0.6, 1.4, 60);
      yield 0.8 + 3.2;
    }
    this.charge = 0;
    yield 0.3;
  }

  protected onDeathStart(ctx: GameContext) {
    this.charge = 1;
    this.arenaTarget = this.origSize;
  }

  protected onDeathEnd(ctx: GameContext) {
    if (ctx.arena.shape === this.origShape && this.arenaSet !== this.origSize) this.setArena(ctx, this.origSize, true);
    this.arenaTarget = this.origSize;
  }

  dispose() {
    const ctx = this.ctx;
    // restore the arena if the encounter ends mid-shrink (death / quit), unless something else resized it
    if (ctx.arena.shape === this.origShape && ctx.arena.size === this.arenaSet && this.arenaSet !== this.origSize) {
      ctx.arena.setSize(this.origSize);
      ctx.vfx.refreshArena(ctx.arena);
    }
    super.dispose();
  }
}
