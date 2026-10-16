import * as THREE from 'three';

const STRIDE = 10; // x, y, z, radius, start | r, g, b, duration, thickness
const MAX = 64;

const vert = /* glsl */ `
uniform float uTime;
attribute vec4 aA; // x y z radius
attribute float aStart;
attribute vec4 aB; // rgb duration
attribute float aThick;
varying vec2 vLocal;
varying float vR;
varying float vP;
varying float vW;
varying vec3 vColor;
void main() {
  float p = (uTime - aStart) / max(aB.w, 1e-4);
  if (p < 0.0 || p >= 1.0 || aB.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float e = 1.0 - pow(1.0 - p, 3.0);
  float r = max(0.05, aA.w * e);
  float w = aThick * (1.0 - 0.6 * p) + 0.04;
  float ext = r + w * 3.0;
  vec3 wp = vec3(aA.x + position.x * ext, aA.y, aA.z + position.y * ext);
  vLocal = position.xy * ext;
  vR = r;
  vP = p;
  vW = w;
  vColor = aB.rgb;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const frag = /* glsl */ `
varying vec2 vLocal;
varying float vR;
varying float vP;
varying float vW;
varying vec3 vColor;
void main() {
  float d = length(vLocal);
  float x = (d - vR) / vW;
  float band = exp(-x * x * 2.5);
  // brighter leading edge, soft trailing wash inside
  float wash = smoothstep(0.0, vR, d) * step(d, vR) * 0.18;
  float fade = (1.0 - vP);
  fade *= fade;
  float a = (band * 1.4 + wash) * fade;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor * a + vec3(band * band * fade * 0.6), 1.0);
}
`;

/** Pooled expanding shockwave rings on the floor plane (single instanced draw). */
export class Rings {
  readonly mesh: THREE.Mesh;
  private data = new Float32Array(MAX * STRIDE);
  private buf: THREE.InstancedInterleavedBuffer;
  private geo: THREE.InstancedBufferGeometry;
  private material: THREE.ShaderMaterial;
  private head = 0;
  private dirty = false;
  time = 0;

  constructor() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 2, 1, 0, 3, 2]);
    this.buf = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aA', new THREE.InterleavedBufferAttribute(this.buf, 4, 0));
    g.setAttribute('aStart', new THREE.InterleavedBufferAttribute(this.buf, 1, 4));
    g.setAttribute('aB', new THREE.InterleavedBufferAttribute(this.buf, 4, 5));
    g.setAttribute('aThick', new THREE.InterleavedBufferAttribute(this.buf, 1, 9));
    g.instanceCount = MAX;
    this.geo = g;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: vert,
      fragmentShader: frag,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  emit(x: number, y: number, z: number, radius: number, r: number, g: number, b: number, duration: number, thickness = 0.35) {
    const o = this.head * STRIDE;
    const d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = radius; d[o + 4] = this.time;
    d[o + 5] = r; d[o + 6] = g; d[o + 7] = b; d[o + 8] = duration; d[o + 9] = thickness;
    this.head = (this.head + 1) % MAX;
    this.dirty = true;
  }

  update(dt: number) {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
    if (this.dirty) {
      this.buf.needsUpdate = true;
      this.dirty = false;
    }
  }

  clear() {
    this.data.fill(0);
    this.buf.needsUpdate = true;
  }

  dispose() {
    this.geo.dispose();
    this.material.dispose();
  }
}
