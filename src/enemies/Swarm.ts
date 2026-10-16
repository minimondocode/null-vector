import * as THREE from 'three';
import type { GameContext } from '../game/types';
import { EnemyBase, neonShared, scaledHp, scaledSpeed } from './EnemyBase';

export const SWARM_COLOR = 0xb6ff2b;
const _f = new THREE.Vector3();

/**
 * Shared flock brain. The flock alternates between ORBIT (circling the player at range,
 * loose) and STRIKE (tightens, flashes for a beat, then sweeps through the player's position).
 * The first alive member advances the shared clock each frame.
 */
export class Flock {
  members: Swarmling[] = [];
  mode: 'orbit' | 'tell' | 'strike' = 'orbit';
  timer = 2.5 + Math.random();
  stamp = -1;
  orbitDir = Math.random() < 0.5 ? 1 : -1;
  angle = Math.random() * Math.PI * 2;
  goal = new THREE.Vector3();
  cx = 0;
  cz = 0;
  vx = 0;
  vz = 0;
  count = 0;

  tick(ctx: GameContext, dt: number) {
    if (this.stamp === ctx.time) return;
    this.stamp = ctx.time;
    // centroid + mean velocity once per frame
    let n = 0, cx = 0, cz = 0, vx = 0, vz = 0;
    for (const m of this.members) {
      if (!m.alive || !m.collidable) continue;
      n++;
      cx += m.pos.x;
      cz += m.pos.z;
      vx += m.vel.x;
      vz += m.vel.z;
    }
    this.count = n;
    if (n) {
      this.cx = cx / n;
      this.cz = cz / n;
      this.vx = vx / n;
      this.vz = vz / n;
    }
    this.timer -= dt;
    const p = ctx.player.pos;
    if (this.mode === 'orbit') {
      this.angle += this.orbitDir * dt * 0.9;
      this.goal.set(p.x + Math.cos(this.angle) * 8, 0, p.z + Math.sin(this.angle) * 8);
      if (this.timer <= 0) {
        this.mode = 'tell';
        this.timer = 0.55;
        ctx.bus.emit('enemyTelegraph', { pos: new THREE.Vector3(this.cx, 0, this.cz), kind: 'swarm' });
      }
    } else if (this.mode === 'tell') {
      this.goal.set(this.cx, 0, this.cz);
      if (this.timer <= 0) {
        this.mode = 'strike';
        this.timer = 1.5;
        // aim through the player: goal is past them so the flock sweeps rather than parks
        const dx = p.x - this.cx, dz = p.z - this.cz;
        const l = Math.hypot(dx, dz) || 1;
        this.goal.set(p.x + (dx / l) * 6, 0, p.z + (dz / l) * 6);
        ctx.arena.clamp(this.goal, 2);
      }
    } else if (this.timer <= 0) {
      this.mode = 'orbit';
      this.timer = 2.4 + Math.random() * 1.4;
      this.angle = Math.atan2(this.cz - p.z, this.cx - p.x);
      if (Math.random() < 0.4) this.orbitDir *= -1;
    }
  }
}

/** One boid of a swarm flock: tiny lime triangle, 1 HP, fast. */
export class Swarmling extends EnemyBase {
  kind = 'swarm';
  private speed: number;
  private hull = new THREE.Group();
  private phase = Math.random() * 10;

  constructor(ctx: GameContext, x: number, z: number, readonly flock: Flock) {
    super(ctx, x, z, SWARM_COLOR, 0.6 + Math.random() * 0.2);
    this.radius = 0.38;
    this.hp = this.maxHp = scaledHp(ctx, 1);
    this.scoreValue = 25;
    this.dropTier = 0.35;
    this.speed = scaledSpeed(ctx, 9.5);
    flock.members.push(this);
    const { group, edgeMat } = neonShared(
      'swarm',
      () => {
        const s = new THREE.Shape();
        s.moveTo(0, 0.55);
        s.lineTo(0.38, -0.35);
        s.lineTo(0, -0.18);
        s.lineTo(-0.38, -0.35);
        s.closePath();
        const g = new THREE.ExtrudeGeometry(s, { depth: 0.1, bevelEnabled: false });
        g.rotateX(Math.PI / 2); // shape +Y -> +Z (forward)
        g.translate(0, 0.05, 0);
        return g;
      },
      this.color,
      3.2,
    );
    this.hull.add(group);
    this.body.add(this.hull);
    this.registerEdges(edgeMat);
    const a = Math.random() * Math.PI * 2;
    this.vel.set(Math.cos(a), 0, Math.sin(a)).multiplyScalar(2);
  }

  protected think(ctx: GameContext, dt: number) {
    const f = this.flock;
    f.tick(ctx, dt);
    const strike = f.mode === 'strike';
    const tell = f.mode === 'tell';
    const maxSp = this.speed * (strike ? 1.45 : tell ? 0.55 : 1);

    // goal seeking
    _f.set(f.goal.x - this.pos.x, 0, f.goal.z - this.pos.z);
    const gl = _f.length() || 1;
    _f.multiplyScalar((strike ? 2.2 : 1.2) / gl);
    let ax = _f.x, az = _f.z;
    // cohesion
    ax += (f.cx - this.pos.x) * (tell ? 1.4 : 0.35);
    az += (f.cz - this.pos.z) * (tell ? 1.4 : 0.35);
    // alignment
    ax += (f.vx - this.vel.x) * 0.25;
    az += (f.vz - this.vel.z) * 0.25;
    // separation (flock-local)
    for (const o of f.members) {
      if (o === this || !o.alive) continue;
      const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 1.1 && d2 > 1e-4) {
        const k = (1.1 - d2) * 6;
        ax += dx * k;
        az += dz * k;
      }
    }
    // walls
    const we = ctx.arena.distanceToEdge(this.pos.x, this.pos.z);
    if (we < 3) {
      const l = Math.hypot(this.pos.x, this.pos.z) || 1;
      ax -= (this.pos.x / l) * (3 - we) * 3;
      az -= (this.pos.z / l) * (3 - we) * 3;
    }
    this.vel.x += ax * maxSp * dt * 2.2;
    this.vel.z += az * maxSp * dt * 2.2;
    const sp = this.vel.length();
    if (sp > maxSp) this.vel.multiplyScalar(maxSp / sp);
    this.pos.addScaledVector(this.vel, dt);
    this.faceVelocity(dt, 14);

    // visuals: flap roll, flash during tell
    this.hull.rotation.z = Math.sin(ctx.time * 14 + this.phase) * 0.45;
    const s = tell ? 1.2 + Math.sin(ctx.time * 40) * 0.15 : strike ? 1.1 : 1;
    this.hull.scale.set(s * (strike ? 0.8 : 1), 1, s * (strike ? 1.35 : 1));
    if (tell) this.flash = Math.max(this.flash, 0.06);
  }

  dispose() {
    super.dispose();
    const i = this.flock.members.indexOf(this);
    if (i >= 0) this.flock.members.splice(i, 1);
  }
}
