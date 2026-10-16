import * as THREE from 'three';
import type { ArenaShape } from './config';

/**
 * Arena boundary logic on the XZ plane (no visuals; see vfx/ArenaVisual).
 * Polygons are described by edge normals + apothem, which makes clamp/reflect trivial.
 * `size` is mutable at runtime (ROOT shrinks the arena) — call setSize.
 */
export class Arena {
  shape: ArenaShape = 'square';
  /** Half-extent for square, radius (circumradius) for circle/hex. */
  size = 22;
  private normals: THREE.Vector2[] = [];
  private apothem = 22;

  configure(shape: ArenaShape, size: number) {
    this.shape = shape;
    this.normals = [];
    if (shape === 'square') {
      for (let i = 0; i < 4; i++) this.normals.push(new THREE.Vector2(Math.cos((i * Math.PI) / 2), Math.sin((i * Math.PI) / 2)));
    } else if (shape === 'hex') {
      // flat-top hexagon: vertices at 0°,60°..; edge normals at 30°+60k
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + (i * Math.PI) / 3;
        this.normals.push(new THREE.Vector2(Math.cos(a), Math.sin(a)));
      }
    }
    this.setSize(size);
  }

  setSize(size: number) {
    this.size = size;
    this.apothem = this.shape === 'hex' ? size * Math.cos(Math.PI / 6) : size;
  }

  /** Distance from point to the boundary (positive inside). */
  distanceToEdge(x: number, z: number): number {
    if (this.shape === 'circle') return this.size - Math.hypot(x, z);
    let d = Infinity;
    for (const n of this.normals) d = Math.min(d, this.apothem - (x * n.x + z * n.y));
    return d;
  }

  contains(x: number, z: number, radius = 0) {
    return this.distanceToEdge(x, z) >= radius;
  }

  /**
   * Push a position back inside. Returns the wall normal (pointing inward) if a clamp happened,
   * else null. Writes into `outNormal` if given.
   */
  clamp(pos: THREE.Vector3, radius = 0, outNormal?: THREE.Vector2): boolean {
    let hit = false;
    if (this.shape === 'circle') {
      const r = Math.hypot(pos.x, pos.z);
      const max = this.size - radius;
      if (r > max && r > 0) {
        if (outNormal) outNormal.set(-pos.x / r, -pos.z / r);
        pos.x *= max / r;
        pos.z *= max / r;
        hit = true;
      }
      return hit;
    }
    for (const n of this.normals) {
      const d = pos.x * n.x + pos.z * n.y - (this.apothem - radius);
      if (d > 0) {
        pos.x -= n.x * d;
        pos.z -= n.y * d;
        if (outNormal) outNormal.set(-n.x, -n.y);
        hit = true;
      }
    }
    return hit;
  }

  /** Uniform-ish random point inside, at least `margin` from walls. */
  randomPoint(margin = 2, out = new THREE.Vector3()): THREE.Vector3 {
    for (let i = 0; i < 30; i++) {
      out.set((Math.random() * 2 - 1) * this.size, 0, (Math.random() * 2 - 1) * this.size);
      if (this.contains(out.x, out.z, margin)) return out;
    }
    return out.set(0, 0, 0);
  }

  /** Random point near the boundary (for spawning), `inset` units inside the wall. */
  randomEdgePoint(inset = 2, out = new THREE.Vector3()): THREE.Vector3 {
    const a = Math.random() * Math.PI * 2;
    const dir = new THREE.Vector2(Math.cos(a), Math.sin(a));
    // march outward until we hit the wall
    let r = 0;
    while (r < this.size * 2 && this.contains(dir.x * r, dir.y * r, inset)) r += 0.5;
    return out.set(dir.x * (r - 0.5), 0, dir.y * (r - 0.5));
  }

  /** Corner vertices on XZ for drawing (circle returns many segments). */
  outline(segments = 96): THREE.Vector2[] {
    const pts: THREE.Vector2[] = [];
    if (this.shape === 'circle') {
      for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        pts.push(new THREE.Vector2(Math.cos(a) * this.size, Math.sin(a) * this.size));
      }
    } else if (this.shape === 'square') {
      const s = this.size;
      pts.push(new THREE.Vector2(s, s), new THREE.Vector2(-s, s), new THREE.Vector2(-s, -s), new THREE.Vector2(s, -s));
    } else {
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3;
        pts.push(new THREE.Vector2(Math.cos(a) * this.size, Math.sin(a) * this.size));
      }
    }
    return pts;
  }
}
