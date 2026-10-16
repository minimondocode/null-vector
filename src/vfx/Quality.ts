import type { Quality } from '../core/Settings';

/** Everything that changes between quality presets. Tune here. */
export interface QualityPreset {
  /** Pixel ratio as a function of devicePixelRatio. */
  pixelRatio: (dpr: number) => number;
  /** Bloom render scale relative to the main buffer (UnrealBloom halves again internally). */
  bloomScale: number;
  bloomStrength: number;
  bloomRadius: number;
  /** Max simultaneously alive particles (ring buffer size). */
  particles: number;
  /** Multiplier on particle counts requested by burst(). */
  particleMul: number;
  /** Grid nodes per axis across the arena. */
  gridRes: number;
  /** Background drifting motes. */
  motes: number;
  /** Background falling data streams. */
  streams: number;
  fxaa: boolean;
  /** Film grain + scanlines. */
  grain: boolean;
  /** Radial blur taps (0 = off). */
  radialBlur: number;
  /** Screen-space shockwave distortion. */
  shockwave: boolean;
  /** Dash afterimage ghosts. */
  ghosts: number;
}

export const QUALITY_ORDER: Quality[] = ['low', 'medium', 'high', 'ultra'];

export const PRESETS: Record<Quality, QualityPreset> = {
  low: {
    pixelRatio: (d) => Math.min(1, d * 0.75),
    bloomScale: 0.5,
    bloomStrength: 0.8,
    bloomRadius: 0.3,
    particles: 2048,
    particleMul: 0.5,
    gridRes: 40,
    motes: 120,
    streams: 16,
    fxaa: false,
    grain: false,
    radialBlur: 0,
    shockwave: false,
    ghosts: 3,
  },
  medium: {
    pixelRatio: () => 1,
    bloomScale: 0.5,
    bloomStrength: 0.9,
    bloomRadius: 0.32,
    particles: 4096,
    particleMul: 0.8,
    gridRes: 56,
    motes: 260,
    streams: 32,
    fxaa: true,
    grain: true,
    radialBlur: 0,
    shockwave: false,
    ghosts: 5,
  },
  high: {
    pixelRatio: (d) => Math.min(d, 1.5),
    bloomScale: 0.75,
    bloomStrength: 0.95,
    bloomRadius: 0.34,
    particles: 8192,
    particleMul: 1,
    gridRes: 68,
    motes: 450,
    streams: 48,
    fxaa: true,
    grain: true,
    radialBlur: 6,
    shockwave: false,
    ghosts: 6,
  },
  ultra: {
    pixelRatio: (d) => Math.min(d, 2),
    bloomScale: 1,
    bloomStrength: 1.0,
    bloomRadius: 0.36,
    particles: 16384,
    particleMul: 1.3,
    gridRes: 84,
    motes: 700,
    streams: 64,
    fxaa: true,
    grain: true,
    radialBlur: 10,
    shockwave: true,
    ghosts: 8,
  },
};

/**
 * Frame-time monitor. Steps quality down after ~3 s sustained below 50 fps,
 * and up (at most once per session) after 10 s sustained above 58 fps.
 */
export class AutoQuality {
  private lowTime = 0;
  private highTime = 0;
  private cooldown = 3;
  private upgraded = false;
  /** Never auto-upgrade above the quality the session started with (vsync hides GPU headroom). */
  private ceiling = -1;
  private avgDt = 1 / 60;

  /** Returns the new quality to switch to, or null. */
  sample(realDt: number, current: Quality, active: boolean): Quality | null {
    if (!active || document.hidden) {
      this.lowTime = this.highTime = 0;
      return null;
    }
    this.avgDt += (realDt - this.avgDt) * 0.1;
    if (this.cooldown > 0) {
      this.cooldown -= realDt;
      return null;
    }
    const fps = 1 / Math.max(1e-4, this.avgDt);
    const idx = QUALITY_ORDER.indexOf(current);
    if (this.ceiling < 0) this.ceiling = idx;
    if (fps < 50) {
      this.lowTime += realDt;
      this.highTime = 0;
      if (this.lowTime > 3 && idx > 0) return this.step(QUALITY_ORDER[idx - 1]);
    } else {
      this.lowTime = Math.max(0, this.lowTime - realDt * 0.5);
      if (fps > 58) {
        this.highTime += realDt;
        if (this.highTime > 10 && !this.upgraded && idx < this.ceiling) {
          this.upgraded = true;
          return this.step(QUALITY_ORDER[idx + 1]);
        }
      } else this.highTime = 0;
    }
    return null;
  }

  private step(q: Quality) {
    this.lowTime = this.highTime = 0;
    this.cooldown = 3; // allow shader compiles / resize hitches to settle
    this.avgDt = 1 / 60;
    return q;
  }

  /** Call after any external quality change so hitches aren't counted. */
  reset() {
    this.lowTime = this.highTime = 0;
    this.cooldown = 3;
  }
}
