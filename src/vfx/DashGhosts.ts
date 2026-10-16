import * as THREE from 'three';
import { PLAY_Y } from '../game/config';

interface Ghost {
  line: THREE.LineLoop;
  mat: THREE.LineBasicMaterial;
  age: number;
  life: number;
}

/** Afterimage chevrons left along the dash path (same silhouette as the player ship). */
export class DashGhosts {
  readonly group = new THREE.Group();
  private geo: THREE.BufferGeometry;
  private pool: Ghost[] = [];
  private head = 0;
  private color = new THREE.Color();

  constructor(color: number) {
    this.color.setHex(color);
    const pts = [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0.7, -0.7, 0), new THREE.Vector3(0, -0.35, 0), new THREE.Vector3(-0.7, -0.7, 0)];
    // same transform chain as Player's hull so rotation conventions match
    this.geo = new THREE.BufferGeometry().setFromPoints(pts).rotateX(-Math.PI / 2).rotateY(Math.PI);
  }

  setCount(n: number) {
    while (this.pool.length > n) {
      const g = this.pool.pop()!;
      this.group.remove(g.line);
      g.mat.dispose();
    }
    while (this.pool.length < n) {
      const mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      const line = new THREE.LineLoop(this.geo, mat);
      line.visible = false;
      line.renderOrder = 9;
      this.group.add(line);
      this.pool.push({ line, mat, age: 0, life: 0 });
    }
    this.head = 0;
  }

  spawn(x: number, z: number, rotY: number, life = 0.32) {
    if (!this.pool.length) return;
    const g = this.pool[this.head];
    this.head = (this.head + 1) % this.pool.length;
    g.age = 0;
    g.life = life;
    g.line.visible = true;
    g.line.position.set(x, PLAY_Y, z);
    g.line.rotation.set(0, rotY, 0);
  }

  update(dt: number) {
    for (const g of this.pool) {
      if (!g.line.visible) continue;
      g.age += dt;
      const t = g.age / g.life;
      if (t >= 1) {
        g.line.visible = false;
        continue;
      }
      const k = 1 - t;
      g.mat.color.copy(this.color).multiplyScalar(2.6 * k * k + 0.2);
      g.mat.opacity = k;
      g.line.scale.setScalar(0.85 * (1 + t * 0.35));
    }
  }

  dispose() {
    this.setCount(0);
    this.geo.dispose();
  }
}
