import type { SectorTheme } from '../game/config';
import type { Mixer } from './Mixer';
import { adEnv, ahrEnv, clamp, driveCurve, hashStr, mtof, rng } from './synth';

// ---------------------------------------------------------------------------
// Musical data
// ---------------------------------------------------------------------------

type Q = 'm' | 'M' | 'm9' | 'M9' | 'sus';
interface Chord {
  /** semitones above the key tonic */
  r: number;
  q: Q;
}
export type Style = 'title' | 'game' | 'boss' | 'victory';

interface LeadNote {
  /** 16th index within the 8-bar lead phrase */
  step: number;
  midi: number;
  len: number;
}

interface Track {
  id: string;
  style: Style;
  bpm: number;
  /** pitch class of the tonic (C = 0) */
  pc: number;
  prog: Chord[];
  scale: number[];
  lead: LeadNote[];
}

const IV: Record<Q, number[]> = { m: [0, 3, 7], M: [0, 4, 7], m9: [0, 3, 7, 14], M9: [0, 4, 7, 14], sus: [0, 5, 7] };
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const c = (r: number, q: Q): Chord => ({ r, q });

/** Per-sector key + progressions (one chord per bar). */
const KEYS: Record<string, { pc: number; prog: Chord[]; boss: Chord[] }> = {
  // A minor: i - VI - III - VII  (Am F C G)
  s1: { pc: 9, prog: [c(0, 'm9'), c(8, 'M9'), c(3, 'M9'), c(10, 'M')], boss: [c(0, 'm'), c(0, 'm'), c(8, 'M'), c(1, 'M')] },
  // E minor: i - iv - VI - V  (Em Am C B)
  s2: { pc: 4, prog: [c(0, 'm9'), c(5, 'm9'), c(8, 'M9'), c(7, 'M')], boss: [c(0, 'm'), c(8, 'M'), c(1, 'M'), c(7, 'M')] },
  // F minor: i - VII - VI - V  (Fm Eb Db C), andalusian, dramatic
  s3: { pc: 5, prog: [c(0, 'm9'), c(10, 'M'), c(8, 'M9'), c(7, 'M')], boss: [c(0, 'm'), c(1, 'M'), c(8, 'M'), c(7, 'M')] },
  // G minor: i - III - VII - VI
  endless: { pc: 7, prog: [c(0, 'm9'), c(3, 'M9'), c(10, 'M'), c(8, 'M9')], boss: [c(0, 'm'), c(0, 'm'), c(8, 'M'), c(1, 'M')] },
};

const LEAD_RHYTHMS = [
  [0, 4, 6, 8, 12],
  [0, 3, 6, 10, 12, 14],
  [0, 2, 4, 6, 8, 11, 14],
  [0, 6, 8, 12],
  [0, 8, 10, 12, 14],
  [0, 3, 6, 8, 12],
];
const LEAD_CADENCE = [0, 4, 8];
const BELL_RHYTHMS = [[0, 6, 10], [0, 8], [2, 6, 12], [0, 4, 10]];

function genLead(id: string, pc: number, prog: Chord[], scale: number[], sparse: boolean): LeadNote[] {
  const r = rng(hashStr(id));
  const tonic = 57 + ((pc - 9 + 12) % 12); // A3..G#4
  const degMidi = (d: number) => tonic + 12 * Math.floor(d / 7) + scale[((d % 7) + 7) % 7];
  const bars: LeadNote[][] = [];
  let deg = 9 + Math.floor(r() * 3);
  const genBar = (b: number, cadence: boolean) => {
    const ch = prog[b % prog.length];
    const tones = IV[ch.q].map((i) => (pc + ch.r + i) % 12);
    const rhythm = cadence ? LEAD_CADENCE : (sparse ? BELL_RHYTHMS : LEAD_RHYTHMS)[Math.floor(r() * (sparse ? BELL_RHYTHMS : LEAD_RHYTHMS).length)];
    const out: LeadNote[] = [];
    rhythm.forEach((s, i) => {
      const next = i + 1 < rhythm.length ? rhythm[i + 1] : 16;
      const step = r();
      deg += step < 0.3 ? 0 : step < 0.6 ? 1 : step < 0.85 ? -1 : r() < 0.5 ? 2 : -2;
      if (deg > 14) deg -= 2;
      if (deg < 6) deg += 2;
      if (s % 4 === 0 || i === rhythm.length - 1) {
        // snap to nearest chord tone on strong beats
        for (let k = 0; k < 4; k++) {
          if (tones.includes(degMidi(deg) % 12)) break;
          if (tones.includes(degMidi(deg + 1) % 12)) { deg += 1; break; }
          if (tones.includes(degMidi(deg - 1) % 12)) { deg -= 1; break; }
          deg += 1;
        }
      }
      out.push({ step: b * 16 + s, midi: degMidi(deg), len: Math.min(next - s, cadence && i === rhythm.length - 1 ? 8 : 6) });
    });
    return out;
  };
  // A (4 bars) + A' (repeat first 2 bars, new answer)
  for (let b = 0; b < 4; b++) bars.push(genBar(b, b === 3));
  for (let b = 4; b < 8; b++) {
    if (b < 6) bars.push(bars[b - 4].map((n) => ({ ...n, step: n.step + 64 })));
    else bars.push(genBar(b, b === 7));
  }
  return bars.flat();
}

