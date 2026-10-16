import * as THREE from 'three';
import { PLAY_Y } from '../game/config';
import type { GameContext } from '../game/types';
import {
  BossEncounter, BossPart, TAU, angleTo, fanShot, glow, glowMat, interval, lineMat, neonBody, ringShot, shoot, tween, wire,
  type Seq,
} from './common';

// ---- tuning knobs ----
const SEGMENTS = 12;
const SEG_HP = 40;
const CORE_HP = 500;
/** Core opens when this many segments are destroyed (phase 1). */
const OPEN_AFTER = 3;
const BASE_R = 7;
const SCORE = 20000;

const CYAN = 0x00e5ff;
const BLUE = 0x2b6bff;
const HOSTILE = 0xff5a1f;
const BULLET_A = 0xff4a2b;
const BULLET_B = 0xffa21f;

const _v = new THREE.Vector3();
const _hot = new THREE.Color();

interface Seg {
  part: BossPart;
  emitter: THREE.MeshBasicMaterial;
  emitterMesh: THREE.Mesh;
  fire: boolean;
}

/**
 * FIREWALL — rotating ring of armored segments around a shielded core.
 * P1: radial volleys with rotating gaps, gapped core bursts, ring crush. Core opens after 3 segments fall.
 * P2: laser sweeps (single / twin), faster spin, denser volleys.
 */
export class Firewall extends BossEncounter {
  private core: BossPart;
  private segs: Seg[] = [];
  private center = new THREE.Vector3();
  private ringR = BASE_R + 14;
  private ringOverride: number | null = null;
  private baseR = BASE_R;
  private rot = 0;
  private spin = 0.45;
  private spinTarget = 0.45;
  private anchored = false;
  private chargeK = 0;
  private coreCharge = 0;
  private destroyed = 0;
  private gapBase = 0;
  private shield: THREE.LineSegments;
  private shieldMat: THREE.LineBasicMaterial;
  private shieldK = 1;
  private coreInner: THREE.Object3D;
  private coreInnerMat: THREE.MeshBasicMaterial;
  private coreOuter: THREE.Object3D;
  private links: THREE.LineSegments;
  private linkPos: Float32Array;
  private orbit: THREE.Mesh;
  private orbit2: THREE.Mesh;
  private dimEmitter = glow(BLUE, 1.2);
  private baseEmitter = glow(HOSTILE, 1.6);
  private hotEmitter = glow(0xffd0a0, 5);

