import * as THREE from 'three';
import { PLAY_Y } from '../game/config';
import type { GameContext } from '../game/types';
import { BossPart, PathTrail, angleTo, fanShot, glow, interval, neonBody, wrapAngle, type Killable } from './common';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export interface SerpentOpts {
  kind: string;
  segments: number;
  headRadius: number;
  segRadius: number;
  tailRadius: number;
  spacing: number;
  headHp: number;
  segHp: number;
  color: number;
  accent: number;
  bulletColor: number;
  speed: number;
  turnRate: number;
  headScore: number;
  segScore: number;
  /** Self-driven minion AI (chase + telegraphed aimed fans). */
  ai: boolean;
}

/**
 * Segmented serpent: head + body parts following a fixed-step path trail.
 * The boss controller drives `heading`/`speed` for the HYDRA; minions drive themselves (`ai`).
 */
export class Serpent implements Killable {
  alive = true;
  head: BossPart;
  segs: BossPart[] = [];
  /** Per-segment trail distance (smoothly reels in when a segment is lost). */
  private segDist: number[] = [];
  trail: PathTrail;
  heading: number;
  speed: number;
  turnRate: number;
  /** Target the head steers toward (when turnRate > 0). */
  target = new THREE.Vector3();
  /** Sinusoidal wander amplitude (radians). */
  wobble = 0.55;
  /** Set when the head was pushed back by a wall this frame. */
  hitWall = false;
  /** 0..1 head charge glow (telegraphs). */
  charge = 0;
  /** Called with (index, part) when a body segment is destroyed. Return true to keep the tail attached. */
  onSegmentLost?: (ctx: GameContext, index: number, tail: BossPart[]) => void;
  private headEdge: THREE.LineBasicMaterial;
  private eyeMat: THREE.MeshBasicMaterial;
  private segEdges: THREE.LineBasicMaterial[] = [];
  private eyeBase: THREE.Color;
  private eyeHot: THREE.Color;
  private t = Math.random() * 10;
  private fireT = 2;
  private popQueue: BossPart[] = [];
  private popT = 0;
  private dyingHead = false;
  readonly opts: SerpentOpts;

