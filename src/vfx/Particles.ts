import * as THREE from 'three';

export const SHAPE_GLOW = 0;
export const SHAPE_SPARK = 1;
export const SHAPE_SHARD = 2;

const STRIDE = 18; // p0(3) v0(3) t(4: start, life, size, drag) c(4: rgb, stretch) m(4: gravity, shape, spin, seed)

const vert = /* glsl */ `
uniform float uTime;
attribute vec3 aP0;
attribute vec3 aV0;
attribute vec4 aT;
attribute vec4 aC;
attribute vec4 aM;
varying vec2 vUv;
varying vec3 vColor;
varying float vShape;
varying float vAlong;
void main() {
  float age = uTime - aT.x;
  float life = aT.y;
  float t = age / max(life, 1e-4);
  if (age < 0.0 || t >= 1.0 || life <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float k = aT.w;
  float e = exp(-k * age);
  float integ = k > 0.001 ? (1.0 - e) / k : age;
  vec3 p = aP0 + aV0 * integ;
  p.y -= 0.5 * aM.x * age * age;
  vec3 v = aV0 * e;
  v.y -= aM.x * age;
  if (p.y < 0.04) { p.y = 0.04; v.y = 0.0; }
  float shape = aM.y;
  vShape = shape;

  float size = aT.z;
  if (shape < 0.5) size *= (1.0 - t * t) * (0.6 + 0.4 * smoothstep(0.0, 0.08, t));
  else if (shape < 1.5) size *= 1.0 - t * 0.7;
  else size *= 1.0 - smoothstep(0.6, 1.0, t);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 vv = mat3(modelViewMatrix) * v;
  vec2 axis = vec2(1.0, 0.0);
  float L = 0.0;
  if (shape > 0.5 && shape < 1.5) {
    float sp = length(vv.xy);
    if (sp > 1e-4) axis = vv.xy / sp;
    L = sp * aC.w;
  } else if (shape > 1.5) {
    float a = aM.z * age + aM.w * 6.2831;
    axis = vec2(cos(a), sin(a));
  }
  vec2 perp = vec2(-axis.y, axis.x);
  float along = size + L * 0.5;
  mv.xy += axis * (position.x * along - L * 0.5) + perp * position.y * size;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy;
  vAlong = along / max(size, 1e-4);

  float fade = 1.0 - t;
  fade *= fade;
  float hot = pow(1.0 - t, 6.0);
  vColor = (aC.rgb + vec3(hot * 1.6)) * fade;
}
`;

const frag = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
varying float vShape;
varying float vAlong;
void main() {
  float a;
  if (vShape < 0.5) {
    float d = length(vUv);
    if (d > 1.0) discard;
    float s = 1.0 - d;
    a = s * s * 0.7 + exp(-d * d * 18.0) * 0.8;
  } else if (vShape < 1.5) {
    // capsule-ish streak, brighter core
    float d = length(vec2(vUv.x, vUv.y));
    float across = abs(vUv.y);
    if (d > 1.0) discard;
    a = (1.0 - d) * (1.0 - across) * 1.8;
  } else {
    float d = abs(vUv.x) + abs(vUv.y) * 1.7;
    if (d > 1.0) discard;
    a = 0.55 + 0.9 * smoothstep(0.75, 0.95, d);
  }
  gl_FragColor = vec4(vColor * a, 1.0);
}
`;

/**
 * Pooled GPU particle system: one instanced quad draw. Motion is analytic in the vertex shader
 * (velocity with exponential drag + gravity), so the CPU only writes on spawn (ring buffer,
 * partial buffer uploads). Sparks are stretched along screen-space velocity.
 */
export class Particles {
  readonly mesh: THREE.Mesh;
  private geo!: THREE.InstancedBufferGeometry;
  private buf!: THREE.InstancedInterleavedBuffer;
  private data!: Float32Array;
  private material: THREE.ShaderMaterial;
  private capacity = 0;
  private head = 0;
  private highWater = 0;
  private dirtyMin = Infinity;
  private dirtyMax = -1;
  private wrapped = false;
  time = 0;

  constructor(capacity: number) {
    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: vert,
      fragmentShader: frag,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      transparent: true,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.setCapacity(capacity);
  }

  setCapacity(n: number) {
    if (n === this.capacity) return;
    this.geo?.dispose();
    this.capacity = n;
    this.data = new Float32Array(n * STRIDE);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.buf = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aP0', new THREE.InterleavedBufferAttribute(this.buf, 3, 0));
    g.setAttribute('aV0', new THREE.InterleavedBufferAttribute(this.buf, 3, 3));
    g.setAttribute('aT', new THREE.InterleavedBufferAttribute(this.buf, 4, 6));
    g.setAttribute('aC', new THREE.InterleavedBufferAttribute(this.buf, 4, 10));
    g.setAttribute('aM', new THREE.InterleavedBufferAttribute(this.buf, 4, 14));
    g.instanceCount = 0;
    this.geo = g;
    this.mesh.geometry = g;
    this.head = 0;
    this.highWater = 0;
    this.dirtyMin = Infinity;
    this.dirtyMax = -1;
    this.wrapped = false;
  }

  /** Spawn one particle. Colour is linear and may exceed 1 (bloom). */
  emit(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, size: number, drag: number,
    r: number, g: number, b: number,
    shape = SHAPE_GLOW, stretch = 0, gravity = 0, spin = 0,
  ) {
    const i = this.head;
    const o = i * STRIDE;
    const d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z;
    d[o + 3] = vx; d[o + 4] = vy; d[o + 5] = vz;
    d[o + 6] = this.time; d[o + 7] = life; d[o + 8] = size; d[o + 9] = drag;
    d[o + 10] = r; d[o + 11] = g; d[o + 12] = b; d[o + 13] = stretch;
    d[o + 14] = gravity; d[o + 15] = shape; d[o + 16] = spin; d[o + 17] = Math.random();
    if (i < this.dirtyMin) this.dirtyMin = i;
    if (i > this.dirtyMax) this.dirtyMax = i;
    this.head++;
    if (this.head >= this.capacity) {
      this.head = 0;
      this.wrapped = true;
    }
    if (this.head > this.highWater) this.highWater = this.head;
    if (this.wrapped) this.highWater = this.capacity;
  }

  update(worldDt: number) {
    this.time += worldDt;
    this.material.uniforms.uTime.value = this.time;
    if (this.dirtyMax >= 0) {
      this.buf.clearUpdateRanges();
      this.buf.addUpdateRange(this.dirtyMin * STRIDE, (this.dirtyMax - this.dirtyMin + 1) * STRIDE);
      this.buf.needsUpdate = true;
      this.dirtyMin = Infinity;
      this.dirtyMax = -1;
    }
    this.geo.instanceCount = this.highWater;
  }

  /** Kill everything (theme change / run restart). */
  clear() {
    this.data.fill(0);
    this.buf.clearUpdateRanges();
    this.buf.needsUpdate = true;
    this.head = 0;
    this.highWater = 0;
    this.wrapped = false;
    this.dirtyMin = Infinity;
    this.dirtyMax = -1;
  }

  dispose() {
    this.geo.dispose();
    this.material.dispose();
  }
}
