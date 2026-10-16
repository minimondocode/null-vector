import * as THREE from 'three';
import type { Arena } from './Arena';
import type { Enemy } from './types';
import { PLAY_Y } from './config';

export interface Bullet {
  active: boolean;
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Seconds remaining. */
  life: number;
  radius: number;
  damage: number;
  pierce: number;
  ricochet: number;
  crit: boolean;
  /** 0..1 steering strength toward nearest enemy (player bullets). */
  homing: number;
  /** Optional acceleration along velocity (units/s²). Negative = slows down. */
  accel: number;
  /** Optional angular velocity (rad/s) — curving bullets. */
  curve: number;
  color: THREE.Color;
  /** Enemies already hit (pierce shouldn't hit the same one twice). */
  hit: Enemy[];
  /** Free slot for spawner-specific data. */
  tag: number;
}

export interface BulletSpawn {
  x: number;
  z: number;
  vx: number;
  vz: number;
  life?: number;
  radius?: number;
  damage?: number;
  pierce?: number;
  ricochet?: number;
  crit?: boolean;
  homing?: number;
  accel?: number;
  curve?: number;
  color?: number;
  tag?: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _n = new THREE.Vector2();
const _tmp = new THREE.Vector3();

/**
 * Pooled bullets drawn with one InstancedMesh. `style` controls the look:
 * 'bolt' = elongated player shot, 'orb' = round enemy shot (readable, glowing core).
 */
export class BulletPool {
  readonly items: Bullet[] = [];
  private mesh: THREE.InstancedMesh;
  private core?: THREE.InstancedMesh;
  /** Called when a bullet dies on a wall (for sparks). */
  onWallHit?: (b: Bullet) => void;

  constructor(
    scene: THREE.Scene,
    readonly max: number,
    readonly style: 'bolt' | 'orb',
    readonly defaultColor: number,
  ) {
    for (let i = 0; i < max; i++) {
      this.items.push({
        active: false, x: 0, z: 0, vx: 0, vz: 0, life: 0, radius: 0.2, damage: 1, pierce: 0, ricochet: 0,
        crit: false, homing: 0, accel: 0, curve: 0, color: new THREE.Color(defaultColor), hit: [], tag: 0,
      });
    }
    let geo: THREE.BufferGeometry;
    if (style === 'bolt') {
      geo = new THREE.CapsuleGeometry(0.5, 2.2, 2, 6);
      geo.rotateX(Math.PI / 2); // length along Z
    } else {
      geo = new THREE.IcosahedronGeometry(1, 1);
    }
    // >1 so bullets cross the bloom threshold (VFX: max-channel high pass at ~0.85)
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1).multiplyScalar(style === 'orb' ? 2.2 : 2.4), transparent: style === 'orb', opacity: style === 'orb' ? 0.9 : 1, depthWrite: false, toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color());
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
    if (style === 'orb') {
      // white-hot core so enemy shots read against any background
      const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.5, 2.5, 2.5), toneMapped: false, depthWrite: false });
      this.core = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.55, 1), coreMat, max);
      this.core.frustumCulled = false;
      this.core.count = 0;
      this.core.renderOrder = 6;
      scene.add(this.core);
    }
  }

  spawn(o: BulletSpawn): Bullet | null {
    for (const b of this.items) {
      if (b.active) continue;
      b.active = true;
      b.x = o.x;
      b.z = o.z;
      b.vx = o.vx;
      b.vz = o.vz;
      b.life = o.life ?? 3;
      b.radius = o.radius ?? 0.25;
      b.damage = o.damage ?? 1;
      b.pierce = o.pierce ?? 0;
      b.ricochet = o.ricochet ?? 0;
      b.crit = o.crit ?? false;
      b.homing = o.homing ?? 0;
      b.accel = o.accel ?? 0;
      b.curve = o.curve ?? 0;
      b.color.setHex(o.color ?? this.defaultColor);
      b.hit.length = 0;
      b.tag = o.tag ?? 0;
      return b;
    }
    return null;
  }

  get activeCount() {
    let n = 0;
    for (const b of this.items) if (b.active) n++;
    return n;
  }

  clear() {
    for (const b of this.items) b.active = false;
  }

  update(dt: number, arena: Arena, enemies?: Enemy[]) {
    for (const b of this.items) {
      if (!b.active) continue;
      b.life -= dt;
      if (b.life <= 0) {
        b.active = false;
        continue;
      }
      if (b.curve !== 0) {
        const c = Math.cos(b.curve * dt), s = Math.sin(b.curve * dt);
        const vx = b.vx * c - b.vz * s;
        b.vz = b.vx * s + b.vz * c;
        b.vx = vx;
      }
      if (b.accel !== 0) {
        const sp = Math.hypot(b.vx, b.vz);
        const ns = Math.max(2, sp + b.accel * dt);
        b.vx *= ns / sp;
        b.vz *= ns / sp;
      }
      if (b.homing > 0 && enemies && enemies.length) {
        let best: Enemy | null = null;
        let bd = 14 * 14;
        for (const e of enemies) {
          if (!e.alive || !e.collidable || b.hit.includes(e)) continue;
          const d = (e.pos.x - b.x) ** 2 + (e.pos.z - b.z) ** 2;
          if (d < bd) {
            bd = d;
            best = e;
          }
        }
        if (best) {
          const sp = Math.hypot(b.vx, b.vz);
          const dx = best.pos.x - b.x, dz = best.pos.z - b.z;
          const dl = Math.hypot(dx, dz) || 1;
          const k = Math.min(1, b.homing * 6 * dt);
          b.vx += (dx / dl * sp - b.vx) * k;
          b.vz += (dz / dl * sp - b.vz) * k;
          const ns = Math.hypot(b.vx, b.vz) || 1;
          b.vx *= sp / ns;
          b.vz *= sp / ns;
        }
      }
      b.x += b.vx * dt;
      b.z += b.vz * dt;
      _tmp.set(b.x, 0, b.z);
      if (arena.clamp(_tmp, b.radius, _n)) {
        if (b.ricochet > 0) {
          b.ricochet--;
          const d = b.vx * _n.x + b.vz * _n.y;
          b.vx -= 2 * d * _n.x;
          b.vz -= 2 * d * _n.y;
          b.x = _tmp.x;
          b.z = _tmp.z;
          b.hit.length = 0;
          this.onWallHit?.(b);
        } else {
          b.x = _tmp.x;
          b.z = _tmp.z;
          b.active = false;
          this.onWallHit?.(b);
        }
      }
    }
  }

  /** Upload instance transforms. Call once per frame before render. */
  sync(time: number) {
    let n = 0;
    for (const b of this.items) {
      if (!b.active) continue;
      _p.set(b.x, PLAY_Y, b.z);
      if (this.style === 'bolt') {
        const a = Math.atan2(b.vx, b.vz);
        _q.setFromAxisAngle(_up, a);
        const r = b.radius * (b.crit ? 1.5 : 1);
        _s.set(r, r, r);
      } else {
        _q.identity();
        const pulse = 1 + Math.sin(time * 18 + b.tag) * 0.12;
        const r = b.radius * pulse;
        _s.set(r, r, r);
      }
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(n, _m);
      this.mesh.setColorAt(n, b.color);
      if (this.core) {
        _s.multiplyScalar(1);
        this.core.setMatrixAt(n, _m);
      }
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    if (this.core) {
      this.core.count = n;
      this.core.instanceMatrix.needsUpdate = true;
    }
  }
}
