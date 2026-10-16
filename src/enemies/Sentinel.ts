import * as THREE from 'three';
import type { GameContext } from '../game/types';
import { EnemyBase, angleDiff, fireRate, glowColor, neonShared, scaledHp, scaledSpeed, stripGeo, telegraphMat, tuning } from './EnemyBase';

export const SENTINEL_COLOR = 0xff8c1a;
const BULLET_COLOR = 0xff9a2e;
const CHARGE = 0.9;
const LOCK = 0.22;
const _t = new THREE.Vector3();
const _white = new THREE.Color(0xffffff);

function makeProng() {
  const g = new THREE.BoxGeometry(0.22, 0.18, 0.55);
  g.translate(0, 0, 1.35);
  return g;
}

/**
 * "Sentinel": a hexagonal turret that strafes at mid-range and fires aimed volleys.
 * Telegraph: core swells & whitens, prong ring spins up, thin aim line appears, locks just before the shot.
 * Pattern by tier: 0 = 3-shot burst, 1 = two 3-way fans, 2 = 5-way fan + follow-up aimed shot.
 */
export class Sentinel extends EnemyBase {
  kind = 'sentinel';
  private state: 'move' | 'charge' | 'fire' = 'move';
  private timer: number;
  private aim = 0;
  private shotsLeft = 0;
  private shotTimer = 0;
  private orbitDir = Math.random() < 0.5 ? 1 : -1;
  private speed: number;
  private ring = new THREE.Group();
  private core: THREE.Mesh;
  private coreMat: THREE.MeshBasicMaterial;
  private turret = new THREE.Group();
  private line: THREE.Mesh;
  private lineMat: THREE.MeshBasicMaterial;
  private recoil = 0;
  private tier: number;

