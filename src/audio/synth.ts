/** Small DSP helpers shared by the mixer, SFX and music engine. Everything is procedural. */

export const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** Deterministic PRNG (mulberry32) so procedural melodies are stable per sector. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Mono white noise buffer, played from random offsets for variety. */
export function makeNoise(ctx: BaseAudioContext, seconds = 2): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/**
 * Stereo impulse response: exponentially decaying noise with a darkening tail
 * (one-pole lowpass whose cutoff falls over time) and a short pre-delay.
 */
export function makeImpulse(ctx: BaseAudioContext, seconds = 2.6, decay = 3.2, preDelay = 0.012): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  const pre = Math.floor(sr * preDelay);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const x = (i - pre) / (len - pre);
      const amp = Math.pow(1 - x, decay);
      // cutoff coefficient falls from bright to dark across the tail
      const k = 0.85 - 0.75 * x;
      lp += k * ((Math.random() * 2 - 1) - lp);
      d[i] = lp * amp;
    }
    // early reflections
    for (let r = 0; r < 6; r++) {
      const at = pre + Math.floor(sr * (0.008 + Math.random() * 0.05));
      if (at < len) d[at] += (Math.random() * 2 - 1) * 0.5 * (1 - r / 6);
    }
  }
  return buf;
}

/** Soft-clip (tanh-ish) waveshaper curve. */
export function driveCurve(amount: number, n = 1024): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const k = Math.max(0.001, amount);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  return c;
}

/** Bit-crush style quantizing curve for glitch sounds. */
export function crushCurve(steps: number, n = 1024): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.round(x * steps) / steps;
  }
  return c;
}

/** Linear attack then exponential decay to silence on an AudioParam. */
export function adEnv(p: AudioParam, t: number, peak: number, attack: number, decay: number) {
  p.cancelScheduledValues(t);
  p.setValueAtTime(0.0001, t);
  p.linearRampToValueAtTime(peak, t + attack);
  p.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

/** Attack / hold / release envelope (for sustained notes). */
export function ahrEnv(p: AudioParam, t: number, peak: number, attack: number, hold: number, release: number) {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + attack);
  p.setValueAtTime(peak, t + Math.max(attack, hold));
  p.setTargetAtTime(0, t + Math.max(attack, hold), release / 4);
}
