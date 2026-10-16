import * as THREE from 'three';
import type { Arena } from '../game/Arena';
import { arenaGLSL, shapeIndex } from './shaderChunks';

/** World-space wave speed of grid ripples (units/s) — independent of grid resolution. */
const WAVE_SPEED = 13;
/** Pull back to rest position. */
const ANCHOR_K = 9;
/** Velocity damping. */
const DAMPING = 2.6;
const STEP = 1 / 60;
const MAX_XZ = 2.4;

const gridVert = /* glsl */ `
attribute vec3 aRest;
attribute float aBase;
varying vec2 vWorld;
varying float vDisp;
varying float vBase;
void main() {
  vec3 d = position - aRest;
  vDisp = length(d);
  vBase = aBase;
  vWorld = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const gridFrag = /* glsl */ `
${arenaGLSL}
uniform vec3 uColor;
uniform vec3 uColor2;
uniform float uTime;
uniform float uBeat;
uniform vec3 uPlayer; // x, z, intensity
uniform float uSweep;
uniform float uBoost;
varying vec2 vWorld;
varying float vDisp;
varying float vBase;
void main() {
  float edge = arenaDist(vWorld);
  if (edge < 0.0) discard;
  float r = length(vWorld);
  // synthwave scan ring sweeping outward from the centre
  float sweepR = uSweep;
  float sx = (r - sweepR) * 0.9;
  float sw = exp(-sx * sx) * 0.35;
  float pl = exp(-dot(vWorld - uPlayer.xy, vWorld - uPlayer.xy) * 0.035) * uPlayer.z;
  float wall = exp(-edge * 0.9) * 0.45;
  float disp = clamp(vDisp, 0.0, 3.0);
  float b = vBase * (0.28 + uBeat * 0.22 + uBoost) + sw * vBase + pl * 0.35 + wall * vBase;
  vec3 col = uColor * b;
  // displaced lines heat up: shift toward secondary then white, crossing the bloom threshold
  col += mix(uColor2, vec3(1.0), clamp(disp * 0.5, 0.0, 1.0)) * disp * 1.3;
  gl_FragColor = vec4(col, 1.0);
}
`;

const floorVert = /* glsl */ `
varying vec2 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const floorFrag = /* glsl */ `
${arenaGLSL}
uniform vec3 uColor;
uniform vec3 uColor2;
uniform vec3 uPlayer;
uniform float uBeat;
uniform float uTime;
varying vec2 vWorld;
void main() {
  float edge = arenaDist(vWorld);
  if (edge < 0.0) discard;
  float r = length(vWorld) / uSize;
  // dark glassy floor: faint centre tint + inner wall glow + light pool under the player
  vec3 col = uColor2 * 0.018 * (1.0 - r * 0.6);
  col += uColor * exp(-edge * 0.6) * 0.07;
  float pl = exp(-dot(vWorld - uPlayer.xy, vWorld - uPlayer.xy) * 0.05) * uPlayer.z;
  col += uColor * pl * 0.05;
  col *= 1.0 + uBeat * 0.4;
  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * Geometry-Wars style spring-mass grid. Nodes are simulated on the CPU (fixed 60 Hz substeps,
 * sleeps when settled), drawn as indexed LineSegments; brightness comes from displacement in the
 * shader. Clipping to the arena outline happens per-fragment, so arena shrink is free.
 */
export class Grid {
  readonly group = new THREE.Group();
  private lines?: THREE.LineSegments;
  private floor: THREE.Mesh;
  private geo?: THREE.BufferGeometry;
  private lineMat: THREE.ShaderMaterial;
  private floorMat: THREE.ShaderMaterial;
  private n = 0;
  private spacing = 1;
  private extent = 0;
  private coupling = 100;
  private restX = new Float32Array(0);
  private restZ = new Float32Array(0);
  private dx = new Float32Array(0);
  private dy = new Float32Array(0);
  private dz = new Float32Array(0);
  private vx = new Float32Array(0);
  private vy = new Float32Array(0);
  private vz = new Float32Array(0);
  private free = new Uint8Array(0);
  private pos!: THREE.BufferAttribute;
  private acc = 0;
  private awake = 0;
  private builtSize = 0;
  private sweepT = 0;

  constructor() {
    const shared = {
      uShape: { value: 0 },
      uSize: { value: 22 },
      uColor: { value: new THREE.Color() },
      uColor2: { value: new THREE.Color() },
      uTime: { value: 0 },
      uBeat: { value: 0 },
      uPlayer: { value: new THREE.Vector3(0, 0, 0) },
    };
    this.lineMat = new THREE.ShaderMaterial({
      uniforms: { ...shared, uSweep: { value: -100 }, uBoost: { value: 0 } },
      vertexShader: gridVert,
      fragmentShader: gridFrag,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.floorMat = new THREE.ShaderMaterial({
      uniforms: shared,
      vertexShader: floorVert,
      fragmentShader: floorFrag,
      depthWrite: false,
      toneMapped: false,
    });
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.floorMat);
    this.floor.position.y = -0.05;
    this.floor.renderOrder = -2;
    this.group.add(this.floor);
  }

  setColors(primary: number, secondary: number) {
    this.lineMat.uniforms.uColor.value.setHex(primary);
    this.lineMat.uniforms.uColor2.value.setHex(secondary);
  }

  build(arena: Arena, res: number) {
    this.disposeLines();
    const N = Math.max(8, res | 0);
    this.n = N;
    const E = arena.size + 0.6;
    this.extent = E;
    this.builtSize = arena.size;
    this.spacing = (2 * E) / (N - 1);
    this.coupling = (WAVE_SPEED / this.spacing) ** 2;
    const count = N * N;
    this.restX = new Float32Array(count);
    this.restZ = new Float32Array(count);
    this.dx = new Float32Array(count);
    this.dy = new Float32Array(count);
    this.dz = new Float32Array(count);
    this.vx = new Float32Array(count);
    this.vy = new Float32Array(count);
    this.vz = new Float32Array(count);
    this.free = new Uint8Array(count);
    const position = new Float32Array(count * 3);
    const base = new Float32Array(count);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const x = -E + i * this.spacing, z = -E + j * this.spacing;
        this.restX[k] = x;
        this.restZ[k] = z;
        position[k * 3] = x;
        position[k * 3 + 2] = z;
      }
    }
    // indices: only segments that touch the arena (others would be discarded anyway)
    const idx: number[] = [];
    const major = Math.max(2, Math.round(N / 11));
    const lineBright = (line: number) => (line % major === 0 ? 1.0 : 0.55);
    const near = (k: number) => arena.distanceToEdge(this.restX[k], this.restZ[k]) > -this.spacing * 1.5;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N - 1; i++) {
        const a = j * N + i, b = a + 1;
        if (near(a) || near(b)) idx.push(a, b);
      }
    }
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * N + i, b = a + N;
        if (near(a) || near(b)) idx.push(a, b);
      }
    }
    // per-vertex base brightness: max of its row/column brightness, so major lines read
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) base[j * N + i] = Math.max(lineBright(i), lineBright(j)) * 0.8;
    // Note: a vertex at a minor/major crossing gets major brightness on both lines; fine visually.
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(position, 3);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setAttribute('aRest', new THREE.BufferAttribute(position.slice(), 3));
    g.setAttribute('aBase', new THREE.BufferAttribute(base, 1));
    g.setIndex(idx);
    this.geo = g;
    this.lines = new THREE.LineSegments(g, this.lineMat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = -1;
    this.group.add(this.lines);
    this.refresh(arena);
  }

  /** Arena shape/size changed: update clip + anchors (cheap, no allocation). */
  refresh(arena: Arena) {
    if (arena.size > this.builtSize + 0.01 && this.n) {
      this.build(arena, this.n);
      return;
    }
    for (const m of [this.lineMat, this.floorMat]) {
      m.uniforms.uShape.value = shapeIndex(arena.shape);
      m.uniforms.uSize.value = arena.size;
    }
    const s = arena.size * 2 + 4;
    this.floor.scale.set(s, 1, s);
    const N = this.n;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const edge = i === 0 || j === 0 || i === N - 1 || j === N - 1;
        this.free[k] = !edge && arena.distanceToEdge(this.restX[k], this.restZ[k]) > 0 ? 1 : 0;
        if (!this.free[k]) {
          this.dx[k] = this.dy[k] = this.dz[k] = this.vx[k] = this.vy[k] = this.vz[k] = 0;
        }
      }
    }
    this.awake = 2;
  }

  /** Push nodes away from `x,z` (negative strength pulls inward). Also pushes down. */
  impulse(x: number, z: number, strength: number, radius: number) {
    if (!this.n) return;
    const N = this.n, s = this.spacing, E = this.extent;
    const i0 = Math.max(1, Math.floor((x - radius + E) / s));
    const i1 = Math.min(N - 2, Math.ceil((x + radius + E) / s));
    const j0 = Math.max(1, Math.floor((z - radius + E) / s));
    const j1 = Math.min(N - 2, Math.ceil((z + radius + E) / s));
    const r2 = radius * radius;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * N + i;
        if (!this.free[k]) continue;
        const ddx = this.restX[k] + this.dx[k] - x, ddz = this.restZ[k] + this.dz[k] - z;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 >= r2) continue;
        const d = Math.sqrt(d2) + 1e-4;
        const f = 1 - d / radius;
        const F = f * f * strength;
        this.vx[k] += (ddx / d) * F;
        this.vz[k] += (ddz / d) * F;
        this.vy[k] -= Math.abs(F) * 0.55;
      }
    }
    this.awake = 2;
  }

  /** Brief brightness swell of the whole grid (overdrive, boss). */
  sweep() {
    this.sweepT = 0;
  }

  update(dt: number, time: number, beat: number, px: number, pz: number, playerLight: number, boost: number) {
    const u = this.lineMat.uniforms;
    u.uTime.value = time;
    u.uBeat.value = beat;
    u.uPlayer.value.set(px, pz, playerLight);
    u.uBoost.value = boost;
    this.sweepT += dt;
    u.uSweep.value = this.sweepT * 22 - 2;
    if (!this.n || this.awake <= 0) return;
    this.acc = Math.min(this.acc + dt, STEP * 4);
    let steps = 0;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      this.step(STEP);
      steps++;
    }
    if (steps === 0) return;
    // upload
    const p = this.pos.array as Float32Array;
    const N2 = this.n * this.n;
    let energy = 0;
    for (let k = 0; k < N2; k++) {
      const o = k * 3;
      p[o] = this.restX[k] + this.dx[k];
      p[o + 1] = this.dy[k];
      p[o + 2] = this.restZ[k] + this.dz[k];
      energy += Math.abs(this.vx[k]) + Math.abs(this.vy[k]) + Math.abs(this.vz[k]) + Math.abs(this.dy[k]) + Math.abs(this.dx[k]) + Math.abs(this.dz[k]);
    }
    this.pos.needsUpdate = true;
    if (energy / N2 < 0.0004) {
      this.awake--;
      if (this.awake <= 0) {
        // snap exactly to rest and sleep
        for (let k = 0; k < N2; k++) {
          this.dx[k] = this.dy[k] = this.dz[k] = this.vx[k] = this.vy[k] = this.vz[k] = 0;
          const o = k * 3;
          p[o] = this.restX[k];
          p[o + 1] = 0;
          p[o + 2] = this.restZ[k];
        }
      }
    } else this.awake = 2;
  }

  private step(h: number) {
    const N = this.n, C = this.coupling;
    const { dx, dy, dz, vx, vy, vz, free } = this;
    const damp = Math.exp(-DAMPING * h);
    for (let j = 1; j < N - 1; j++) {
      let k = j * N + 1;
      for (let i = 1; i < N - 1; i++, k++) {
        if (!free[k]) continue;
        const l = k - 1, r = k + 1, u = k - N, d = k + N;
        const lx = dx[l] + dx[r] + dx[u] + dx[d] - 4 * dx[k];
        const ly = dy[l] + dy[r] + dy[u] + dy[d] - 4 * dy[k];
        const lz = dz[l] + dz[r] + dz[u] + dz[d] - 4 * dz[k];
        vx[k] = (vx[k] + (C * lx - ANCHOR_K * dx[k]) * h) * damp;
        vy[k] = (vy[k] + (C * ly - ANCHOR_K * dy[k]) * h) * damp;
        vz[k] = (vz[k] + (C * lz - ANCHOR_K * dz[k]) * h) * damp;
      }
    }
    const N2 = N * N;
    for (let k = 0; k < N2; k++) {
      if (!free[k]) continue;
      let x = dx[k] + vx[k] * h;
      let z = dz[k] + vz[k] * h;
      const m2 = x * x + z * z;
      if (m2 > MAX_XZ * MAX_XZ) {
        const s = MAX_XZ / Math.sqrt(m2);
        x *= s;
        z *= s;
        vx[k] *= 0.5;
        vz[k] *= 0.5;
      }
      dx[k] = x;
      dz[k] = z;
      dy[k] = Math.max(-3, Math.min(1.2, dy[k] + vy[k] * h));
    }
  }

  private disposeLines() {
    if (this.lines) {
      this.group.remove(this.lines);
      this.geo?.dispose();
      this.lines = undefined;
    }
  }

  dispose() {
    this.disposeLines();
    this.floor.geometry.dispose();
    this.lineMat.dispose();
    this.floorMat.dispose();
  }
}