const trackCache = new Map<string, Track>();
export function buildTrack(style: Style, theme: SectorTheme | null): Track {
  const key = KEYS[theme?.id ?? 's1'] ?? KEYS.s1;
  const id = `${style}:${style === 'title' ? 'title' : theme?.id ?? 's1'}`;
  const cached = trackCache.get(id);
  if (cached) return cached;
  let t: Track;
  if (style === 'title') {
    // A minor, slow, 2 bars per chord: Am - F - Dm - Em
    const prog = [c(0, 'm9'), c(0, 'm9'), c(8, 'M9'), c(8, 'M9'), c(5, 'm9'), c(5, 'm9'), c(7, 'sus'), c(7, 'm')];
    t = { id, style, bpm: 86, pc: 9, prog, scale: MINOR, lead: genLead(id, 9, prog, MINOR, true) };
  } else if (style === 'victory') {
    // relative major: I - V - vi - IV
    const pc = (key.pc + 3) % 12;
    const prog = [c(0, 'M9'), c(7, 'M'), c(9, 'm9'), c(5, 'M9')];
    t = { id, style, bpm: 112, pc, prog, scale: MAJOR, lead: genLead(id, pc, prog, MAJOR, false) };
  } else if (style === 'boss') {
    const bpm = (theme?.bpm ?? 120) + 4;
    t = { id, style, bpm, pc: key.pc, prog: key.boss, scale: MINOR, lead: genLead(id, key.pc, key.boss, MINOR, false) };
  } else {
    t = { id, style, bpm: theme?.bpm ?? 120, pc: key.pc, prog: key.prog, scale: MINOR, lead: genLead(id, key.pc, key.prog, MINOR, false) };
  }
  trackCache.set(id, t);
  return t;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

type Layer = 'kick' | 'snare' | 'hat' | 'bass' | 'arp' | 'pad' | 'lead' | 'fx';
const LAYERS: Layer[] = ['kick', 'snare', 'hat', 'bass', 'arp', 'pad', 'lead', 'fx'];

/** Tuning: per-layer [dry level, reverb send, delay send]. */
const MIX: Record<Layer, [number, number, number]> = {
  kick: [0.95, 0.0, 0.0],
  snare: [0.42, 0.55, 0.0],
  hat: [0.16, 0.08, 0.06],
  bass: [0.4, 0.0, 0.0],
  arp: [0.15, 0.2, 0.55],
  pad: [0.2, 0.45, 0.05],
  lead: [0.16, 0.3, 0.35],
  fx: [0.28, 0.6, 0.1],
};

/** Energy thresholds at which game-track layers come in. */
const THRESH = { kick: 0.18, hat: 0.3, snare: 0.42, arp: 0.52, lead: 0.74, busy: 0.6 };

const LOOKAHEAD = 0.12;
const TICK_MS = 25;

interface BeatMark {
  t: number;
  idx: number;
  bar: number;
  strong: boolean;
  dur: number;
}

export class Music {
  private ctx: AudioContext;
  private mx: Mixer;
  /** Music master fades (dry, reverb send, delay send). */
  private outs: GainNode[] = [];
  /** Global pitch offset (cents) wired into every music oscillator: overdrive pitch-down, tape stop. */
  private detune: ConstantSourceNode;
  private vibAmt: GainNode;
  private ch = {} as Record<Layer, GainNode>;
  private inp = {} as Record<Layer, AudioNode>;
  private padPump: GainNode;
  private padFilter: BiquadFilterNode;
  private padPans: GainNode[] = [];
  private arpFilter: BiquadFilterNode;
  private leadFilter: BiquadFilterNode;
  private bassClean: GainNode;
  private bassDirty: GainNode;

  private track: Track | null = null;
  private pending: Track | null = null;
  private pendingUrgent = false;
  private running = false;
  private nextTime = 0;
  private step = 0;
  private prevChordKey = '';
  private on = {} as Record<Layer, boolean>;
  private wasOn = {} as Record<Layer, boolean>;
  private barEnergy = 0;
  private switched = false;

  private tempoScale = 1;
  private tempoTarget = 1;
  private overdrive = false;
  private stopAt = -1;

  private intensity = 0;
  private combo = 1;
  private energy = 0;
  breakdown = false;

  private beats: BeatMark[] = [];
  private beatIdx = 0;
  private lastBeat: BeatMark = { t: 0, idx: 0, bar: 0, strong: true, dur: 0.5 };
  private schedBar = 0;
  /** Bar counter of the currently audible bar. */
  bar = 0;
  onBeat?: (b: { index: number; bar: number; strong: boolean }) => void;

  constructor(mx: Mixer) {
    this.mx = mx;
    const ctx = (this.ctx = mx.ctx);
    this.outs = [mx.music.dry, mx.music.verb, mx.music.echo].map((dest) => {
      const g = ctx.createGain();
      g.connect(dest);
      return g;
    });

    this.detune = ctx.createConstantSource();
    this.detune.offset.value = 0;
    this.detune.start();
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.2;
    this.vibAmt = ctx.createGain();
    this.vibAmt.gain.value = 9;
    vib.connect(this.vibAmt);
    vib.start();

    // layer channels: input -> fade gain (ch) -> out -> buses
    for (const l of LAYERS) {
      const g = ctx.createGain();
      g.gain.value = 0;
      this.ch[l] = g;
      this.inp[l] = g;
      const [dry, verb, echo] = MIX[l];
      [dry, verb, echo].forEach((amt, i) => {
        if (amt <= 0) return;
        const s = ctx.createGain();
        s.gain.value = amt;
        g.connect(s).connect(this.outs[i]);
      });
      this.on[l] = false;
      this.wasOn[l] = false;
    }

    // kick: gentle saturation
    const kShape = ctx.createWaveShaper();
    kShape.curve = driveCurve(1.6);
    kShape.connect(this.ch.kick);
    this.inp.kick = kShape;

    // snare: bandpassed noise
    const sbp = ctx.createBiquadFilter();
    sbp.type = 'bandpass';
    sbp.frequency.value = 2100;
    sbp.Q.value = 0.6;
    sbp.connect(this.ch.snare);
    this.inp.snare = sbp;

    // hats: highpass + air peak
    const hhp = ctx.createBiquadFilter();
    hhp.type = 'highpass';
    hhp.frequency.value = 7200;
    const hpk = ctx.createBiquadFilter();
    hpk.type = 'peaking';
    hpk.frequency.value = 10500;
    hpk.gain.value = 5;
    hhp.connect(hpk).connect(this.ch.hat);
    this.inp.hat = hhp;

    // bass: clean + driven (boss) paths
    const bassIn = ctx.createGain();
    this.bassClean = ctx.createGain();
    this.bassDirty = ctx.createGain();
    this.bassDirty.gain.value = 0;
    const bShape = ctx.createWaveShaper();
    bShape.curve = driveCurve(5);
    bShape.oversample = '2x';
    const bLp = ctx.createBiquadFilter();
    bLp.type = 'lowpass';
    bLp.frequency.value = 3200;
    bassIn.connect(this.bassClean).connect(this.ch.bass);
    bassIn.connect(bShape).connect(bLp).connect(this.bassDirty).connect(this.ch.bass);
    this.inp.bass = bassIn;

    // arp: shared lowpass (brightness follows energy)
    this.arpFilter = ctx.createBiquadFilter();
    this.arpFilter.type = 'lowpass';
    this.arpFilter.frequency.value = 2200;
    this.arpFilter.Q.value = 3;
    this.arpFilter.connect(this.ch.arp);
    this.inp.arp = this.arpFilter;

    // pad: three stereo lanes -> slow-LFO lowpass -> sidechain pump
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 1800;
    this.padFilter.Q.value = 1.5;
    const padLfo = ctx.createOscillator();
    padLfo.frequency.value = 0.07;
    const padLfoAmt = ctx.createGain();
    padLfoAmt.gain.value = 450;
    padLfo.connect(padLfoAmt).connect(this.padFilter.frequency);
    padLfo.start();
    this.padPump = ctx.createGain();
    this.padFilter.connect(this.padPump).connect(this.ch.pad);
    for (const pan of [-0.65, 0, 0.65]) {
      const g = ctx.createGain();
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p).connect(this.padFilter);
      this.padPans.push(g);
    }

    // lead
    this.leadFilter = ctx.createBiquadFilter();
    this.leadFilter.type = 'lowpass';
    this.leadFilter.frequency.value = 3400;
    this.leadFilter.Q.value = 1.2;
    this.leadFilter.connect(this.ch.lead);
    this.inp.lead = this.leadFilter;

    setInterval(() => this.tick(), TICK_MS);
  }

  // ------------------------------------------------------------- public API

  get playing() {
    return this.running && !!this.track;
  }

  get style(): Style | null {
    return this.track?.style ?? null;
  }

  /** 0..1 position within the current beat (realtime, for visuals). */
  get beatPhase() {
    if (!this.running) return 0;
    return clamp((this.ctx.currentTime - this.lastBeat.t) / this.lastBeat.dur, 0, 1);
  }

  /** MIDI note for a scale degree in the current key (used by SFX to stay in harmony). */
  scaleNote(degree: number, baseOctave = 5) {
    degree = Math.round(degree) || 0;
    const tr = this.track ?? this.pending;
    const pc = tr?.pc ?? 9;
    const scale = tr?.scale ?? MINOR;
    const oct = Math.floor(degree / 7);
    return 12 * (baseOctave + 1) + pc + 12 * oct + scale[((degree % 7) + 7) % 7];
  }

  setIntensity(v: number) {
    this.intensity = clamp(v, 0, 1);
  }

  setCombo(m: number) {
    this.combo = m;
  }

  /** Switch track. Non-urgent changes land on the next bar; urgent ones on the next beat. */
  request(tr: Track, urgent = false) {
    if (this.stopAt > 0) this.finishStop();
    if (this.running && this.track?.id === tr.id) {
      this.pending = null;
      return;
    }
    if (!this.running || !this.track) {
      this.startNow(tr);
      return;
    }
    this.pending = tr;
    this.pendingUrgent = urgent;
  }

  setOverdrive(on: boolean) {
    if (this.overdrive === on) return;
    this.overdrive = on;
    if (this.stopAt > 0) return;
    const t = this.ctx.currentTime;
    const p = this.detune.offset;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.setTargetAtTime(on ? -300 : 0, t, on ? 0.12 : 0.2);
    this.tempoTarget = on ? 0.84 : 1;
  }

  /** Game over: slow everything down like a tape machine losing power, then stop. */
  tapeStop() {
    if (!this.running || this.stopAt > 0) return;
    const t = this.ctx.currentTime;
    const p = this.detune.offset;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.setTargetAtTime(-2600, t, 0.5);
    this.tempoTarget = 0.12;
    for (const o of this.outs) {
      o.gain.cancelScheduledValues(t);
      o.gain.setValueAtTime(o.gain.value, t);
      o.gain.setTargetAtTime(0, t + 0.7, 0.25);
    }
    this.stopAt = t + 2.0;
    this.pending = null;
  }

  stop() {
    this.running = false;
    this.track = null;
    this.pending = null;
  }

  update(dt: number) {
    const now = this.ctx.currentTime;
    // tempo glides (overdrive / tape stop)
    const k = 1 - Math.exp(-dt / (this.stopAt > 0 ? 0.5 : 0.15));
    this.tempoScale += (this.tempoTarget - this.tempoScale) * k;
    // energy follows intensity + combo; rises fast, falls slow
    const target = clamp(this.intensity * 0.88 + Math.max(0, this.combo - 1) * 0.05, 0, 1);
    this.energy += (target - this.energy) * (1 - Math.exp(-dt / (target > this.energy ? 0.8 : 3.5)));

    if (this.stopAt > 0 && now >= this.stopAt) this.finishStop();

    while (this.beats.length && this.beats[0].t <= now) {
      const b = this.beats.shift()!;
      this.lastBeat = b;
      this.bar = b.bar;
      this.onBeat?.({ index: b.idx, bar: b.bar, strong: b.strong });
    }
    this.tick();
  }

  /** Called after the context resumes from suspension. */
  resync() {
    this.beats.length = 0;
    this.nextTime = Math.max(this.nextTime, this.ctx.currentTime + 0.05);
  }

  // ------------------------------------------------------------- scheduling

  private finishStop() {
    this.stopAt = -1;
    this.running = false;
    this.track = null;
    this.pending = null;
    this.beats.length = 0;
    const t = this.ctx.currentTime;
    this.detune.offset.cancelScheduledValues(t);
    this.detune.offset.setValueAtTime(this.overdrive ? -300 : 0, t);
    this.tempoScale = this.tempoTarget = this.overdrive ? 0.84 : 1;
    for (const o of this.outs) {
      o.gain.cancelScheduledValues(t);
      o.gain.setValueAtTime(0, t);
    }
    for (const l of LAYERS) {
      this.ch[l].gain.cancelScheduledValues(t);
      this.ch[l].gain.setValueAtTime(0, t);
      this.on[l] = this.wasOn[l] = false;
    }
  }

  private startNow(tr: Track) {
    const t = this.ctx.currentTime;
    this.track = tr;
    this.pending = null;
    this.running = true;
    this.step = 0;
    this.prevChordKey = '';
    this.nextTime = t + 0.06;
    this.switched = true;
    for (const o of this.outs) {
      o.gain.cancelScheduledValues(t);
      o.gain.setValueAtTime(o.gain.value, t);
      o.gain.linearRampToValueAtTime(1, t + 0.05);
    }
    this.applyTrackParams(tr);
  }

  private applyTrackParams(tr: Track) {
    this.mx.setDelayTime((60 / tr.bpm) * 0.75);
    const t = this.ctx.currentTime;
    const boss = tr.style === 'boss';
    this.bassDirty.gain.setTargetAtTime(boss ? 0.55 : 0, t, 0.1);
    this.bassClean.gain.setTargetAtTime(boss ? 0.6 : 1, t, 0.1);
    this.vibAmt.gain.setTargetAtTime(tr.style === 'title' ? 5 : 9, t, 0.1);
  }

  private stepDur() {
    const bpm = this.track?.bpm ?? 120;
    return 60 / bpm / 4 / Math.max(0.05, this.tempoScale);
  }

  private tick() {
    if (!this.running || !this.track || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    if (this.nextTime < now - 0.2) this.nextTime = now + 0.05; // recovered from a stall
    let guard = 0;
    while (this.nextTime < now + LOOKAHEAD && guard++ < 32) {
      this.scheduleStep(this.nextTime);
      this.nextTime += this.stepDur();
      this.step++;
    }
  }

  private scheduleStep(t: number) {
    let s = this.step % 16;
    if (this.pending && (s === 0 || (this.pendingUrgent && s % 4 === 0))) {
      this.track = this.pending;
      this.pending = null;
      this.step = 0;
      s = 0;
      this.prevChordKey = '';
      this.switched = true;
      this.applyTrackParams(this.track);
    }
    const tr = this.track!;
    const sd = this.stepDur();
    const barIdx = Math.floor(this.step / 16);
    if (s === 0) this.onBar(t, tr, barIdx, sd);
    if (s % 4 === 0) {
      if (s === 0) this.schedBar++;
      if (this.beats.length < 64) this.beats.push({ t, idx: this.beatIdx++, bar: this.schedBar, strong: s === 0, dur: sd * 4 });
    }

    const e = this.barEnergy;
    const chord = tr.prog[barIdx % tr.prog.length];
    const style = tr.style;
    const busy = style === 'boss' || style === 'victory' || e >= THRESH.busy;
    const phraseEnd = barIdx % 4 === 3;
    const act = (l: Layer) => this.on[l] || this.wasOn[l];

    // ---- kick
    if (act('kick')) {
      if (s % 4 === 0) this.kick(t, 1, sd);
      else if (style === 'boss' && (s === 14 || (barIdx % 2 === 1 && s === 10))) this.kick(t, 0.55, sd);
    }
    // ---- snare / clap
    if (act('snare')) {
      if (s === 4 || s === 12) this.snare(t, 0.9);
      else if (phraseEnd && busy && s >= 13) this.snare(t, 0.35 + (s - 13) * 0.18);
      else if (style === 'boss' && s === 15 && barIdx % 2 === 1) this.snare(t, 0.4);
    }
    // ---- hats
    if (act('hat')) {
      if (s % 4 === 2) this.hat(t, busy ? 0.75 : 0.65, busy);
      else if (busy) this.hat(t, s % 2 === 0 ? 0.42 : 0.28, false);
    }
    // ---- bass
    if (act('bass')) this.bassStep(t, s, sd, tr, chord, e);
    // ---- arp
    if (act('arp')) this.arpStep(t, s, sd, tr, chord);
    // ---- lead
    if (act('lead')) {
      const pos = (barIdx % 8) * 16 + s;
      for (const n of tr.lead) {
        if (n.step !== pos) continue;
        if (style === 'title') this.bell(t, n.midi, 0.3);
        else this.lead(t, n.midi, n.len * sd * 0.92, style === 'boss' ? 0.32 : 0.28, style === 'boss');
      }
    }
    // ---- fx: riser into big phrase starts
    if (act('fx') && s === 0 && barIdx % 8 === 7 && busy) this.riser(t, sd * 16);
  }

  private onBar(t: number, tr: Track, barIdx: number, sd: number) {
    const style = tr.style;
    let e = this.energy;
    if (style === 'boss') e = Math.max(e, 0.8);
    if (style === 'victory') e = 1;
    this.barEnergy = e;

    // which layers play this bar
    const want: Record<Layer, number> = { kick: 0, snare: 0, hat: 0, bass: 0, arp: 0, pad: 1, lead: 0, fx: 1 };
    if (style === 'title') {
      want.bass = 0.8;
      want.arp = barIdx >= 2 ? 0.75 : 0;
      want.lead = barIdx >= 4 ? 0.7 : 0;
      want.hat = barIdx >= 8 ? 0.35 : 0;
    } else if (this.breakdown) {
      want.bass = 0.8;
      want.hat = 0.5;
    } else if (style === 'game') {
      want.bass = 1;
      want.kick = e >= THRESH.kick ? 1 : 0;
      want.hat = e >= THRESH.hat ? 1 : 0;
      want.snare = e >= THRESH.snare ? 1 : 0;
      want.arp = e >= THRESH.arp || this.combo >= 3 ? 1 : 0;
      want.lead = e >= THRESH.lead || this.combo >= 6 ? 1 : 0;
    } else {
      for (const l of LAYERS) want[l] = 1;
    }
    for (const l of LAYERS) {
      this.wasOn[l] = this.on[l];
      this.on[l] = want[l] > 0;
      const p = this.ch[l].gain;
      p.cancelScheduledValues(t);
      p.setTargetAtTime(want[l], t, want[l] > 0 ? 0.04 : 0.35);
    }

    // timbre follows energy
    const bright = style === 'title' ? 0.25 : e;
    this.padFilter.frequency.setTargetAtTime(700 + 2400 * bright, t, 0.6);
    this.arpFilter.frequency.setTargetAtTime(style === 'title' ? 1500 : 1400 + 3600 * e, t, 0.4);

    // crash on phrase starts / track switches
    if (style !== 'title' && (this.switched || (barIdx % 8 === 0 && e > 0.45 && this.on.kick))) this.crash(t);
    this.switched = false;

    // pad: one chord per run of identical bars
    const chord = tr.prog[barIdx % tr.prog.length];
    const chordKey = `${chord.r}${chord.q}`;
    if (this.prevChordKey !== chordKey || barIdx % tr.prog.length === 0) {
      let bars = 1;
      while (bars < tr.prog.length && barIdx % tr.prog.length + bars < tr.prog.length) {
        const n = tr.prog[(barIdx + bars) % tr.prog.length];
        if (n.r !== chord.r || n.q !== chord.q) break;
        bars++;
      }
      const atk = style === 'title' ? 1.4 : style === 'boss' ? 0.08 : 0.3;
      this.pad(t, this.voicing(tr, chord), bars * 16 * sd, atk);
    }
    this.prevChordKey = chordKey;
  }

  private voicing(tr: Track, ch: Chord) {
    const out: number[] = [];
    const root = tr.pc + ch.r;
    // low root in octave 3
    out.push(48 + (((root - 0) % 12) + 12) % 12);
    for (const i of IV[ch.q]) {
      const pcN = (root + i) % 12;
      // close voicing in G3..F#4, 9ths go up an octave
      let m = 55 + ((pcN - 7 + 12) % 12);
      if (i >= 12) m += 12;
      out.push(m);
    }
    return out;
  }

  private bassStep(t: number, s: number, sd: number, tr: Track, ch: Chord, e: number) {
    const root = 33 + (((tr.pc + ch.r - 9) % 12) + 12) % 12; // A1..G#2
    const style = tr.style;
    if (style === 'title') {
      if (s === 0 && this.step % 32 === 0) this.bass(t, root + 12, sd * 30, 0.55, 0.05, true);
      return;
    }
    if (this.breakdown) {
      if (s === 0) this.bass(t, root, sd * 15, 0.7, 0.15, true);
      return;
    }
    if (style === 'boss') {
      const oct = [0, 0, 12, 0, 0, 0, 12, 0, 0, 12, 0, 0, 12, 0, 0, 12][s];
      this.bass(t, root + oct, sd * 0.8, s % 4 === 0 ? 0.75 : 0.95, 0.75, false);
      return;
    }
    if (style === 'victory') {
      if (s % 2 === 0) this.bass(t, root + (s % 4 === 2 ? 12 : 0), sd * 1.6, 0.9, 0.6, false);
      return;
    }
    if (e < 0.4) {
      if (s % 2 === 0) this.bass(t, root, sd * 1.7, s % 4 === 0 ? 0.7 : 0.95, 0.25 + e, false);
    } else {
      const oct = s === 6 || s === 14 ? 12 : 0;
      this.bass(t, root + oct, sd * 0.85, s % 4 === 0 ? 0.65 : s % 2 === 0 ? 1 : 0.75, 0.35 + e * 0.6, false);
    }
  }

  private arpStep(t: number, s: number, sd: number, tr: Track, ch: Chord) {
    const style = tr.style;
    const base = 64 + (((tr.pc + ch.r - 4) % 12) + 12) % 12; // E4..D#5
    const iv = IV[ch.q === 'm9' ? 'm' : ch.q === 'M9' ? 'M' : ch.q];
    const tones = [base + iv[0], base + iv[1], base + iv[2], base + 12, base + iv[1] + 12, base + iv[2] + 12];
    if (style === 'title') {
      if (s % 2 !== 0) return;
      const pat = [0, 2, 3, 5, 4, 2, 3, 1];
      this.arp(t, tones[pat[(s / 2) % pat.length]] - 12, 0.35, 0.9, 'triangle');
      return;
    }
    const pat =
      style === 'boss' ? [0, 3, 1, 4, 2, 5, 1, 4] : style === 'victory' ? [0, 1, 2, 3, 4, 5, 4, 3] : [0, 1, 2, 3, 4, 3, 2, 1];
    const vel = s % 4 === 0 ? 0.5 : 0.36;
    this.arp(t, tones[pat[s % pat.length]], vel, Math.min(0.22, sd * 1.6), style === 'boss' ? 'sawtooth' : 'square');
  }

  // ------------------------------------------------------------- voices

  private gain(dest: AudioNode, v = 0): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = v;
    g.connect(dest);
    return g;
  }

  /** Oscillator wired to the global detune; cleans itself (and `tail`) up when it ends. */
  private osc(type: OscillatorType, freq: number, t: number, stop: number, cents = 0, tail: AudioNode[] = [], vib = false): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = cents;
    this.detune.connect(o.detune);
    if (vib) this.vibAmt.connect(o.detune);
    o.start(t);
    o.stop(stop);
    o.onended = () => {
      try {
        this.detune.disconnect(o.detune);
        if (vib) this.vibAmt.disconnect(o.detune);
      } catch {}
      o.disconnect();
      for (const n of tail) n.disconnect();
    };
    return o;
  }

  private noise(t: number, stop: number, tail: AudioNode[], rate = 1): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this.mx.noise;
    s.playbackRate.value = rate;
    this.detune.connect(s.detune);
    s.start(t, Math.random() * 1.4);
    s.stop(stop);
    s.onended = () => {
      try {
        this.detune.disconnect(s.detune);
      } catch {}
      s.disconnect();
      for (const n of tail) n.disconnect();
    };
    return s;
  }

  private kick(t: number, vel: number, sd: number) {
    const g = this.gain(this.inp.kick);
    adEnv(g.gain, t, vel, 0.002, 0.42);
    const o = this.osc('sine', 150, t, t + 0.48, 0, [g]);
    o.frequency.setValueAtTime(950, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.012);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.14);
    o.connect(g);
    // sidechain pump on the pads
    const p = this.padPump.gain;
    p.setTargetAtTime(0.22 + 0.5 * (1 - vel), t, 0.004);
    p.setTargetAtTime(1, t + 0.03, sd * 1.1);
  }

  private snare(t: number, vel: number) {
    const g = this.gain(this.inp.snare);
    const p = g.gain;
    // clap-style triple transient into a snare tail
    p.setValueAtTime(vel, t);
    p.exponentialRampToValueAtTime(vel * 0.25, t + 0.009);
    p.setValueAtTime(vel * 0.9, t + 0.011);
    p.exponentialRampToValueAtTime(vel * 0.25, t + 0.02);
    p.setValueAtTime(vel * 0.85, t + 0.022);
    p.exponentialRampToValueAtTime(0.0001, t + 0.24);
    this.noise(t, t + 0.26, [g]).connect(g);
    const bg = this.gain(this.ch.snare);
    adEnv(bg.gain, t, vel * 0.55, 0.001, 0.09);
    const o = this.osc('triangle', 190, t, t + 0.12, 0, [bg]);
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.06);
    o.connect(bg);
  }

  private hat(t: number, vel: number, open: boolean) {
    const g = this.gain(this.inp.hat);
    const d = open ? 0.26 : 0.045;
    adEnv(g.gain, t, vel, 0.001, d);
    this.noise(t, t + d + 0.02, [g]).connect(g);
  }

  private crash(t: number) {
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3800;
    hp.connect(this.ch.fx);
    const g = this.gain(hp);
    adEnv(g.gain, t, 0.55, 0.002, 2.4);
    this.noise(t, t + 2.5, [g, hp], 0.85).connect(g);
  }

  private riser(t: number, dur: number) {
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 3;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(7000, t + dur);
    bp.connect(this.ch.fx);
    const g = this.gain(bp);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.02);
    this.noise(t, t + dur + 0.03, [g, bp]).connect(g);
  }

  private bass(t: number, midi: number, dur: number, vel: number, bright: number, soft: boolean) {
    const f = mtof(midi);
    const end = t + dur + 0.06;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = soft ? 1 : 7;
    lp.connect(this.inp.bass);
    const g = this.gain(lp);
    const peak = soft ? 220 + bright * 600 : 160 + bright * 2600 * vel;
    lp.frequency.setValueAtTime(soft ? 200 : 140, t);
    lp.frequency.exponentialRampToValueAtTime(peak, t + (soft ? 0.4 : 0.008));
    lp.frequency.setTargetAtTime(soft ? 260 : 150 + bright * 260, t + (soft ? 0.4 : 0.01), soft ? dur * 0.5 : Math.max(0.04, dur * 0.35));
    const p = g.gain;
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(vel, t + (soft ? 0.25 : 0.004));
    p.setValueAtTime(vel, t + dur * 0.85);
    p.linearRampToValueAtTime(0, t + dur + 0.05);
    this.osc('sawtooth', f, t, end, -6, [g, lp]).connect(g);
    this.osc(soft ? 'triangle' : 'square', f / 2, t, end, 0).connect(g);
  }

  private arp(t: number, midi: number, vel: number, decay: number, type: OscillatorType) {
    const g = this.gain(this.inp.arp);
    adEnv(g.gain, t, vel, 0.003, decay);
    this.osc(type, mtof(midi), t, t + decay + 0.05, 0, [g]).connect(g);
  }

  private pad(t: number, notes: number[], dur: number, attack: number) {
    const amp = 0.55 / Math.sqrt(notes.length);
    const end = t + dur + 1.4;
    const lanes = this.padPans.map((dest) => {
      const g = this.gain(dest);
      ahrEnv(g.gain, t, amp, attack, dur, 1.1);
      return g;
    });
    const spread = [-17, 0, 17];
    notes.forEach((m, ni) => {
      const f = mtof(m);
      for (let i = 0; i < 3; i++) {
        // root (index 0) only in the centre lane to keep the low end mono
        if (ni === 0 && i !== 1) continue;
        const tail = ni === notes.length - 1 ? [lanes[i]] : [];
        this.osc('sawtooth', f, t, end, spread[i] + (Math.random() - 0.5) * 6, tail).connect(lanes[i]);
      }
    });
  }

  private lead(t: number, midi: number, dur: number, vel: number, harsh: boolean) {
    const f = mtof(midi);
    const end = t + dur + 0.3;
    const g = this.gain(this.inp.lead);
    const p = g.gain;
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(vel, t + 0.012);
    p.setTargetAtTime(vel * 0.75, t + 0.012, 0.15);
    p.setValueAtTime(vel * 0.75, t + dur);
    p.setTargetAtTime(0, t + dur, 0.06);
    this.osc('sawtooth', f, t, end, -8, [g], true).connect(g);
    this.osc(harsh ? 'square' : 'sawtooth', f, t, end, 8, [], true).connect(g);
  }

  private bell(t: number, midi: number, vel: number) {
    const f = mtof(midi);
    const end = t + 2.4;
    const g = this.gain(this.inp.lead);
    adEnv(g.gain, t, vel, 0.003, 2.2);
    const mg = this.ctx.createGain();
    mg.gain.setValueAtTime(f * 2.2, t);
    mg.gain.exponentialRampToValueAtTime(f * 0.05, t + 1.4);
    const car = this.osc('sine', f, t, end, 0, [g]);
    const mod = this.osc('sine', f * 3.5, t, end, 0, [mg]);
    mod.connect(mg).connect(car.frequency);
    car.connect(g);
  }
}
