import * as THREE from 'three';

/** Smooth 1D gradient noise in [-1, 1] (Perlin-style, quintic fade). */
const PERM = new Uint8Array(512);
const GRAD = new Float32Array(256);
{
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let seed = 1337;
  for (let i = 255; i > 0; i--) {
    seed = (seed * 16807) % 2147483647;
    const j = seed % (i + 1);
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
  for (let i = 0; i < 256; i++) {
    seed = (seed * 16807) % 2147483647;
    GRAD[i] = (seed / 2147483647) * 2 - 1;
  }
}

export function noise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = GRAD[PERM[i & 255]] * f;
  const b = GRAD[PERM[(i + 1) & 255]] * (f - 1);
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  return (a + (b - a) * u) * 2;
}

/**
 * Trauma-based camera shake: offset = maxOffset * trauma² * noise(t).
 * Trauma decays linearly; shake() adds to it.
 */
export class Shake {
  trauma = 0;
  readonly offset = new THREE.Vector3();
  /** World units at trauma 1. */
  maxOffset = 1.1;
  frequency = 22;
  decay = 1.5;
  private t = 0;

  add(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(realDt: number, scale: number) {
    this.t += realDt;
    this.trauma = Math.max(0, this.trauma - realDt * this.decay);
    const s = this.trauma * this.trauma * this.maxOffset * scale;
    if (s <= 1e-5) {
      this.offset.set(0, 0, 0);
      return;
    }
    const ft = this.t * this.frequency;
    this.offset.set(noise1(ft) * s, noise1(ft + 71.3) * s * 0.5, noise1(ft + 151.7) * s);
  }
}
