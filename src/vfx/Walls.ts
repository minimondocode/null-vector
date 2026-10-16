import * as THREE from 'three';
import type { Arena } from '../game/Arena';
import type { ArenaShape } from '../game/config';

const WALL_H = 2.6;
const HITS = 8;

const curtainVert = /* glsl */ `
attribute float aU;
attribute float aH;
varying float vU;
varying float vH;
varying vec3 vWorld;
void main() {
  vU = aU;
  vH = aH;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const curtainFrag = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uColor2;
uniform float uTime;
uniform float uPerim;
uniform float uBeat;
uniform float uFlash;
uniform vec3 uPlayer;
uniform vec4 uHits[${HITS}];
varying float vU;
varying float vH;
varying vec3 vWorld;
void main() {
  float along = vU * uPerim;
  float h = vH;
  float grad = pow(clamp(1.0 - h, 0.0, 1.0), 2.4);
  // energy pulses racing along the wall in both directions
  float p1 = pow(0.5 + 0.5 * sin(along * 0.35 - uTime * 4.0), 14.0);
  float p2 = pow(0.5 + 0.5 * sin(along * 0.21 + uTime * 2.3 + 1.7), 20.0);
  // vertical data stripes + rising scanlines
  float stripes = smoothstep(0.9, 1.0, fract(along * 1.25)) * 0.25;
  float scan = smoothstep(0.8, 1.0, fract(h * 6.0 - uTime * 0.6)) * 0.18;
  float top = smoothstep(0.93, 1.0, h) * 0.5;
  float hits = 0.0;
  for (int i = 0; i < ${HITS}; i++) {
    vec4 hv = uHits[i];
    float age = uTime - hv.z;
    if (age < 0.0 || age > 1.0) continue;
    vec2 d = vWorld.xz - hv.xy;
    float ring = abs(length(d) - age * 6.0);
    hits += hv.w * exp(-dot(d, d) * 0.6) * exp(-age * 7.0) * 3.0;
    hits += hv.w * exp(-ring * ring * 4.0) * exp(-age * 5.0) * (1.0 - h);
  }
  vec2 pd = vWorld.xz - uPlayer.xy;
  float prox = exp(-dot(pd, pd) * 0.04) * 0.8;
  float energy = (p1 * 1.6 + p2 * 1.1) * (0.4 + grad);
  // walls between the camera and the action are dimmed so they never wash over ships
  vec2 nrm = normalize(vWorld.xz + vec2(1e-4));
  vec2 toCam = normalize(cameraPosition.xz - vWorld.xz + vec2(1e-4));
  float front = smoothstep(0.1, 0.7, dot(nrm, toCam));
  float b = grad * (0.35 + uBeat * 0.25 + uFlash) + energy * 0.9 + (stripes + scan) * grad + top + prox * grad + hits;
  b *= mix(0.55, 0.2, front);
  vec3 col = mix(uColor, uColor2, h * 0.7) * b;
  col += vec3(1.0) * hits * 0.4 * grad;
  gl_FragColor = vec4(col, 1.0);
}
`;

interface Pillar {
  group: THREE.Group;
  gem: THREE.Object3D;
  phase: number;
}

/**
 * Neon arena boundary: floor ribbon (crisp >1 colour), additive light curtain with scrolling
 * energy, top rail, and decorative corner pylons. Geometry is rebuilt only when the shape
 * changes; size changes rewrite positions in place (ROOT's shrinking arena).
 */
export class Walls {
  readonly group = new THREE.Group();
  private shape: ArenaShape | null = null;
  private unit: THREE.Vector2[] = [];
  private apothemK = 1;
  private curtainGeo?: THREE.BufferGeometry;
  private ribbonGeo?: THREE.BufferGeometry;
  private railGeo?: THREE.BufferGeometry;
  private curtainMat: THREE.ShaderMaterial;
  private ribbonMat: THREE.MeshBasicMaterial;
  private railMat: THREE.LineBasicMaterial;
  private pillarEdgeMat: THREE.LineBasicMaterial;
  private gemMat: THREE.MeshBasicMaterial;
  private beamMat: THREE.MeshBasicMaterial;
  private pillarGeo: THREE.BufferGeometry;
  private gemGeo: THREE.BufferGeometry;
  private beamGeo: THREE.BufferGeometry;
  private pillars: Pillar[] = [];
  private hitIdx = 0;
  private flash = 0;
  private colorA = new THREE.Color();

