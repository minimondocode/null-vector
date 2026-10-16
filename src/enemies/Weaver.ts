import * as THREE from 'three';
import type { GameContext } from '../game/types';
import { EnemyBase, fireRate, glowColor, neonShared, scaledHp, scaledSpeed, telegraphMat, tuning } from './EnemyBase';

export const WEAVER_COLOR = 0xff4dff;
const MINE_COLOR = 0xff5ae0;
const BLAST_R = 2.7;
const _w = new THREE.Color();

function makeFin() {
  const g = new THREE.ConeGeometry(0.22, 0.7, 3);
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0, -1.05);
  return g;
}

/**
 * Proximity mine left by Weavers. Doesn't count for the wave. Shootable (pops harmlessly).
 * Telegraph: floor ring = exact blast radius, inner disc fills up as the fuse burns, blink accelerates.
 * Player within 2.2 shortens the fuse to 0.7s.
 */
export class Mine extends EnemyBase {
  kind = 'mine';
  private fuse: number;
  private total: number;
  private ring: THREE.Mesh;
  private disc: THREE.Mesh;
  private discMat: THREE.MeshBasicMaterial;
  private ringMat: THREE.MeshBasicMaterial;
  private lightMat: THREE.MeshBasicMaterial;
  private spike: THREE.Object3D;
  private tripped = false;

  constructor(ctx: GameContext, x: number, z: number) {
    super(ctx, x, z, MINE_COLOR, 0.35);
    this.radius = 0.45;
    this.hp = this.maxHp = 1;
    this.scoreValue = 10;
    this.countsForWave = false;
    this.contactDamage = false;
    this.knockResist = 0;
    this.total = this.fuse = 3.2;
    const sp = neonShared(
      'mine',
      () => {
        const g = new THREE.OctahedronGeometry(0.4, 0);
        g.scale(1, 0.6, 1);
        return g;
      },
      MINE_COLOR,
      2.6,
    );
    this.spike = sp.group;
    this.lightMat = new THREE.MeshBasicMaterial({ color: glowColor(0xffffff, 2), toneMapped: false });
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 4), this.lightMat);
    light.position.y = 0.28;
    this.body.add(this.spike, light);
    this.registerEdges(sp.edgeMat);

    this.ringMat = telegraphMat(MINE_COLOR, 0.35);
    this.ring = new THREE.Mesh(new THREE.RingGeometry(BLAST_R - 0.12, BLAST_R, 40), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = -0.54;
    this.discMat = telegraphMat(MINE_COLOR, 0.18);
    this.disc = new THREE.Mesh(new THREE.CircleGeometry(BLAST_R, 40), this.discMat);
    this.disc.rotation.x = -Math.PI / 2;
    this.disc.position.y = -0.55;
    this.disc.scale.setScalar(0.01);
    this.object.add(this.ring, this.disc);
  }

  protected think(ctx: GameContext, dt: number) {
    this.vel.set(0, 0, 0);
    this.fuse -= dt;
    const p = ctx.player.pos;
    const d2 = (p.x - this.pos.x) ** 2 + (p.z - this.pos.z) ** 2;
    if (!this.tripped && d2 < 2.2 * 2.2 && this.fuse > 0.7) {
      this.tripped = true;
      this.fuse = 0.7;
      this.total = Math.max(this.total, 0.7);
      ctx.bus.emit('enemyTelegraph', { pos: this.pos.clone(), kind: this.kind });
    }
    const t = 1 - Math.max(0, this.fuse) / this.total;
    this.disc.scale.setScalar(Math.max(0.01, this.tripped ? Math.max(t, 0.6 + t * 0.4) : t));
    const blinkHz = 2 + t * t * 18;
    const on = Math.sin(ctx.time * blinkHz * Math.PI * 2) > 0;
    this.lightMat.color.copy(on ? _w.setRGB(5, 5, 5) : glowColor(MINE_COLOR, 1.5));
    this.ringMat.opacity = 0.3 + (on ? 0.3 : 0) * t;
    this.discMat.opacity = 0.1 + t * 0.22;
    this.spike.rotation.y += dt * (1.5 + t * 10);
    this.body.position.y = -0.25 + Math.sin(ctx.time * 3 + this.pos.x) * 0.05;
    if (this.fuse <= 0) this.detonate(ctx);
  }

  private detonate(ctx: GameContext) {
    this.alive = false;
    ctx.bus.emit('explosion', { pos: this.pos.clone(), color: MINE_COLOR, size: 2.4 });
    ctx.vfx.ring(this.pos, MINE_COLOR, BLAST_R, 0.35);
    const p = ctx.player;
    const r = BLAST_R + p.radius * 0.5;
    if (p.alive && (p.pos.x - this.pos.x) ** 2 + (p.pos.z - this.pos.z) ** 2 < r * r) p.hurt(ctx, this.pos);
    if (tuning.tier >= 2) {
      // late game: shrapnel ring, slow and gappy
      const off = Math.random() * Math.PI;
      for (let i = 0; i < 6; i++) this.shoot(ctx, off + (i / 6) * Math.PI * 2, 6.5, MINE_COLOR, 0.28, 0.5);
    }
  }
}

