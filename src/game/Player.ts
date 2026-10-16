import * as THREE from 'three';
import { PLAYER_BULLET_COLOR, PLAYER_COLOR, PLAY_Y } from './config';
import { baseStats, type PlayerStats } from './Stats';
import type { GameContext } from './types';

const _v = new THREE.Vector3();

function glow(hex: number, k: number) {
  return new THREE.Color(hex).multiplyScalar(k);
}

interface Drone {
  mesh: THREE.Mesh;
  angle: number;
  cooldown: number;
}

export class Player {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  /** Unit vector the ship points to. */
  aim = new THREE.Vector3(0, 0, -1);
  radius = 0.55;
  stats: PlayerStats = baseStats(5);
  hp = 5;
  alive = true;
  /** Seconds of invulnerability left (after a hit or during dash). */
  invuln = 0;
  shieldCharges = 0;
  private shieldRecharge = 0;

  dashCooldown = 0;
  /** >0 while dashing (seconds left). */
  dashTime = 0;
  dashDir = new THREE.Vector3();
  /** Segment swept by the current dash (for trail damage). */
  dashFrom = new THREE.Vector3();
  dashTo = new THREE.Vector3();
  /** Increments each dash so enemies take trail damage once per dash. */
  dashId = 0;

  private fireCooldown = 0;
  readonly object = new THREE.Group();
  private ship = new THREE.Group();
  private shieldMesh: THREE.Mesh;
  private engine: THREE.Mesh;
  private drones: Drone[] = [];
  private bank = 0;