  constructor(ctx: GameContext, onDefeated: () => void) {
    super(ctx, 'FIREWALL', 'PERIMETER DEFENSE CONSTRUCT', 2, onDefeated);
    const hp = ctx.difficulty.enemyHp;
    this.center.set(0, 0, 0);

    // ---- core ----
    this.core = new BossPart(ctx, 'firewall-core', 2.0, CORE_HP * hp, CYAN, SCORE);
    this.core.vulnerable = false;
    this.core.hpFloor = this.core.maxHp * 0.5;
    const outer = neonBody(new THREE.IcosahedronGeometry(1.7, 0), CYAN, 3.2);
    this.coreOuter = outer.group;
    this.core.registerFlash(outer.edgeMat);
    this.coreInnerMat = new THREE.MeshBasicMaterial({ color: glow(HOSTILE, 2), toneMapped: false, wireframe: true });
    this.coreInner = new THREE.Mesh(new THREE.OctahedronGeometry(1.0, 0), this.coreInnerMat);
    const sh = wire(new THREE.IcosahedronGeometry(2.7, 1), CYAN, 2.2, 0.7);
    this.shield = sh.obj;
    this.shieldMat = sh.mat;
    this.core.object.add(this.coreOuter, this.coreInner, this.shield);

    // ---- segments ----
    for (let i = 0; i < SEGMENTS; i++) {
      const part = new BossPart(ctx, 'firewall-seg', 1.1, SEG_HP * hp, CYAN, 600);
      const geo = new THREE.BoxGeometry(1.1, 0.9, 2.0);
      const b = neonBody(geo, CYAN, 3);
      part.object.add(b.group);
      const plate = wire(new THREE.BoxGeometry(0.7, 1.05, 1.6), BLUE, 2.5);
      part.object.add(plate.obj);
      const emitter = new THREE.MeshBasicMaterial({ color: this.baseEmitter.clone(), toneMapped: false });
      const em = new THREE.Mesh(new THREE.OctahedronGeometry(0.32, 0), emitter);
      em.position.set(0.7, 0.1, 0);
      part.object.add(em);
      part.registerFlash(b.edgeMat, plate.mat);
      part.onKilled = (c) => this.onSegKilled(c, part);
      this.segs.push({ part, emitter, emitterMesh: em, fire: true });
    }

    // ---- decorative links + orbit rings (in root) ----
    this.linkPos = new Float32Array(SEGMENTS * 6);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(this.linkPos, 3));
    this.links = new THREE.LineSegments(lg, lineMat(BLUE, 1.6, 0.45));
    this.links.frustumCulled = false;
    this.root.add(this.links);
    this.orbit = new THREE.Mesh(new THREE.RingGeometry(0.985, 1, 128), glowMat(CYAN, 1.6, 0.35, true));
    this.orbit.rotation.x = -Math.PI / 2;
    this.orbit2 = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 6), glowMat(HOSTILE, 1.4, 0.3, true));
    this.orbit2.rotation.x = -Math.PI / 2;
    this.root.add(this.orbit, this.orbit2);

    this.addLaser(0xff3b1f);
    this.addLaser(0xff3b1f);
    this.addMarker(HOSTILE, 0.06);
    this.addMarker(HOSTILE, 0.06);
    this.layout(ctx, 0);
  }

  protected parts() {
    const out: BossPart[] = [this.core];
    for (const s of this.segs) out.push(s.part);
    return out;
  }

  health() {
    let hp = this.core.hp, max = this.core.maxHp;
    for (const s of this.segs) {
      max += s.part.maxHp;
      if (s.part.alive) hp += Math.max(0, s.part.hp);
    }
    return Math.max(0, hp / max);
  }

  protected introCenter(out: THREE.Vector3) {
    return out.set(this.center.x, 0, this.center.z);
  }
  protected footprint() {
    return BASE_R + 1.2;
  }
  protected deathColor() {
    return CYAN;
  }
  protected deathPoint(i: number, out: THREE.Vector3) {
    if (i % 3 === 0) return out.set(this.center.x + (Math.random() - 0.5) * 2, 0, this.center.z + (Math.random() - 0.5) * 2);
    const a = Math.random() * TAU, r = Math.random() * this.ringR + 0.5;
    return out.set(this.center.x + Math.cos(a) * r, 0, this.center.z + Math.sin(a) * r);
  }

  protected onSpawned(ctx: GameContext) {
    this.ringR = this.baseR;
  }

  private onSegKilled(ctx: GameContext, part: BossPart) {
    this.destroyed++;
    ctx.vfx.ring(_v.set(part.pos.x, PLAY_Y, part.pos.z), CYAN, 4, 0.4);
    ctx.vfx.gridImpulse(_v, 1.5, 6);
    if (this.phase === 1 && this.destroyed === OPEN_AFTER && this.mode === 'fight') {
      // core breach flourish
      this.core.vulnerable = true;
      ctx.vfx.flash(CYAN, 0.35);
      ctx.vfx.shake(0.4);
      ctx.vfx.ring(_v.set(this.center.x, PLAY_Y, this.center.z), 0xffffff, 6, 0.5);
      ctx.vfx.burst(_v, CYAN, 40, 12, 0.6, 1);
      ctx.bus.emit('explosion', { pos: this.center.clone(), color: CYAN, size: 2 });
    }
  }

  // ---------------- per-frame ----------------

  protected tick(ctx: GameContext, dt: number) {
    if (this.mode === 'intro') {
      const k = this.introK;
      this.ringR = this.baseR + (1 - k) * 14;
      this.spin = 0.45 + (1 - k) * 6;
      const vis = k > 0.75 || Math.random() < k * 1.2;
      for (const s of this.segs) s.part.object.visible = vis;
      this.core.object.visible = vis;
      this.root.visible = vis;
      this.core.object.scale.setScalar(Math.max(0.01, k));
    } else {
      for (const s of this.segs) s.part.object.visible = true;
      this.core.object.visible = true;
      this.root.visible = this.mode !== 'done';
      this.core.object.scale.setScalar(1 + this.coreCharge * 0.15 * Math.sin(ctx.time * 40));
      if (this.mode === 'dying') {
        this.ringR += (1.6 - this.ringR) * Math.min(1, dt * 1.5);
        this.spin += (8 - this.spin) * Math.min(1, dt);
      } else {
        const target = this.ringOverride ?? this.baseR;
        this.ringR += (target - this.ringR) * Math.min(1, dt * (this.ringOverride !== null ? 30 : 3));
        this.spin += (this.spinTarget - this.spin) * Math.min(1, dt * 2);
        this.drift(ctx, dt);
      }
    }
    this.rot += this.spin * dt;
    this.layout(ctx, dt);

    if (this.mode === 'fight') {
      if (this.core.hp <= this.core.hpFloor) {
        if (this.phase === 1) this.transitionTo(2, 2);
        else this.startDeath(this.core);
      }
    }
  }

  private drift(ctx: GameContext, dt: number) {
    if (this.anchored || this.mode !== 'fight') return;
    const p = ctx.player.pos;
    const dx = p.x - this.center.x, dz = p.z - this.center.z;
    const d = Math.hypot(dx, dz);
    const keep = this.baseR + 5;
    if (d > keep) {
      const sp = (this.phase === 1 ? 1.3 : 1.9) * ctx.difficulty.enemySpeed * dt;
      this.center.x += (dx / d) * sp;
      this.center.z += (dz / d) * sp;
    }
    ctx.arena.clamp(this.center, this.baseR + 1.6);
  }

  private layout(ctx: GameContext, dt: number) {
    const c = this.center;
    this.core.place(c.x, c.z, PLAY_Y + 0.4);
    this.coreOuter.rotation.y += dt * 0.6;
    this.coreOuter.rotation.x += dt * 0.35;
    this.coreInner.rotation.y -= dt * (2 + this.coreCharge * 8);
    this.coreInner.rotation.z += dt * 1.3;
    _hot.copy(this.baseEmitter).lerp(this.hotEmitter, this.coreCharge);
    this.coreInnerMat.color.copy(_hot);
    // shield fades when the core is exposed
    const want = this.core.vulnerable ? 0 : 1;
    this.shieldK += (want - this.shieldK) * Math.min(1, dt * 4);
    this.shield.visible = this.shieldK > 0.02;
    this.shield.scale.setScalar(1 + (1 - this.shieldK) * 0.6);
    this.shieldMat.opacity = 0.7 * this.shieldK * (0.75 + 0.25 * Math.sin(ctx.time * 9));
    this.shield.rotation.y -= dt * 0.8;

    const pulse = 0.5 + 0.5 * Math.sin(ctx.time * 30);
    for (let i = 0; i < SEGMENTS; i++) {
      const s = this.segs[i];
      const a = this.rot + (i / SEGMENTS) * TAU;
      const x = c.x + Math.cos(a) * this.ringR, z = c.z + Math.sin(a) * this.ringR;
      const p = s.part;
      if (p.alive) {
        p.place(x, z, PLAY_Y + Math.sin(ctx.time * 3 + i) * 0.08);
        p.object.rotation.y = -a;
        const k = s.fire ? this.chargeK : 0;
        if (s.fire) s.emitter.color.copy(this.baseEmitter).lerp(this.hotEmitter, k * (0.7 + 0.3 * pulse));
        else s.emitter.color.copy(this.dimEmitter);
        s.emitterMesh.scale.setScalar(1 + k * 0.8);
        s.emitterMesh.rotation.x += dt * 4;
      }
      const o = i * 6;
      this.linkPos[o] = c.x;
      this.linkPos[o + 1] = PLAY_Y;
      this.linkPos[o + 2] = c.z;
      this.linkPos[o + 3] = p.alive ? x : c.x;
      this.linkPos[o + 4] = PLAY_Y;
      this.linkPos[o + 5] = p.alive ? z : c.z;
    }
    (this.links.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.orbit.position.set(c.x, 0.05, c.z);
    this.orbit.scale.setScalar(Math.max(0.01, this.ringR));
    this.orbit2.position.set(c.x, 0.04, c.z);
    this.orbit2.scale.setScalar(Math.max(0.01, this.ringR + 1.8));
    this.orbit2.rotation.z = -this.rot * 0.5;
  }

  protected onTransition(ctx: GameContext, k: number) {
    this.spinTarget = 0.45 + Math.sin(k * Math.PI) * 4;
    this.coreCharge = Math.sin(k * Math.PI);
    this.baseR = BASE_R + Math.sin(k * Math.PI) * 2;
  }

  // ---------------- phases & attacks ----------------

  protected beginPhase(ctx: GameContext, phase: number) {
    this.coreCharge = 0;
    this.chargeK = 0;
    this.ringOverride = null;
    this.anchored = false;
    if (phase === 1) {
      this.spinTarget = 0.45;
      this.main.run(this.phase1());
    } else {
      this.baseR = BASE_R - 0.5;
      this.spinTarget = 0.85;
      this.core.vulnerable = true;
      this.core.hpFloor = 0.01;
      this.main.run(this.phase2());
    }
  }

  private *phase1(): Seq {
    yield 1;
    while (true) {
      yield* this.volleys(3, false);
      yield 0.9;
      yield* this.coreBurst(2);
      yield 0.9;
      yield* this.crush(false);
      yield 1.1;
    }
  }

  private *phase2(): Seq {
    yield 0.8;
    let twin = false;
    while (true) {
      yield* this.laserSweep(twin);
      twin = !twin;
      yield 0.7;
      yield* this.volleys(2, true);
      yield 0.6;
      yield* this.crush(true);
      yield 0.8;
      yield* this.coreBurst(3);
      yield 0.9;
    }
  }

  private *volleys(count: number, inward: boolean): Seq {
    const ctx = this.ctx;
    for (let v = 0; v < count; v++) {
      this.gapBase = (this.gapBase + 2 + (Math.random() < 0.5 ? 1 : 0)) % SEGMENTS;
      const gapLen = inward ? 4 : 3;
      for (let i = 0; i < SEGMENTS; i++) this.segs[i].fire = ((i - this.gapBase + SEGMENTS) % SEGMENTS) >= gapLen;
      yield* tween(0.55, (k) => (this.chargeK = k), this.clock);
      let fired = false;
      for (let i = 0; i < SEGMENTS; i++) {
        const s = this.segs[i];
        if (!s.fire || !s.part.alive) continue;
        const a = angleTo(this.center.x, this.center.z, s.part.pos.x, s.part.pos.z);
        fanShot(ctx, s.part.pos.x, s.part.pos.z, a, this.phase === 1 ? 3 : 4, this.phase === 1 ? 0.22 : 0.3, 8.5, BULLET_A, 0.9);
        if (inward) shoot(ctx, s.part.pos.x, s.part.pos.z, a + Math.PI, 5, BULLET_B, { life: (this.ringR * 2) / 5 });
        fired = true;
      }
      if (fired) ctx.bus.emit('enemyShoot', { pos: this.center.clone(), kind: 'firewall' });
      this.chargeK = 0;
      yield interval(ctx, this.phase === 1 ? 0.9 : 0.75);
    }
    for (const s of this.segs) s.fire = true;
  }

  private *coreBurst(count: number): Seq {
    const ctx = this.ctx;
    let gapAt = Math.random() * TAU;
    for (let n = 0; n < count; n++) {
      this.freeMarker().show(this.center.x, this.center.z, 3.2, 0.6);
      yield* tween(0.6, (k) => (this.coreCharge = k), this.clock);
      this.coreCharge = 0;
      const cnt = this.phase === 1 ? 30 : 36;
      ringShot(ctx, this.center.x, this.center.z, cnt, 7, BULLET_B, Math.random() * 0.2, 3, gapAt, this.phase === 1 ? 0.62 : 0.52, 2.2, { radius: 0.36 });
      ctx.bus.emit('enemyShoot', { pos: this.center.clone(), kind: 'firewall-core' });
      ctx.vfx.ring(_v.set(this.center.x, PLAY_Y, this.center.z), HOSTILE, 4, 0.3);
      gapAt += Math.PI / 3;
      yield interval(ctx, 0.75);
    }
  }

  private *crush(burstAtPeak: boolean): Seq {
    const ctx = this.ctx;
    this.anchored = true;
    const pd = Math.hypot(ctx.player.pos.x - this.center.x, ctx.player.pos.z - this.center.z);
    const edge = ctx.arena.distanceToEdge(this.center.x, this.center.z) - 0.8;
    const target = Math.max(this.baseR + 2, Math.min(13, pd + 0.6, edge));
    this.freeMarker().show(this.center.x, this.center.z, target, 1.0);
    this.spinTarget = this.phase === 1 ? 1.4 : 2;
    yield* tween(1.0, (k) => (this.chargeK = k * 0.6), this.clock);
    this.chargeK = 0;
    ctx.bus.emit('enemyShoot', { pos: this.center.clone(), kind: 'firewall-crush' });
    const start = this.ringR;
    yield* tween(0.35, (k) => (this.ringOverride = start + (target - start) * (1 - (1 - k) * (1 - k))), this.clock);
    ctx.vfx.shake(0.45);
    ctx.vfx.gridImpulse(_v.set(this.center.x, 0, this.center.z), 2.5, target + 4);
    ctx.vfx.ring(_v.set(this.center.x, PLAY_Y, this.center.z), CYAN, target + 2, 0.4);
    if (burstAtPeak) ringShot(ctx, this.center.x, this.center.z, 24, 6, BULLET_B, Math.random(), 2, Math.random() * TAU, 0.9, 2.2);
    yield 0.5;
    yield* tween(0.9, (k) => (this.ringOverride = target + (this.baseR - target) * k), this.clock);
    this.ringOverride = null;
    this.spinTarget = this.phase === 1 ? 0.45 : 0.85;
    this.anchored = false;
  }

  private *laserSweep(twin: boolean): Seq {
    const ctx = this.ctx;
    this.anchored = true;
    const dir = Math.random() < 0.5 ? 1 : -1;
    const span = twin ? 1.6 : 2.0;
    const dur = 2.4;
    const a0 = angleTo(this.center.x, this.center.z, ctx.player.pos.x, ctx.player.pos.z) - dir * (twin ? 0.7 : 0.9);
    const w = 1.3;
    const l1 = this.lasers[0];
    l1.start(this.center.x, this.center.z, a0, 1.15, dur, (dir * span) / dur, w);
    if (twin) this.lasers[1].start(this.center.x, this.center.z, a0 + Math.PI, 1.15, dur, (dir * span) / dur, w);
    yield* tween(1.15, (k) => (this.coreCharge = k), this.clock);
    this.coreCharge = 0.6;
    yield dur + 0.25;
    this.coreCharge = 0;
    this.anchored = false;
  }

  protected onDeathStart(ctx: GameContext) {
    this.chargeK = 0;
    this.coreCharge = 1;
  }
}