/**
 * "Weaver": a spinning ring that slaloms across the arena on a sine path, seeding mines.
 * Area denial: it never chases, but it reshapes the space you can move in.
 */
export class Weaver extends EnemyBase {
  kind = 'weaver';
  private speed: number;
  private target = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private phase = Math.random() * Math.PI * 2;
  private mineTimer: number;
  private mines: Mine[] = [];
  private ringObj: THREE.Object3D;
  private fins = new THREE.Group();
  private drop = 0;

  constructor(ctx: GameContext, x: number, z: number) {
    super(ctx, x, z, WEAVER_COLOR, 0.9);
    this.radius = 0.85;
    this.hp = this.maxHp = scaledHp(ctx, 7);
    this.scoreValue = 220;
    this.dropTier = 2;
    this.knockResist = 0.5;
    this.speed = scaledSpeed(ctx, 4.6);
    this.mineTimer = 1.2;
    const ring = neonShared(
      'weaver-ring',
      () => {
        const g = new THREE.TorusGeometry(0.75, 0.16, 4, 8);
        g.rotateX(Math.PI / 2);
        return g;
      },
      this.color,
    );
    this.ringObj = ring.group;
    const fin = neonShared('weaver-fin', makeFin, this.color, 2.4);
    const fin2 = neonShared('weaver-fin', makeFin, this.color, 2.4);
    fin.group.rotation.y = 0.35;
    fin2.group.rotation.y = -0.35;
    this.fins.add(fin.group, fin2.group);
    const core = neonShared('weaver-core', () => new THREE.OctahedronGeometry(0.28, 0), 0xffffff, 2, 1);
    this.body.add(this.ringObj, this.fins, core.group);
    this.registerEdges(ring.edgeMat, fin.edgeMat, fin2.edgeMat);
    this.pickTarget(ctx);
  }

  private pickTarget(ctx: GameContext) {
    // cut across the arena, passing near (not onto) the player
    const p = ctx.player.pos;
    const ax = p.x + (Math.random() - 0.5) * 8 - this.pos.x;
    const az = p.z + (Math.random() - 0.5) * 8 - this.pos.z;
    const l = Math.hypot(ax, az) || 1;
    const reach = ctx.arena.size * 1.6;
    this.target.set(this.pos.x + (ax / l) * reach, 0, this.pos.z + (az / l) * reach);
    ctx.arena.clamp(this.target, 3);
  }

  protected think(ctx: GameContext, dt: number) {
    this.dir.subVectors(this.target, this.pos).setY(0);
    const dl = this.dir.length();
    if (dl < 2.5) this.pickTarget(ctx);
    this.dir.multiplyScalar(1 / (dl || 1));
    this.phase += dt * 2.6;
    const lat = Math.cos(this.phase) * 1.3;
    const vx = (this.dir.x - this.dir.z * lat) * this.speed;
    const vz = (this.dir.z + this.dir.x * lat) * this.speed;
    this.vel.x += (vx - this.vel.x) * Math.min(1, dt * 4);
    this.vel.z += (vz - this.vel.z) * Math.min(1, dt * 4);
    this.separate(ctx, 0.5);
    this.pos.addScaledVector(this.vel, dt);
    if (ctx.arena.distanceToEdge(this.pos.x, this.pos.z) < this.radius + 0.3) this.pickTarget(ctx);
    this.faceVelocity(dt, 6);

    // mines
    for (let i = this.mines.length - 1; i >= 0; i--) if (!this.mines[i].alive) this.mines.splice(i, 1);
    this.mineTimer -= dt;
    if (this.mineTimer <= 0) {
      const max = 3 + tuning.tier;
      const pd = this.distToPlayer(ctx);
      if (this.mines.length < max && pd > 3.5) {
        const m = new Mine(ctx, this.pos.x, this.pos.z);
        this.mines.push(m);
        ctx.addEnemy(m);
        this.drop = 1;
        ctx.bus.emit('enemyShoot', { pos: this.pos.clone(), kind: this.kind });
      }
      this.mineTimer = (1.8 + Math.random() * 0.6) / fireRate(ctx);
    }

    // visuals
    this.ringObj.rotation.y += dt * 4;
    this.ringObj.rotation.x = Math.sin(this.phase) * 0.35; // banks with the slalom
    this.fins.rotation.z = Math.sin(this.phase) * 0.4;
    this.drop = Math.max(0, this.drop - dt * 4);
    this.body.scale.set(1 + this.drop * 0.25, 1 - this.drop * 0.3, 1 + this.drop * 0.25);
  }
}
