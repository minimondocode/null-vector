import * as THREE from 'three';

const deepVert = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const deepFrag = /* glsl */ `
uniform vec3 uBg;
uniform vec3 uColor;
uniform vec3 uColor2;
uniform float uTime;
uniform float uBeat;
varying vec3 vWorld;
float gridLine(vec2 p, float cell) {
  vec2 q = p / cell;
  vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
  return 1.0 - min(min(g.x, g.y), 1.0);
}
void main() {
  vec2 p = vWorld.xz + vec2(0.0, uTime * 1.2);
  float minor = gridLine(p, 4.0);
  float major = gridLine(p, 20.0);
  float dist = length(vWorld.xz - cameraPosition.xz);
  float fade = exp(-dist * 0.016);
  vec3 col = uBg;
  col += uColor2 * minor * 0.16 * fade;
  col += uColor * major * (0.3 + uBeat * 0.15) * fade;
  // faint nebula wash so the void isn't flat
  float neb = sin(vWorld.x * 0.035 + uTime * 0.05) * sin(vWorld.z * 0.03 - uTime * 0.04);
  col += uColor2 * (0.012 + 0.012 * neb) * fade;
  gl_FragColor = vec4(col, 1.0);
}
`;

const moteVert = /* glsl */ `
uniform float uTime;
uniform float uScale;
attribute vec4 aSeed;
varying float vAlpha;
varying float vMix;
void main() {
  float sp = 0.25 + aSeed.w * 0.6;
  float y = mod(aSeed.y + uTime * sp, 16.0) - 1.0;
  vec3 p = vec3(aSeed.x + sin(uTime * 0.21 + aSeed.w * 40.0) * 1.2, y, aSeed.z + cos(uTime * 0.17 + aSeed.w * 23.0) * 1.2);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uScale * (0.12 + aSeed.w * 0.16) / -mv.z;
  float tw = 0.55 + 0.45 * sin(uTime * (1.5 + aSeed.w * 3.0) + aSeed.w * 90.0);
  vAlpha = tw * smoothstep(-1.0, 1.5, y) * (1.0 - smoothstep(11.0, 15.0, y));
  vMix = fract(aSeed.w * 7.31);
}
`;

const moteFrag = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uColor2;
varying float vAlpha;
varying float vMix;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  if (d > 1.0) discard;
  float a = (1.0 - d);
  a = a * a * vAlpha;
  gl_FragColor = vec4(mix(uColor, uColor2, vMix) * a * 1.4, 1.0);
}
`;

const streamVert = /* glsl */ `
attribute vec2 aS; // t (0 bottom..1 top), seed
varying vec2 vS;
void main() {
  vS = aS;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const streamFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
varying vec2 vS;
void main() {
  float seed = vS.y;
  float y = vS.x * 16.0;
  float f = fract(y * 0.07 + uTime * (0.25 + seed * 0.5) + seed * 9.0);
  float head = pow(f, 18.0) * 2.2 + pow(f, 4.0) * 0.25;
  float fade = smoothstep(0.0, 0.15, vS.x) * (1.0 - smoothstep(0.7, 1.0, vS.x));
  gl_FragColor = vec4(uColor * head * fade, 1.0);
}
`;

/**
 * Deep-space backdrop: a vast scrolling grid far below the arena, drifting motes and rising data
 * streams around the arena perimeter. All animation is in shaders (no per-frame CPU work).
 */
export class Background {
  readonly group = new THREE.Group();
  private deepMat: THREE.ShaderMaterial;
  private moteMat: THREE.ShaderMaterial;
  private streamMat: THREE.ShaderMaterial;
  private deep: THREE.Mesh;
  private motes?: THREE.Points;
  private streams?: THREE.LineSegments;

  constructor() {
    this.deepMat = new THREE.ShaderMaterial({
      uniforms: {
        uBg: { value: new THREE.Color() },
        uColor: { value: new THREE.Color() },
        uColor2: { value: new THREE.Color() },
        uTime: { value: 0 },
        uBeat: { value: 0 },
      },
      vertexShader: deepVert,
      fragmentShader: deepFrag,
      depthWrite: false,
      toneMapped: false,
    });
    this.deep = new THREE.Mesh(new THREE.PlaneGeometry(500, 500).rotateX(-Math.PI / 2), this.deepMat);
    this.deep.position.y = -10;
    // opaque & drawn first: the arena floor (also opaque, later) paints over it
    this.deep.renderOrder = -10;
    this.deep.frustumCulled = false;
    this.group.add(this.deep);

    this.moteMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uScale: { value: 500 }, uColor: { value: new THREE.Color() }, uColor2: { value: new THREE.Color() } },
      vertexShader: moteVert,
      fragmentShader: moteFrag,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.streamMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color() } },
      vertexShader: streamVert,
      fragmentShader: streamFrag,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
  }

  setTheme(bg: number, primary: number, secondary: number) {
    this.deepMat.uniforms.uBg.value.setHex(bg);
    this.deepMat.uniforms.uColor.value.setHex(primary).multiplyScalar(0.6);
    this.deepMat.uniforms.uColor2.value.setHex(secondary);
    this.moteMat.uniforms.uColor.value.setHex(primary);
    this.moteMat.uniforms.uColor2.value.setHex(secondary);
    this.streamMat.uniforms.uColor.value.setHex(primary);
  }

  /** (Re)build motes/streams for the given counts, outside `innerR`. */
  build(innerR: number, motes: number, streams: number) {
    this.disposeDyn();
    {
      const seed = new Float32Array(motes * 4);
      for (let i = 0; i < motes; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = innerR + 3 + Math.pow(Math.random(), 0.7) * 55;
        seed[i * 4] = Math.cos(a) * r;
        seed[i * 4 + 1] = Math.random() * 16;
        seed[i * 4 + 2] = Math.sin(a) * r;
        seed[i * 4 + 3] = Math.random();
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(motes * 3), 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
      this.motes = new THREE.Points(g, this.moteMat);
      this.motes.frustumCulled = false;
      this.motes.renderOrder = 2;
      this.group.add(this.motes);
    }
    {
      const pos = new Float32Array(streams * 6);
      const s = new Float32Array(streams * 4);
      for (let i = 0; i < streams; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = innerR + 6 + Math.random() * 50;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        const h0 = -1, h1 = 10 + Math.random() * 10;
        pos.set([x, h0, z, x, h1, z], i * 6);
        const sd = Math.random();
        s.set([0, sd, 1, sd], i * 4);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aS', new THREE.BufferAttribute(s, 2));
      this.streams = new THREE.LineSegments(g, this.streamMat);
      this.streams.frustumCulled = false;
      this.streams.renderOrder = 2;
      this.group.add(this.streams);
    }
  }

  /** Pixel scale for point sizes: drawingBufferHeight / (2 tan(fov/2)). */
  setScale(px: number) {
    this.moteMat.uniforms.uScale.value = px;
  }

  update(time: number, beat: number) {
    this.deepMat.uniforms.uTime.value = time;
    this.deepMat.uniforms.uBeat.value = beat;
    this.moteMat.uniforms.uTime.value = time;
    this.streamMat.uniforms.uTime.value = time;
  }

  private disposeDyn() {
    if (this.motes) {
      this.group.remove(this.motes);
      this.motes.geometry.dispose();
      this.motes = undefined;
    }
    if (this.streams) {
      this.group.remove(this.streams);
      this.streams.geometry.dispose();
      this.streams = undefined;
    }
  }

  dispose() {
    this.disposeDyn();
    this.deep.geometry.dispose();
    this.deepMat.dispose();
    this.moteMat.dispose();
    this.streamMat.dispose();
  }
}