  constructor(ctx: GameContext, x: number, z: number) {
    super(ctx, x, z, SENTINEL_COLOR, 1.0);
    this.radius = 1.0;
    this.hp = this.maxHp = scaledHp(ctx, 9);
    this.scoreValue = 250;
    this.dropTier = 2.5;
    this.knockResist = 0.35;
    this.tier = tuning.tier;
    this.speed = scaledSpeed(ctx, 2.4);
    this.timer = 1.2 + Math.random();

    const base = neonShared(
      'sentinel-base',
      () => {
        const g = new THREE.CylinderGeometry(0.95, 1.05, 0.45, 6);
        return g;
      },
      this.color,
    );
    for (let i = 0; i < 3; i++) {
      const pr = new THREE.Group();
      const m = neonShared('sentinel-prong', makeProng, this.color, 2.2);
      pr.add(m.group);
      pr.rotation.y = (i / 3) * Math.PI * 2;
      this.ring.add(pr);
      this.registerEdges(m.edgeMat);
    }
    const barrel = neonShared(
      'sentinel-barrel',
      () => {
        const g = new THREE.BoxGeometry(0.3, 0.3, 0.9);
        g.translate(0, 0.3, 0.75);
        return g;
      },
      this.color,
      3,
    );
    this.turret.add(barrel.group);
    this.coreMat = new THREE.MeshBasicMaterial({ color: glowColor(SENTINEL_COLOR, 2), toneMapped: false });
    this.core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 1), this.coreMat);
    this.core.position.y = 0.35;
    this.body.add(base.group, this.ring, this.turret, this.core);
    this.registerEdges(base.edgeMat, barrel.edgeMat);

    this.lineMat = telegraphMat(SENTINEL_COLOR, 0);
    this.line = new THREE.Mesh(stripGeo(0.12, 9), this.lineMat);
    this.line.position.y = -0.5;
    this.line.visible = false;
    this.object.add(this.line);
  }

  protected think(ctx: GameContext, dt: number) {
    this.timer -= dt;
    const p = ctx.player.pos;
    const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
    const d = Math.hypot(dx, dz) || 1;

    // movement: keep 10–15 units, strafe; nearly stop while charging/firing
    const moveK = this.state === 'move' ? 1 : 0.2;
    const radial = d > 15 ? 1 : d < 10 ? -1 : 0;
    _t.set((dx / d) * radial - (dz / d) * this.orbitDir, 0, (dz / d) * radial + (dx / d) * this.orbitDir);
    _t.normalize().multiplyScalar(this.speed * moveK);
    this.vel.lerp(_t, 1 - Math.exp(-2 * dt));
    this.separate(ctx, 0.5);
    this.avoidWalls(ctx, 4, 1.5);
    this.pos.addScaledVector(this.vel, dt);
    if (ctx.arena.distanceToEdge(this.pos.x, this.pos.z) < 2 && Math.random() < dt) this.orbitDir *= -1;

    const target = Math.atan2(dx, dz);
    let charge = 0;
    switch (this.state) {
      case 'move':
        this.aim += angleDiff(this.aim, target) * Math.min(1, dt * 3);
        if (this.timer <= 0 && d < 24) {
          this.state = 'charge';
          this.timer = CHARGE;
          ctx.bus.emit('enemyTelegraph', { pos: this.pos.clone(), kind: this.kind });
        }
        break;
      case 'charge': {
        charge = 1 - this.timer / CHARGE;
        const locked = this.timer < LOCK;
        if (!locked) this.aim += angleDiff(this.aim, target) * Math.min(1, dt * 10);
        this.line.visible = true;
        this.line.rotation.y = this.aim;
        this.lineMat.opacity = locked ? (Math.floor(this.timer * 40) % 2 ? 0.9 : 0.5) : charge * 0.35;
        if (this.timer <= 0) {
          this.line.visible = false;
          this.state = 'fire';
          this.shotsLeft = this.tier === 0 ? 3 : this.tier === 1 ? 2 : 2;
          this.shotTimer = 0;
        }
        break;
      }
      case 'fire':
        charge = 1;
        this.shotTimer -= dt;
        if (this.shotTimer <= 0 && this.shotsLeft > 0) {
          this.volley(ctx);
          this.shotsLeft--;
          this.shotTimer = this.tier === 0 ? 0.13 : this.tier === 1 ? 0.35 : 0.3;
          // re-aim slightly between volleys at higher tiers (fair: still slow)
          if (this.tier > 0) this.aim += angleDiff(this.aim, target) * 0.5;
        }
        if (this.shotsLeft <= 0 && this.shotTimer <= 0) {
          this.state = 'move';
          this.timer = (2.6 + Math.random() * 0.8) / fireRate(ctx);
        }
        break;
    }

    // visuals
    this.turret.rotation.y = this.aim;
    this.ring.rotation.y += dt * (0.8 + charge * 9);
    const pulse = 1 + charge * 0.7 + Math.sin(ctx.time * (4 + charge * 30)) * 0.08 * (0.3 + charge);
    this.core.scale.setScalar(pulse);
    this.coreMat.color.setHex(SENTINEL_COLOR).lerp(_white, charge * 0.85).multiplyScalar(2 + charge * 2.5);
    this.recoil = Math.max(0, this.recoil - dt * 6);
    this.turret.position.set(-Math.sin(this.aim) * this.recoil * 0.35, 0, -Math.cos(this.aim) * this.recoil * 0.35);
    this.body.scale.set(1 + this.recoil * 0.08, 1 - this.recoil * 0.12, 1 + this.recoil * 0.08);
    this.body.position.y = Math.sin(ctx.time * 2 + this.pos.x) * 0.08;
  }

  private volley(ctx: GameContext) {
    const sp = 12;
    if (this.tier === 0) {
      this.shoot(ctx, this.aim, sp, BULLET_COLOR, 0.32, 1.3);
    } else if (this.tier === 1) {
      for (let i = -1; i <= 1; i++) this.shoot(ctx, this.aim + i * 0.22, sp * 0.95, BULLET_COLOR, 0.32, 1.3);
    } else {
      if (this.shotsLeft === 2) for (let i = -2; i <= 2; i++) this.shoot(ctx, this.aim + i * 0.2, sp * 0.9, BULLET_COLOR, 0.32, 1.3);
      else this.shoot(ctx, this.angleToPlayer(ctx), sp * 1.25, 0xffd0a0, 0.36, 1.3);
    }
    this.recoil = 1;
    this.knock.set(-Math.sin(this.aim), 0, -Math.cos(this.aim)).multiplyScalar(2.5);
    ctx.bus.emit('enemyShoot', { pos: this.pos.clone(), kind: this.kind });
  }
}