  constructor() {
    const hits: THREE.Vector4[] = [];
    for (let i = 0; i < HITS; i++) hits.push(new THREE.Vector4(0, 0, -10, 0));
    this.curtainMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color() },
        uColor2: { value: new THREE.Color() },
        uTime: { value: 0 },
        uPerim: { value: 100 },
        uBeat: { value: 0 },
        uFlash: { value: 0 },
        uPlayer: { value: new THREE.Vector3() },
        uHits: { value: hits },
      },
      vertexShader: curtainVert,
      fragmentShader: curtainFrag,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.ribbonMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, side: THREE.DoubleSide, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending });
    this.railMat = new THREE.LineBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.pillarEdgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.gemMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, toneMapped: false });
    this.beamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const box = new THREE.BoxGeometry(0.55, WALL_H * 1.35, 0.55);
    box.translate(0, (WALL_H * 1.35) / 2, 0);
    this.pillarGeo = new THREE.EdgesGeometry(box);
    box.dispose();
    this.gemGeo = new THREE.OctahedronGeometry(0.42, 0);
    // vertical light beam: a tall thin cylinder fading via vertex colours is overkill; use an open cone
    this.beamGeo = new THREE.CylinderGeometry(0.05, 0.28, 14, 8, 1, true);
    this.beamGeo.translate(0, 7 + WALL_H * 1.35, 0);
  }

  setColors(primary: number, secondary: number) {
    const u = this.curtainMat.uniforms;
    u.uColor.value.setHex(primary);
    u.uColor2.value.setHex(secondary);
    this.colorA.setHex(primary);
    this.ribbonMat.color.copy(this.colorA).multiplyScalar(2.4);
    this.railMat.color.copy(this.colorA).multiplyScalar(1.6);
    this.pillarEdgeMat.color.setHex(secondary).multiplyScalar(2.6);
    this.gemMat.color.copy(this.colorA).multiplyScalar(3);
    this.beamMat.color.setHex(secondary).multiplyScalar(0.12);
  }

  layout(arena: Arena) {
    if (arena.shape !== this.shape) this.build(arena);
    const s = arena.size;
    const a = s * this.apothemK; // apothem
    const n = this.unit.length;
    const cp = this.curtainGeo!.attributes.position.array as Float32Array;
    const rp = this.ribbonGeo!.attributes.position.array as Float32Array;
    const lp = this.railGeo!.attributes.position.array as Float32Array;
    const kIn = s * (1 - 0.22 / a), kOut = s * (1 + 0.1 / a);
    for (let i = 0; i <= n; i++) {
      const u = this.unit[i % n];
      const o = i * 6;
      cp[o] = u.x * s; cp[o + 1] = 0; cp[o + 2] = u.y * s;
      cp[o + 3] = u.x * s; cp[o + 4] = WALL_H; cp[o + 5] = u.y * s;
      rp[o] = u.x * kIn; rp[o + 1] = 0.03; rp[o + 2] = u.y * kIn;
      rp[o + 3] = u.x * kOut; rp[o + 4] = 0.03; rp[o + 5] = u.y * kOut;
      const l = i * 3;
      lp[l] = u.x * s; lp[l + 1] = WALL_H; lp[l + 2] = u.y * s;
    }
    this.curtainGeo!.attributes.position.needsUpdate = true;
    this.ribbonGeo!.attributes.position.needsUpdate = true;
    this.railGeo!.attributes.position.needsUpdate = true;
    this.curtainGeo!.computeBoundingSphere();
    this.ribbonGeo!.computeBoundingSphere();
    this.railGeo!.computeBoundingSphere();
    // perimeter
    let per = 0;
    for (let i = 0; i < n; i++) per += this.unit[i].distanceTo(this.unit[(i + 1) % n]);
    this.curtainMat.uniforms.uPerim.value = per * s;
    // pillars
    const pn = this.pillars.length;
    for (let i = 0; i < pn; i++) {
      const p = this.pillars[i];
      let x: number, z: number;
      if (arena.shape === 'circle') {
        const ang = (i / pn) * Math.PI * 2 + Math.PI / pn;
        x = Math.cos(ang) * (s + 0.5);
        z = Math.sin(ang) * (s + 0.5);
      } else {
        const u = this.unit[i];
        const k = s + 0.5 / this.apothemK;
        x = u.x * k;
        z = u.y * k;
      }
      p.group.position.set(x, 0, z);
    }
  }

  private build(arena: Arena) {
    this.disposeGeo();
    this.shape = arena.shape;
    const pts = arena.outline(96);
    this.unit = pts.map((p) => p.clone().divideScalar(arena.size));
    const n = this.unit.length;
    this.apothemK = arena.shape === 'square' ? 1 : arena.shape === 'hex' ? Math.cos(Math.PI / 6) : 1;
    // cumulative unit-perimeter param
    const us: number[] = [0];
    let per = 0;
    for (let i = 0; i < n; i++) {
      per += this.unit[i].distanceTo(this.unit[(i + 1) % n]);
      us.push(per);
    }
    const verts = (n + 1) * 2;
    const aU = new Float32Array(verts);
    const aH = new Float32Array(verts);
    const idx: number[] = [];
    for (let i = 0; i <= n; i++) {
      aU[i * 2] = aU[i * 2 + 1] = us[i] / per;
      aH[i * 2] = 0;
      aH[i * 2 + 1] = 1;
      if (i < n) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx.push(a, c, b, b, c, d);
      }
    }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    cg.setAttribute('aU', new THREE.BufferAttribute(aU, 1));
    cg.setAttribute('aH', new THREE.BufferAttribute(aH, 1));
    cg.setIndex(idx);
    this.curtainGeo = cg;
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    rg.setIndex(idx);
    this.ribbonGeo = rg;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array((n + 1) * 3), 3));
    this.railGeo = lg;

    const curtain = new THREE.Mesh(cg, this.curtainMat);
    curtain.renderOrder = 8;
    const ribbon = new THREE.Mesh(rg, this.ribbonMat);
    ribbon.renderOrder = 1;
    const rail = new THREE.Line(lg, this.railMat);
    this.group.add(curtain, ribbon, rail);

    const count = arena.shape === 'circle' ? 12 : n;
    for (let i = 0; i < count; i++) {
      const g = new THREE.Group();
      const edges = new THREE.LineSegments(this.pillarGeo, this.pillarEdgeMat);
      const gem = new THREE.Mesh(this.gemGeo, this.gemMat);
      gem.position.y = WALL_H * 1.35 + 0.7;
      const beam = new THREE.Mesh(this.beamGeo, this.beamMat);
      g.add(edges, gem, beam);
      this.group.add(g);
      this.pillars.push({ group: g, gem, phase: i * 1.3 });
    }
  }

  /** Light up the wall near a bullet impact. */
  hit(x: number, z: number, time: number, intensity: number) {
    const v = this.curtainMat.uniforms.uHits.value[this.hitIdx] as THREE.Vector4;
    v.set(x, z, time, intensity);
    this.hitIdx = (this.hitIdx + 1) % HITS;
  }

  pulse(amount: number) {
    this.flash = Math.max(this.flash, amount);
  }

  update(dt: number, time: number, beat: number, px: number, pz: number) {
    const u = this.curtainMat.uniforms;
    u.uTime.value = time;
    u.uBeat.value = beat;
    u.uPlayer.value.set(px, pz, 0);
    this.flash = Math.max(0, this.flash - dt * 2.5);
    u.uFlash.value = this.flash;
    this.railMat.opacity = 0.7 + beat * 0.3;
    for (const p of this.pillars) {
      p.gem.rotation.y = time * 1.4 + p.phase;
      p.gem.rotation.x = time * 0.7;
      p.gem.position.y = WALL_H * 1.35 + 0.7 + Math.sin(time * 2 + p.phase) * 0.15;
      p.gem.scale.setScalar(1 + beat * 0.25);
    }
  }

  private disposeGeo() {
    for (const o of [...this.group.children]) this.group.remove(o);
    this.pillars.length = 0;
    this.curtainGeo?.dispose();
    this.ribbonGeo?.dispose();
    this.railGeo?.dispose();
  }

  dispose() {
    this.disposeGeo();
    this.curtainMat.dispose();
    this.ribbonMat.dispose();
    this.railMat.dispose();
    this.pillarEdgeMat.dispose();
    this.gemMat.dispose();
    this.beamMat.dispose();
    this.pillarGeo.dispose();
    this.gemGeo.dispose();
    this.beamGeo.dispose();
  }
}
