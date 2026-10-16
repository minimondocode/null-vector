import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import type { QualityPreset } from './Quality';

/**
 * UnrealBloom with (a) a render-scale knob and (b) a max-channel soft-knee high pass instead of
 * luminance, so saturated neon (pure blue/red ×3) glows as strongly as cyan, while anything ≤ ~1
 * stays crisp and un-bloomed.
 */
class NeonBloomPass extends UnrealBloomPass {
  scale = 0.5;
  constructor(strength: number, radius: number, threshold: number) {
    super(new THREE.Vector2(256, 256), strength, radius, threshold);
    const m = this.materialHighPassFilter;
    m.fragmentShader = /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform float luminosityThreshold;
      uniform float smoothWidth;
      varying vec2 vUv;
      void main() {
        vec3 c = clamp(texture2D(tDiffuse, vUv).rgb, 0.0, 16.0);
        float m = max(max(c.r, c.g), c.b);
        float knee = smoothWidth;
        float soft = clamp(m - luminosityThreshold + knee, 0.0, 2.0 * knee);
        soft = soft * soft / (4.0 * knee + 1e-5);
        float contrib = max(soft, m - luminosityThreshold) / max(m, 1e-4);
        gl_FragColor = vec4(c * contrib, 1.0);
      }
    `;
    m.needsUpdate = true;
    (this.highPassUniforms as any).smoothWidth.value = 0.35;
  }
  override setSize(width: number, height: number) {
    super.setSize(Math.max(2, Math.round(width * this.scale)), Math.max(2, Math.round(height * this.scale)));
  }
}

const finalVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const finalFrag = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uRes;
uniform float uTime;
uniform float uChroma;
uniform vec3 uFlashColor;
uniform float uFlash;
uniform float uOverdrive;
uniform float uDamage;
uniform float uHeart;
uniform float uInvert;
uniform float uVignette;
uniform float uGrain;
uniform float uScan;
uniform vec4 uShock;      // center.xy (uv), radius (uv units, aspect-corrected), strength
uniform vec4 uShock2;
uniform float uBlur;
uniform vec2 uBlurCenter;
uniform float uBarrel;
uniform float uExposure;
varying vec2 vUv;

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

vec3 toSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

vec2 shockOffset(vec2 uv, vec4 s, vec2 aspect) {
  if (s.w <= 0.0) return vec2(0.0);
  vec2 d = (uv - s.xy) * aspect;
  float dist = length(d);
  float x = (dist - s.z) / 0.05;
  float off = exp(-x * x) * x * s.w;
  return (d / max(dist, 1e-4)) / aspect * off * 0.025;
}

vec3 sampleCA(vec2 uv, vec2 dir) {
  vec3 c;
  c.r = texture2D(tDiffuse, uv + dir).r;
  c.g = texture2D(tDiffuse, uv).g;
  c.b = texture2D(tDiffuse, uv - dir).b;
  return c;
}

void main() {
  vec2 aspect = vec2(uRes.x / uRes.y, 1.0);
  vec2 c0 = vUv - 0.5;
  vec2 uv = 0.5 + c0 * (1.0 - uBarrel * dot(c0, c0));
#ifdef SHOCKWAVE
  uv -= shockOffset(uv, uShock, aspect);
  uv -= shockOffset(uv, uShock2, aspect);
#endif
  vec2 cc = uv - 0.5;
  vec2 caDir = cc * uChroma * (0.25 + dot(cc, cc) * 2.5) * 0.02;
  vec3 col;
#if RADIAL_TAPS > 0
  if (uBlur > 0.0005) {
    vec2 bd = (uv - uBlurCenter) * uBlur / float(RADIAL_TAPS);
    col = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < RADIAL_TAPS; i++) {
      float w = 1.0 - float(i) / float(RADIAL_TAPS) * 0.6;
      col += sampleCA(uv - bd * float(i), caDir) * w;
      wsum += w;
    }
    col /= wsum;
  } else {
    col = sampleCA(uv, caDir);
  }
#else
  col = sampleCA(uv, caDir);
#endif
  col *= uExposure;

  // hue-preserving shoulder: overflow bleeds to white-hot instead of clipping channels
  float m = max(max(col.r, col.g), col.b);
  if (m > 1.0) col = col / m + vec3(min((m - 1.0) * 0.16, 0.55));

  // overdrive grade: desaturate toward cold teal
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(lum) * vec3(0.55, 1.0, 1.2) + vec3(0.0, 0.015, 0.03), uOverdrive * 0.7);

  col += uFlashColor * uFlash;

  // damage / low-HP vignette
  vec2 vc = c0 * aspect * 0.9;
  float edge = smoothstep(0.25, 0.95, length(vc));
  float hurt = clamp(uDamage + uHeart, 0.0, 1.0);
  col = mix(col, vec3(0.75, 0.0, 0.06), edge * hurt * 0.75);

  // standard vignette (stronger in overdrive)
  float vig = smoothstep(0.45, 1.15, length(c0 * vec2(1.1, 1.0)) * 1.3);
  col *= 1.0 - vig * (uVignette + uOverdrive * 0.25);

  col = mix(col, vec3(1.0) - clamp(col, 0.0, 1.0), uInvert);

  vec3 outc = toSRGB(col);
#ifdef GRAIN
  float g = hash12(gl_FragCoord.xy + fract(uTime * 13.7) * 311.0) - 0.5;
  outc += g * uGrain;
  float sl = 0.5 + 0.5 * sin(gl_FragCoord.y * 1.5708);
  outc *= 1.0 - uScan * sl;
#endif
  gl_FragColor = vec4(outc, 1.0);
}
`;

export interface PostUniforms {
  uRes: { value: THREE.Vector2 };
  uTime: { value: number };
  uChroma: { value: number };
  uFlashColor: { value: THREE.Color };
  uFlash: { value: number };
  uOverdrive: { value: number };
  uDamage: { value: number };
  uHeart: { value: number };
  uInvert: { value: number };
  uVignette: { value: number };
  uGrain: { value: number };
  uScan: { value: number };
  uShock: { value: THREE.Vector4 };
  uShock2: { value: THREE.Vector4 };
  uBlur: { value: number };
  uBlurCenter: { value: THREE.Vector2 };
  uBarrel: { value: number };
  uExposure: { value: number };
}

/** EffectComposer chain: scene → neon bloom → final grade/distortion → FXAA. */
export class PostFX {
  readonly composer: EffectComposer;
  readonly u: PostUniforms;
  private bloom: NeonBloomPass;
  private final: ShaderPass;
  private fxaa: FXAAPass;
  private width = innerWidth;
  private height = innerHeight;
  private pixelRatio = 1;
  /** Base bloom strength from the preset (VFX adds transient boosts). */
  bloomBase = 0.9;

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new NeonBloomPass(0.9, 0.4, 0.85);
    this.composer.addPass(this.bloom);
    this.final = new ShaderPass(
      new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: null },
          uRes: { value: new THREE.Vector2(1, 1) },
          uTime: { value: 0 },
          uChroma: { value: 0 },
          uFlashColor: { value: new THREE.Color(1, 1, 1) },
          uFlash: { value: 0 },
          uOverdrive: { value: 0 },
          uDamage: { value: 0 },
          uHeart: { value: 0 },
          uInvert: { value: 0 },
          uVignette: { value: 0.35 },
          uGrain: { value: 0.035 },
          uScan: { value: 0.035 },
          uShock: { value: new THREE.Vector4(0.5, 0.5, 0, 0) },
          uShock2: { value: new THREE.Vector4(0.5, 0.5, 0, 0) },
          uBlur: { value: 0 },
          uBlurCenter: { value: new THREE.Vector2(0.5, 0.5) },
          uBarrel: { value: 0 },
          uExposure: { value: 1 },
        },
        vertexShader: finalVert,
        fragmentShader: finalFrag,
        defines: { RADIAL_TAPS: 0 },
      }),
    );
    this.u = this.final.material.uniforms as unknown as PostUniforms;
    this.composer.addPass(this.final);
    this.fxaa = new FXAAPass();
    this.composer.addPass(this.fxaa);
  }

  applyQuality(p: QualityPreset) {
    this.pixelRatio = p.pixelRatio(devicePixelRatio || 1);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(this.width, this.height, false);
    this.bloom.scale = p.bloomScale;
    this.bloomBase = p.bloomStrength;
    this.bloom.strength = p.bloomStrength;
    this.bloom.radius = p.bloomRadius;
    this.fxaa.enabled = p.fxaa;
    const mat = this.final.material;
    const defs = mat.defines as Record<string, any>;
    defs.RADIAL_TAPS = p.radialBlur;
    if (p.shockwave) defs.SHOCKWAVE = '';
    else delete defs.SHOCKWAVE;
    if (p.grain) defs.GRAIN = '';
    else delete defs.GRAIN;
    mat.needsUpdate = true;
    this.composer.setPixelRatio(this.pixelRatio);
    this.setSize(this.width, this.height);
  }

  setSize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.u.uRes.value.set(w * this.pixelRatio, h * this.pixelRatio);
  }

  /** Drawing-buffer height (for point-size scaling). */
  get bufferHeight() {
    return this.height * this.pixelRatio;
  }

  setBloomStrength(s: number) {
    this.bloom.strength = s;
  }

  render() {
    this.composer.render();
  }

  dispose() {
    this.composer.dispose();
    this.bloom.dispose();
    this.final.dispose();
    this.fxaa.dispose();
  }
}