  constructor(scene: THREE.Scene) {
    // Arrowhead hull: flat extruded chevron with bright edges
    const shape = new THREE.Shape();
    shape.moveTo(0, 1.0);
    shape.lineTo(0.7, -0.7);
    shape.lineTo(0, -0.35);
    shape.lineTo(-0.7, -0.7);
    shape.closePath();
    const hullGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.22, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.04, bevelSegments: 1 });
    hullGeo.rotateX(-Math.PI / 2); // shape +Y (nose) -> world -Z
    hullGeo.translate(0, -0.11, 0);
    const hull = new THREE.Mesh(hullGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(0x02161a) }));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(hullGeo, 20), new THREE.LineBasicMaterial({ color: glow(PLAYER_COLOR, 3), toneMapped: false }));
    const cockpit = new THREE.Mesh(new THREE.OctahedronGeometry(0.18), new THREE.MeshBasicMaterial({ color: glow(0xffffff, 2.5), toneMapped: false }));
    cockpit.position.set(0, 0.15, 0.05);
    this.engine = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), new THREE.MeshBasicMaterial({ color: glow(PLAYER_COLOR, 4), toneMapped: false }));
    this.engine.position.set(0, 0, 0.45);
    this.ship.add(hull, edges, cockpit, this.engine);
    this.ship.scale.setScalar(0.85);

    this.shieldMesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.0, 2),
      new THREE.MeshBasicMaterial({ color: glow(0x6cf3ff, 1.4), wireframe: true, transparent: true, opacity: 0.35, toneMapped: false, depthWrite: false }),
    );
    this.shieldMesh.visible = false;
    this.object.add(this.ship, this.shieldMesh);
    scene.add(this.object);
  }

  reset(maxHp: number) {
    this.stats = baseStats(maxHp);
    this.hp = maxHp;
    this.alive = true;
    this.pos.set(0, 0, 0);
    this.vel.set(0, 0, 0);
    this.invuln = 1.5;
    this.dashCooldown = 0;
    this.dashTime = 0;
    this.fireCooldown = 0;
    this.shieldCharges = 0;
    this.object.visible = true;
    this.syncDrones();
  }

  get dashing() {
    return this.dashTime > 0;
  }

  /** Recreate drone meshes when stats.drones changes. */
  syncDrones() {
    while (this.drones.length > this.stats.drones) {
      const d = this.drones.pop()!;
      this.object.parent?.remove(d.mesh);
    }
    while (this.drones.length < this.stats.drones) {
      const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.22), new THREE.MeshBasicMaterial({ color: glow(PLAYER_COLOR, 3), wireframe: true, toneMapped: false }));
      this.object.parent?.add(m);
      this.drones.push({ mesh: m, angle: 0, cooldown: Math.random() });
    }
    this.drones.forEach((d, i) => (d.angle = (i / Math.max(1, this.drones.length)) * Math.PI * 2));
    this.shieldCharges = Math.max(this.shieldCharges, this.stats.shield);
  }

  update(ctx: GameContext, dt: number) {
    if (!this.alive) return;
    const input = ctx.input;
    const s = this.stats;

    this.invuln = Math.max(0, this.invuln - dt);
    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    const wasReady = this.dashCooldown <= 0;

    // aim at mouse
    _v.subVectors(ctx.aimPoint, this.pos).setY(0);
    if (_v.lengthSq() > 0.01) this.aim.copy(_v.normalize());

    // movement (screen up = -Z)
    const m = input.moveAxis();
    if (this.dashTime > 0) {
      this.dashTime -= dt;
      const step = (s.dashDistance / 0.14) * dt;
      this.dashFrom.copy(this.pos);
      this.pos.addScaledVector(this.dashDir, step);
      ctx.arena.clamp(this.pos, this.radius);
      this.dashTo.copy(this.pos);
      if (this.dashTime <= 0) {
        this.vel.copy(this.dashDir).multiplyScalar(s.moveSpeed);
        this.invuln = Math.max(this.invuln, 0.12);
      }
    } else {
      const target = _v.set(m.x, 0, -m.y).multiplyScalar(s.moveSpeed);
      const accel = m.x || m.y ? 14 : 10;
      this.vel.lerp(target, 1 - Math.exp(-accel * dt));
      this.pos.addScaledVector(this.vel, dt);
      ctx.arena.clamp(this.pos, this.radius);

      if (input.dashPressed() && this.dashCooldown <= 0) {
        if (m.x || m.y) this.dashDir.set(m.x, 0, -m.y).normalize();
        else this.dashDir.copy(this.aim);
        this.dashTime = 0.14;
        this.dashCooldown = s.dashCooldown;
        this.invuln = Math.max(this.invuln, 0.2);
        this.dashId++;
        this.dashFrom.copy(this.pos);
        this.dashTo.copy(this.pos);
        ctx.bus.emit('playerDash', { pos: this.pos.clone(), dir: this.dashDir.clone() });
      }
    }
    if (!wasReady && this.dashCooldown <= 0) ctx.bus.emit('dashReady', {});

    // shooting
    this.fireCooldown -= dt;
    if (input.mouseLeft && this.fireCooldown <= 0) {
      this.fireCooldown = 1 / s.fireRate;
      this.fire(ctx, this.aim, s.projectiles, true);
      for (let i = 0; i < s.rearGuns; i++) {
        _v.copy(this.aim).negate();
        this.fire(ctx, _v, 1 + i, false);
      }
      ctx.bus.emit('playerShoot', { pos: this.pos.clone(), dir: this.aim.clone() });
    }

    // shield recharge
    if (this.shieldCharges < s.shield) {
      this.shieldRecharge += dt;
      if (this.shieldRecharge > 9) {
        this.shieldRecharge = 0;
        this.shieldCharges++;
      }
    }

    // drones
    for (const d of this.drones) {
      d.angle += dt * 2.2;
      d.mesh.position.set(this.pos.x + Math.cos(d.angle) * 1.8, PLAY_Y + 0.3, this.pos.z + Math.sin(d.angle) * 1.8);
      d.mesh.rotation.y += dt * 5;
      d.cooldown -= dt;
      if (d.cooldown <= 0) {
        let best = null as null | THREE.Vector3;
        let bd = 18 * 18;
        for (const e of ctx.enemies) {
          if (!e.alive || !e.collidable) continue;
          const dd = e.pos.distanceToSquared(d.mesh.position);
          if (dd < bd) {
            bd = dd;
            best = e.pos;
          }
        }
        if (best) {
          d.cooldown = 0.45;
          const dx = best.x - d.mesh.position.x, dz = best.z - d.mesh.position.z;
          const l = Math.hypot(dx, dz) || 1;
          ctx.playerBullets.spawn({
            x: d.mesh.position.x, z: d.mesh.position.z, vx: (dx / l) * 36, vz: (dz / l) * 36,
            damage: s.damage * 0.6, radius: 0.16, life: 1.2, color: PLAYER_BULLET_COLOR,
          });
        }
      }
    }

    this.updateVisual(ctx, dt);
  }

  private fire(ctx: GameContext, dir: THREE.Vector3, count: number, main: boolean) {
    const s = this.stats;
    const base = Math.atan2(dir.x, dir.z);
    const spread = count > 1 ? s.spread * Math.min(1, 0.45 + count * 0.18) : 0;
    for (let i = 0; i < count; i++) {
      const t = count > 1 ? i / (count - 1) - 0.5 : 0;
      const a = base + t * spread + (Math.random() - 0.5) * 0.03;
      const crit = Math.random() < s.critChance;
      const sp = s.projectileSpeed * (main ? 1 : 0.85);
      ctx.playerBullets.spawn({
        x: this.pos.x + Math.sin(a) * 0.35,
        z: this.pos.z + Math.cos(a) * 0.35,
        vx: Math.sin(a) * sp,
        vz: Math.cos(a) * sp,
        life: 1.1,
        radius: 0.17 * s.bulletSize,
        damage: s.damage * (crit ? 2.5 : 1) * (main ? 1 : 0.6),
        pierce: s.pierce,
        ricochet: s.ricochet,
        homing: s.homing,
        crit,
        color: crit ? 0xffffff : PLAYER_BULLET_COLOR,
      });
    }
  }

  /** Returns true if the hit landed. */
  hurt(ctx: GameContext, from: THREE.Vector3, amount = 1): boolean {
    if (!this.alive || this.invuln > 0 || this.dashing) return false;
    if (this.shieldCharges > 0) {
      this.shieldCharges--;
      this.shieldRecharge = 0;
      this.invuln = 0.8;
      ctx.bus.emit('explosion', { pos: this.pos.clone(), color: 0x6cf3ff, size: 1.5 });
      ctx.enemyBullets.items.forEach((b) => {
        if (b.active && (b.x - this.pos.x) ** 2 + (b.z - this.pos.z) ** 2 < 16) b.active = false;
      });
      return true;
    }
    this.hp -= amount * ctx.difficulty.damageTaken;
    this.invuln = 1.4;
    // knockback
    _v.subVectors(this.pos, from).setY(0);
    if (_v.lengthSq() > 0.0001) this.vel.addScaledVector(_v.normalize(), 14);
    // clear nearby bullets so a hit isn't followed by an unfair second hit
    ctx.enemyBullets.items.forEach((b) => {
      if (b.active && (b.x - this.pos.x) ** 2 + (b.z - this.pos.z) ** 2 < 25) b.active = false;
    });
    ctx.bus.emit('playerHit', { pos: this.pos.clone(), hp: this.hp });
    if (this.hp <= 0) {
      this.alive = false;
      this.object.visible = false;
      for (const d of this.drones) d.mesh.visible = false;
      ctx.bus.emit('playerDeath', { pos: this.pos.clone() });
    }
    return true;
  }

  heal(ctx: GameContext, amount: number) {
    this.hp = Math.min(this.stats.maxHp, this.hp + amount);
    ctx.bus.emit('playerHeal', { hp: this.hp });
  }

  private updateVisual(ctx: GameContext, dt: number) {
    this.object.position.set(this.pos.x, PLAY_Y, this.pos.z);
    this.ship.rotation.y = Math.atan2(-this.aim.x, -this.aim.z);
    // bank into lateral movement relative to aim
    const lateral = this.vel.x * this.aim.z - this.vel.z * this.aim.x;
    this.bank += (THREE.MathUtils.clamp(lateral * 0.05, -0.6, 0.6) - this.bank) * Math.min(1, dt * 10);
    this.ship.rotation.z = this.bank;
    this.ship.position.y = Math.sin(ctx.runTime * 3) * 0.06;
    const flicker = 0.8 + Math.random() * 0.4 + this.vel.length() / this.stats.moveSpeed;
    this.engine.scale.setScalar(flicker);
    // invulnerability blink
    this.ship.visible = this.invuln > 0 && !this.dashing ? Math.floor(ctx.runTime * 20) % 2 === 0 : true;
    this.shieldMesh.visible = this.shieldCharges > 0;
    this.shieldMesh.rotation.y += dt;
    for (const d of this.drones) d.mesh.visible = true;
  }
}