  constructor(ctx: GameContext, x: number, z: number, heading: number, opts: SerpentOpts, seed?: { x: number; z: number }[]) {
    this.opts = opts;
    this.heading = heading;
    this.speed = opts.speed;
    this.turnRate = opts.turnRate;
    this.trail = new PathTrail(0.25, 512);
    if (seed && seed.length > 1) this.trail.seed(seed);
    else this.trail.reset(x, z);
    this.trail.move(x, z);

    // ---- head: arrow-like prism with jaws and a hostile eye ----
    const h = new BossPart(ctx, opts.kind + '-head', opts.headRadius, opts.headHp, opts.color, opts.headScore);
    const r = opts.headRadius;
    const shape = new THREE.Shape();
    shape.moveTo(r * 1.35, 0);
    shape.lineTo(r * 0.2, r * 0.95);
    shape.lineTo(-r * 0.9, r * 0.7);
    shape.lineTo(-r * 0.6, 0);
    shape.lineTo(-r * 0.9, -r * 0.7);
    shape.lineTo(r * 0.2, -r * 0.95);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: r * 0.55, bevelEnabled: false });
    geo.rotateX(Math.PI / 2);
    geo.translate(0, r * 0.27, 0);
    const body = neonBody(geo, opts.color, 3.2);
    h.object.add(body.group);
    this.headEdge = body.edgeMat;
    h.registerFlash(body.edgeMat);
    this.eyeBase = glow(opts.accent, 2.5);
    this.eyeHot = glow(0xffffff, 4);
    this.eyeMat = new THREE.MeshBasicMaterial({ color: this.eyeBase.clone(), toneMapped: false });
    const eyeGeo = new THREE.OctahedronGeometry(r * 0.28, 0);
    const eye1 = new THREE.Mesh(eyeGeo, this.eyeMat);
    const eye2 = new THREE.Mesh(eyeGeo.clone(), this.eyeMat);
    eye1.position.set(r * 0.35, r * 0.45, r * 0.38);
    eye2.position.set(r * 0.35, r * 0.45, -r * 0.38);
    h.object.add(eye1, eye2);
    h.place(x, z);
    this.head = h;

    // ---- body ----
    for (let i = 0; i < opts.segments; i++) this.addSegment(ctx, i);
    this.layout(ctx, 0);
  }

  private segRadiusAt(i: number) {
    const o = this.opts;
    const k = o.segments > 1 ? i / (o.segments - 1) : 0;
    return o.segRadius + (o.tailRadius - o.segRadius) * k;
  }

  private addSegment(ctx: GameContext, i: number) {
    const o = this.opts;
    const r = this.segRadiusAt(i);
    const s = new BossPart(ctx, o.kind + '-seg', r, o.segHp, o.color, o.segScore);
    const geo = new THREE.CylinderGeometry(r, r, r * 0.9, 6);
    const b = neonBody(geo, o.color, 2.6);
    s.object.add(b.group);
    s.registerFlash(b.edgeMat);
    this.segEdges.push(b.edgeMat);
    // hostile core
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(r * 0.32, 0), new THREE.MeshBasicMaterial({ color: glow(o.accent, 2.2), toneMapped: false }));
    core.position.y = r * 0.5;
    s.object.add(core);
    s.place(this.head.pos.x, this.head.pos.z);
    this.segs.push(s);
    this.segDist.push(o.headRadius * 0.8 + o.spacing * (i + 0.6));
  }

  get pos() {
    return this.head.pos;
  }

  /** Body parts still attached. */
  get length() {
    return this.segs.length;
  }

  allParts(out: BossPart[]) {
    out.push(this.head);
    for (const s of this.segs) out.push(s);
    for (const s of this.popQueue) out.push(s);
    return out;
  }

  update(ctx: GameContext, dt: number) {
    if (!this.alive) return;
    this.t += dt;
    this.popTick(ctx, dt);
    if (!this.head.alive && !this.dyingHead) {
      // head destroyed: the whole chain pops
      this.dyingHead = true;
      for (const s of this.segs) this.popQueue.push(s);
      this.segs.length = 0;
    }
    if (this.dyingHead) {
      if (this.popQueue.length === 0) this.alive = false;
      return;
    }
    // detect lost segments
    for (let i = 0; i < this.segs.length; i++) {
      if (this.segs[i].alive) continue;
      const tail = this.segs.slice(i + 1);
      this.segs.splice(i);
      this.segDist.splice(i);
      if (this.onSegmentLost) this.onSegmentLost(ctx, i, tail);
      else this.popQueue.push(...tail);
      break;
    }
    if (this.opts.ai) this.think(ctx, dt);
    this.move(ctx, dt);
    this.layout(ctx, dt);
  }

  /** Re-attach parts (tail closes the gap). */
  reattach(parts: BossPart[]) {
    for (const p of parts) {
      const i = this.segs.length;
      this.segs.push(p);
      // keep current distance; layout reels it in
      this.segDist.push(this.opts.headRadius * 0.8 + this.opts.spacing * (i + 1.6));
    }
  }

  /** Chain-pop parts (visual), one every ~60ms. */
  pop(parts: BossPart[]) {
    for (const p of parts) this.popQueue.push(p);
  }

  private popTick(ctx: GameContext, dt: number) {
    if (!this.popQueue.length) return;
    this.popT -= dt;
    if (this.popT > 0) return;
    this.popT = 0.06;
    const p = this.popQueue.shift()!;
    p.remove(ctx, true);
  }

  private think(ctx: GameContext, dt: number) {
    this.target.copy(ctx.player.pos);
    this.fireT -= dt;
    if (this.fireT < 0.55) this.charge = Math.min(1, this.charge + dt / 0.5);
    if (this.fireT <= 0) {
      this.fireT = interval(ctx, 2.8 + Math.random() * 1.2);
      this.charge = 0;
      const a = angleTo(this.pos.x, this.pos.z, ctx.player.pos.x, ctx.player.pos.z);
      fanShot(ctx, this.pos.x, this.pos.z, a, 3, 0.36, 8, this.opts.bulletColor, this.opts.headRadius, { radius: 0.3 });
      ctx.bus.emit('enemyShoot', { pos: this.pos.clone(), kind: this.opts.kind });
    }
  }

  private move(ctx: GameContext, dt: number) {
    const h = this.head;
    if (this.turnRate > 0) {
      let want = angleTo(h.pos.x, h.pos.z, this.target.x, this.target.z) + Math.sin(this.t * 1.7) * this.wobble;
      // wall avoidance: look ahead, bend toward the centre
      const lx = h.pos.x + Math.cos(this.heading) * 4, lz = h.pos.z + Math.sin(this.heading) * 4;
      const edge = ctx.arena.distanceToEdge(lx, lz);
      if (edge < 3) {
        const c = angleTo(h.pos.x, h.pos.z, 0, 0);
        const w = Math.min(1, (3 - edge) / 3);
        want = want + wrapAngle(c - want) * w;
      }
      const d = wrapAngle(want - this.heading);
      const maxTurn = this.turnRate * dt;
      this.heading += Math.max(-maxTurn, Math.min(maxTurn, d));
    }
    _a.set(h.pos.x + Math.cos(this.heading) * this.speed * dt, 0, h.pos.z + Math.sin(this.heading) * this.speed * dt);
    this.hitWall = ctx.arena.clamp(_a, h.radius * 0.8);
    if (this.hitWall && this.turnRate > 0) this.heading = angleTo(_a.x, _a.z, 0, 0) + (Math.random() - 0.5);
    const bob = Math.sin(this.t * 4) * 0.12;
    h.place(_a.x, _a.z, PLAY_Y + bob);
    h.object.rotation.y = -this.heading;
    h.object.rotation.x = Math.sin(this.t * 3) * 0.08;
    this.trail.move(_a.x, _a.z);
    this.eyeMat.color.copy(this.eyeBase).lerp(this.eyeHot, this.charge);
    const s = 1 + this.charge * 0.18 * (0.6 + 0.4 * Math.sin(this.t * 40));
    h.object.scale.setScalar(s);
  }

  private layout(_ctx: GameContext, dt: number) {
    const o = this.opts;
    for (let i = 0; i < this.segs.length; i++) {
      const target = o.headRadius * 0.8 + o.spacing * (i + 0.6);
      this.segDist[i] += (target - this.segDist[i]) * Math.min(1, dt * 3);
      const s = this.segs[i];
      this.trail.sample(this.segDist[i], _a);
      this.trail.sample(this.segDist[i] - 0.5, _b);
      const wave = Math.sin(this.t * 6 - i * 0.7);
      s.place(_a.x, _a.z, PLAY_Y + wave * 0.15);
      s.object.rotation.y = -Math.atan2(_b.z - _a.z, _b.x - _a.x) + this.t * 0.6;
      s.object.scale.setScalar(1 + wave * 0.07);
    }
  }

  kill(ctx: GameContext, pop: boolean) {
    if (!this.alive) return;
    this.head.remove(ctx, pop);
    for (const s of this.segs) s.remove(ctx, pop);
    for (const s of this.popQueue) s.remove(ctx, pop);
    this.segs.length = 0;
    this.popQueue.length = 0;
    this.alive = false;
  }

  setCollidable(on: boolean) {
    if (this.head.alive) this.head.collidable = on;
    for (const s of this.segs) if (s.alive) s.collidable = on;
  }

  dispose() {
    // parts' meshes are disposed by the game's enemy list; just make sure they get reaped
    this.head.remove();
    for (const s of this.segs) s.remove();
    for (const s of this.popQueue) s.remove();
    this.alive = false;
  }
}
