import { settings } from '../core/Settings';
import { makeImpulse, makeNoise } from './synth';

/** Tuning: overall bus levels before user volume. */
const MUSIC_LEVEL = 0.55;
const SFX_LEVEL = 0.9;
const REVERB_RETURN = 0.55;
const DELAY_RETURN = 0.45;
const DELAY_FEEDBACK = 0.38;

/** A bus with three inputs: dry, reverb send, delay send. All three follow the bus volume. */
export interface Bus {
  dry: GainNode;
  verb: GainNode;
  echo: GainNode;
}

/**
 * master -> glue compressor -> brickwall limiter -> destination.
 * music path: instruments -> music.{dry,verb,echo} -> duck -> lowpass (muffle) -> master / reverb / delay
 * sfx path: voices -> sfx.{dry,verb,echo} -> master / reverb / delay
 */
export class Mixer {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly music: Bus;
  readonly sfx: Bus;
  readonly noise: AudioBuffer;
  private delay: DelayNode;
  private musicDucks: GainNode[] = [];
  private musicFilters: BiquadFilterNode[] = [];
  private filterFreq = 20000;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    const t = ctx.currentTime;
    this.noise = makeNoise(ctx, 2);

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.006;
    comp.release.value = 0.18;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;
    this.master = ctx.createGain();
    this.master.connect(comp).connect(limiter).connect(ctx.destination);

    // shared reverb
    const reverbIn = ctx.createGain();
    const convolver = ctx.createConvolver();
    convolver.buffer = makeImpulse(ctx, 2.6, 3.4);
    const revHp = ctx.createBiquadFilter();
    revHp.type = 'highpass';
    revHp.frequency.value = 220; // keep mud out of the tail
    const revRet = ctx.createGain();
    revRet.gain.value = REVERB_RETURN;
    reverbIn.connect(revHp).connect(convolver).connect(revRet).connect(this.master);

    // tempo-synced feedback delay (dotted 8th)
    const delayIn = ctx.createGain();
    this.delay = ctx.createDelay(2);
    this.delay.delayTime.value = 0.375;
    const dlp = ctx.createBiquadFilter();
    dlp.type = 'lowpass';
    dlp.frequency.value = 2800;
    const dhp = ctx.createBiquadFilter();
    dhp.type = 'highpass';
    dhp.frequency.value = 300;
    const fb = ctx.createGain();
    fb.gain.value = DELAY_FEEDBACK;
    const dRet = ctx.createGain();
    dRet.gain.value = DELAY_RETURN;
    delayIn.connect(this.delay).connect(dlp).connect(dhp);
    dhp.connect(fb).connect(this.delay);
    dhp.connect(dRet).connect(this.master);
    const d2r = ctx.createGain();
    d2r.gain.value = 0.25;
    dhp.connect(d2r).connect(reverbIn);

    const makeBus = (music: boolean): Bus => {
      const targets = [this.master, reverbIn, delayIn];
      const nodes = targets.map((dest) => {
        const g = ctx.createGain();
        if (music) {
          const duck = ctx.createGain();
          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.value = 20000;
          lp.Q.value = 0.9;
          g.connect(duck).connect(lp).connect(dest);
          this.musicDucks.push(duck);
          this.musicFilters.push(lp);
        } else {
          g.connect(dest);
        }
        return g;
      });
      return { dry: nodes[0], verb: nodes[1], echo: nodes[2] };
    };
    this.music = makeBus(true);
    this.sfx = makeBus(false);

    this.applyVolumes(true);
    settings.onChange(() => this.applyVolumes(false));
    void t;
  }

  private applyVolumes(instant: boolean) {
    const s = settings.data;
    const t = this.ctx.currentTime;
    const set = (p: AudioParam, v: number) => {
      if (instant) p.value = v;
      else p.setTargetAtTime(v, t, 0.05);
    };
    // perceptual curve: squared slider
    set(this.master.gain, s.masterVolume * s.masterVolume);
    const mv = s.musicVolume * s.musicVolume * MUSIC_LEVEL;
    const sv = s.sfxVolume * s.sfxVolume * SFX_LEVEL;
    for (const g of [this.music.dry, this.music.verb, this.music.echo]) set(g.gain, mv);
    for (const g of [this.sfx.dry, this.sfx.verb, this.sfx.echo]) set(g.gain, sv);
  }

  setDelayTime(seconds: number) {
    this.delay.delayTime.setTargetAtTime(Math.min(1.9, seconds), this.ctx.currentTime, 0.05);
  }

  /** Sidechain-style duck of the whole music bus. amount 0..1. */
  duck(amount: number, hold = 0.05, release = 0.35) {
    const t = this.ctx.currentTime;
    for (const d of this.musicDucks) {
      const p = d.gain;
      p.cancelScheduledValues(t);
      p.setValueAtTime(p.value, t);
      p.linearRampToValueAtTime(1 - amount, t + 0.012);
      p.setTargetAtTime(1, t + 0.012 + hold, release / 3);
    }
  }

  /** Music lowpass (pause / upgrade muffling, overdrive). */
  setMusicFilter(freq: number, timeConst = 0.12) {
    if (Math.abs(freq - this.filterFreq) < 1) return;
    this.filterFreq = freq;
    const t = this.ctx.currentTime;
    for (const f of this.musicFilters) {
      f.frequency.cancelScheduledValues(t);
      f.frequency.setTargetAtTime(freq, t, timeConst);
    }
  }
}
