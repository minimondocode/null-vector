import type { Mixer } from './Mixer';
import { adEnv, clamp, crushCurve, driveCurve, hashStr, mtof } from './synth';

/** Tuning: global voice cap (priority sounds bypass it). */
const MAX_VOICES = 36;
/** World units mapped to full stereo pan. */
const PAN_RANGE = 30;
const PAN_WIDTH = 0.65;

type Out = 'dry' | 'verb' | 'echo';

/**
 * Synthesized one-shots. Every sound passes a gate (per-sound cooldown + max concurrency + global cap)
 * so a hundred simultaneous events cost a handful of voices.
 */
export class Sfx {
  private ctx: AudioContext;
  private mx: Mixer;
  private voices = 0;
  private last = new Map<string, number>();
  private active = new Map<string, number>();
  private shootLp: BiquadFilterNode;
  private crusher: WaveShaperNode;
  private grit: WaveShaperNode;
  private shotCount = 0;

  constructor(mx: Mixer) {
    this.mx = mx;
    this.ctx = mx.ctx;
    const ctx = this.ctx;
    // shared player-shot tone shaping: soft, rounded, not fatiguing
    this.shootLp = ctx.createBiquadFilter();
    this.shootLp.type = 'lowpass';
    this.shootLp.frequency.value = 2600;
    this.shootLp.Q.value = 0.7;
    this.shootLp.connect(mx.sfx.dry);
    const shotEcho = ctx.createGain();
    shotEcho.gain.value = 0.12;
    this.shootLp.connect(shotEcho).connect(mx.sfx.verb);

    this.crusher = ctx.createWaveShaper();
    this.crusher.curve = crushCurve(6);
    this.crusher.connect(mx.sfx.dry);
    this.grit = ctx.createWaveShaper();
    this.grit.curve = driveCurve(4);
    this.grit.connect(mx.sfx.dry);
    const gritVerb = ctx.createGain();
    gritVerb.gain.value = 0.35;
    this.grit.connect(gritVerb).connect(mx.sfx.verb);
  }

  // ----------------------------------------------------------- plumbing

  private gate(name: string, cooldown: number, maxConc: number, priority = false): boolean {
    if (this.ctx.state !== 'running') return false;
    if (!priority && this.voices >= MAX_VOICES) return false;
    const now = this.ctx.currentTime;
    if (now - (this.last.get(name) ?? -9) < cooldown) return false;
    if ((this.active.get(name) ?? 0) >= maxConc) return false;
    this.last.set(name, now);
    return true;
  }

  /** Register a voice: `src` is the longest-living source; `nodes` are disconnected when it ends. */
  private voice(name: string, src: AudioScheduledSourceNode, nodes: AudioNode[]) {
    this.voices++;
    this.active.set(name, (this.active.get(name) ?? 0) + 1);
    src.onended = () => {
      this.voices--;
      this.active.set(name, (this.active.get(name) ?? 1) - 1);
      src.disconnect();
      for (const n of nodes) n.disconnect();
    };
  }

  private gain(v = 0) {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }

  /** Output gain routed to the sfx bus with optional reverb/delay sends and stereo pan. */
  private out(level: number, sends: Partial<Record<Out, number>> = {}, x?: number): { g: GainNode; nodes: AudioNode[] } {
    const ctx = this.ctx;
    const g = this.gain(level);
    const nodes: AudioNode[] = [g];
    let head: AudioNode = g;
    if (x !== undefined) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(x / PAN_RANGE, -1, 1) * PAN_WIDTH;
      g.connect(p);
      head = p;
      nodes.push(p);
    }
    head.connect(this.mx.sfx.dry);
    for (const k of ['verb', 'echo'] as const) {
      const a = sends[k];
      if (!a) continue;
      const s = this.gain(a);
      head.connect(s).connect(this.mx.sfx[k]);
      nodes.push(s);
    }
    return { g, nodes };
  }

  private osc(type: OscillatorType, f: number, t: number, dur: number) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.start(t);
    o.stop(t + dur);
    return o;
  }

  private noise(t: number, dur: number, rate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.mx.noise;
    s.playbackRate.value = rate;
    s.start(t, Math.random() * 1.2);
    s.stop(t + dur);
    return s;
  }

  private filter(type: BiquadFilterType, f: number, q = 1) {
    const b = this.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  }

  /** Short enveloped tone (blips, chimes). */
  private tone(name: string, type: OscillatorType, f: number, t: number, vel: number, decay: number, sends: Partial<Record<Out, number>> = {}, f2?: number) {
    const { g, nodes } = this.out(1, sends);
    adEnv(g.gain, t, vel, 0.004, decay);
    const o = this.osc(type, f, t, decay + 0.05);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + decay);
    o.connect(g);
    this.voice(name, o, nodes);
  }

  /** Noise + sub explosion body. */
  private boom(name: string, t: number, size: number, x?: number, level = 1) {
    const s = clamp(size, 0.5, 10);
    const dur = 0.35 + s * 0.18;
    const { g, nodes } = this.out(level, { verb: 0.25 + s * 0.04 }, x);
    // noise crack with falling lowpass
    const lp = this.filter('lowpass', 6000, 0.8);
    lp.frequency.setValueAtTime(Math.min(9000, 2500 + s * 900), t);
    lp.frequency.exponentialRampToValueAtTime(120, t + dur);
    const ng = this.gain();
    adEnv(ng.gain, t, 0.5 + Math.min(0.4, s * 0.06), 0.002, dur);
    const n = this.noise(t, dur + 0.05, 0.7 + Math.random() * 0.3);
    n.connect(ng).connect(lp).connect(g);
    // sub thump
    const sg = this.gain();
    adEnv(sg.gain, t, Math.min(1, 0.35 + s * 0.12), 0.003, 0.25 + s * 0.08);
    const o = this.osc('sine', 120, t, 0.35 + s * 0.08);
    o.frequency.setValueAtTime(110 + 30 / s, t);
    o.frequency.exponentialRampToValueAtTime(32, t + 0.25 + s * 0.05);
    o.connect(sg).connect(g);
    this.voice(name, n, [ng, lp, sg, o, ...nodes]);
  }

  /** Detuned saw chord swell (stingers, victory). */
  private chord(name: string, t: number, midis: number[], vel: number, attack: number, hold: number, release: number, bright = 2400) {
    const { g, nodes } = this.out(1, { verb: 0.6, echo: 0.15 });
    const lp = this.filter('lowpass', bright, 1);
    lp.connect(g);
    const end = attack + hold + release + 0.1;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + attack);
    g.gain.setValueAtTime(vel, t + attack + hold);
    g.gain.setTargetAtTime(0, t + attack + hold, release / 4);
    let last: OscillatorNode | null = null;
    const amp = 1 / Math.sqrt(midis.length * 2);
    for (const m of midis) {
      for (const d of [-12, 12]) {
        const vg = this.gain(amp);
        const o = this.osc('sawtooth', mtof(m), t, end);
        o.detune.value = d;
        o.connect(vg).connect(lp);
        nodes.push(vg);
        if (last) nodes.push(last);
        last = o;
      }
    }
    nodes.push(lp);
    this.voice(name, last!, nodes);
  }

  // ----------------------------------------------------------- gameplay

  playerShoot() {
    if (!this.gate('shoot', 0.045, 3)) return;
    const t = this.ctx.currentTime;
    const g = this.gain();
    g.connect(this.shootLp);
    // softer on rapid fire, slight random pitch so it never machine-guns
    this.shotCount++;
    const vel = 0.13;
    const f = 760 * (1 + (Math.random() - 0.5) * 0.09) * (this.shotCount % 2 ? 1 : 0.97);
    adEnv(g.gain, t, vel, 0.002, 0.075);
    const o = this.osc('triangle', f, t, 0.09);
    o.frequency.exponentialRampToValueAtTime(f * 0.42, t + 0.07);
    const o2 = this.osc('sine', f * 2, t, 0.03);
    const g2 = this.gain(0.35);
    o.connect(g);
    o2.connect(g2).connect(g);
    this.voice('shoot', o, [g, g2, o2]);
  }

  enemyHit(x: number) {
    if (!this.gate('hit', 0.035, 3)) return;
    const t = this.ctx.currentTime;
    const { g, nodes } = this.out(1, {}, x);
    adEnv(g.gain, t, 0.09, 0.001, 0.035);
    const hp = this.filter('bandpass', 3800 + Math.random() * 800, 2);
    const n = this.noise(t, 0.05, 1);
    const o = this.osc('square', 1500 + Math.random() * 200, t, 0.03);
    const og = this.gain(0.25);
    n.connect(hp).connect(g);
    o.connect(og).connect(g);
    this.voice('hit', n, [hp, o, og, ...nodes]);
  }

  enemyKilled(kind: string, size: number, x: number) {
    if (!this.gate('kill', 0.028, 5)) return;
    const t = this.ctx.currentTime;
    const s = clamp(size, 0.4, 4);
    // bigger = lower; per-kind colour so each enemy type has its own voice
    const kh = hashStr(kind);
    const f = (520 / Math.sqrt(s)) * (0.85 + (kh % 7) * 0.05) * (1 + (Math.random() - 0.5) * 0.06);
    const types: OscillatorType[] = ['square', 'sawtooth', 'triangle'];
    const { g, nodes } = this.out(1, { verb: 0.2 }, x);
    const dur = 0.12 + s * 0.05;
    adEnv(g.gain, t, 0.2, 0.002, dur);
    const lp = this.filter('lowpass', 3500, 4);
    lp.frequency.setValueAtTime(4000, t);
    lp.frequency.exponentialRampToValueAtTime(300, t + dur);
    const o = this.osc(types[kh % 3], f, t, dur + 0.05);
    o.frequency.exponentialRampToValueAtTime(f * 0.3, t + dur);
    o.connect(lp).connect(g);
    // crunch
    const ng = this.gain();
    adEnv(ng.gain, t, 0.35, 0.001, 0.05);
    const n = this.noise(t, 0.07, 1.4);
    n.connect(ng).connect(g);
    this.voice('kill', o, [lp, ng, n, ...nodes]);
  }

  explosion(size: number, x: number) {
    const tier = size >= 5 ? 'boomL' : size >= 2.5 ? 'boomM' : 'boomS';
    if (!this.gate(tier, size >= 5 ? 0.12 : 0.05, size >= 5 ? 2 : 3, size >= 5)) return;
    this.boom(tier, this.ctx.currentTime, size, x, size >= 2.5 ? 0.9 : 0.6);
  }

  enemyShoot(x: number) {
    if (!this.gate('eshoot', 0.07, 2)) return;
    const t = this.ctx.currentTime;
    const { g, nodes } = this.out(1, {}, x);
    adEnv(g.gain, t, 0.035, 0.003, 0.06);
    const o = this.osc('triangle', 420, t, 0.08);
    o.frequency.exponentialRampToValueAtTime(240, t + 0.06);
    o.connect(g);
    this.voice('eshoot', o, nodes);
  }

  enemySpawn(x: number) {
    if (!this.gate('spawn', 0.09, 2)) return;
    const t = this.ctx.currentTime;
    const { g, nodes } = this.out(1, { verb: 0.4 }, x);
    adEnv(g.gain, t, 0.028, 0.05, 0.14);
    const o = this.osc('sine', 220, t, 0.22);
    o.frequency.exponentialRampToValueAtTime(700, t + 0.18);
    o.connect(g);
    this.voice('spawn', o, nodes);
  }

  playerHit() {
    if (!this.gate('phit', 0.1, 2, true)) return;
    const t = this.ctx.currentTime;
    const g = this.gain();
    g.connect(this.crusher);
    adEnv(g.gain, t, 0.4, 0.002, 0.32);
    const o = this.osc('square', 300, t, 0.35);
    // random stepped pitch = digital glitch
    for (let i = 0; i < 9; i++) o.frequency.setValueAtTime(90 + Math.random() * 900, t + i * 0.03);
    const o2 = this.osc('sawtooth', 55, t, 0.35);
    o2.frequency.exponentialRampToValueAtTime(30, t + 0.3);
    const n = this.noise(t, 0.2, 0.5);
    const ng = this.gain();
    adEnv(ng.gain, t, 0.6, 0.001, 0.15);
    o.connect(g);
    o2.connect(g);
    n.connect(ng).connect(g);
    this.voice('phit', o, [g, o2, n, ng]);
  }

  playerDeath() {
    if (!this.gate('death', 0.5, 1, true)) return;
    const t = this.ctx.currentTime;
    const dur = 2.2;
    const g = this.gain();
    g.connect(this.grit);
    g.gain.setValueAtTime(0.45, t);
    g.gain.setTargetAtTime(0, t + 0.9, 0.4);
    const o = this.osc('sawtooth', 900, t, dur);
    o.frequency.exponentialRampToValueAtTime(25, t + dur);
    // stutter glitches over the dive
    for (let i = 0; i < 14; i++) {
      const at = t + 0.05 + i * 0.09 + Math.random() * 0.03;
      o.detune.setValueAtTime((Math.random() - 0.5) * 2400, at);
      o.detune.setValueAtTime(0, at + 0.03);
    }
    const sq = this.osc('square', 450, t, dur);
    sq.frequency.exponentialRampToValueAtTime(18, t + dur);
    const cg = this.gain();
    cg.gain.setValueAtTime(0.15, t);
    cg.gain.setTargetAtTime(0, t + 0.6, 0.3);
    o.connect(g);
    sq.connect(cg).connect(this.crusher);
    this.voice('death', o, [g, sq, cg]);
    this.boom('deathBoom', t, 6, undefined, 1);
  }

  dash() {
    if (!this.gate('dash', 0.08, 2)) return;
    const t = this.ctx.currentTime;
    const { g, nodes } = this.out(1, { verb: 0.2 });
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    const bp = this.filter('bandpass', 500, 2.5);
    bp.frequency.setValueAtTime(450, t);
    bp.frequency.exponentialRampToValueAtTime(3200, t + 0.09);
    bp.frequency.exponentialRampToValueAtTime(700, t + 0.3);
    const n = this.noise(t, 0.32, 1);
    n.connect(bp).connect(g);
    this.voice('dash', n, [bp, ...nodes]);
  }

  dashReady() {
    if (!this.gate('dashReady', 0.2, 1)) return;
    const t = this.ctx.currentTime;
    this.tone('dashReady', 'sine', 1760, t, 0.07, 0.05);
    this.tone('dashReady2', 'sine', 2637, t + 0.05, 0.06, 0.07);
  }

  /** Rising note per multiplier step, in the music's key. */
  combo(midi: number) {
    if (!this.gate('combo', 0.05, 3)) return;
    const t = this.ctx.currentTime;
    this.tone('combo', 'triangle', mtof(midi), t, 0.16, 0.22, { echo: 0.35, verb: 0.25 });
    this.tone('combo2', 'sine', mtof(midi + 12), t, 0.07, 0.14);
  }

  comboLost(midis: number[]) {
    if (!this.gate('comboLost', 0.3, 1)) return;
    const t = this.ctx.currentTime;
    midis.forEach((m, i) => this.tone('comboLostN', 'sawtooth', mtof(m), t + i * 0.07, 0.07, 0.14, { verb: 0.2 }, mtof(m - 1)));
  }

  overdriveReady(midis: number[]) {
    if (!this.gate('odReady', 0.5, 1)) return;
    const t = this.ctx.currentTime;
    midis.forEach((m, i) => {
      const { g, nodes } = this.out(1, { verb: 0.8, echo: 0.3 });
      const at = t + i * 0.06;
      adEnv(g.gain, at, 0.06, 0.02, 1.2);
      const o = this.osc('sine', mtof(m), at, 1.3);
      const trem = this.osc('sine', 9 + i * 1.3, at, 1.3);
      const tg = this.gain(0.4);
      const am = this.gain(0.6);
      trem.connect(tg).connect(am.gain);
      o.connect(am).connect(g);
      this.voice('odReadyN', o, [trem, tg, am, ...nodes]);
    });
  }

  overdriveStart() {
    if (!this.gate('odStart', 0.5, 1, true)) return;
    const t = this.ctx.currentTime;
    // massive bass drop
    const g = this.gain();
    g.connect(this.grit);
    adEnv(g.gain, t, 0.7, 0.005, 1.6);
    const o = this.osc('sine', 140, t, 1.7);
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 1.4);
    const o2 = this.osc('sawtooth', 80, t, 1.2);
    o2.frequency.exponentialRampToValueAtTime(20, t + 1.1);
    const o2g = this.gain(0.25);
    o.connect(g);
    o2.connect(o2g).connect(g);
    this.voice('odStart', o, [g, o2, o2g]);
    // reverse swell: noise + high whine rising, cut abruptly
    const { g: sg, nodes } = this.out(1, { verb: 0.7 });
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.35, t + 0.55);
    sg.gain.linearRampToValueAtTime(0, t + 0.58);
    const bp = this.filter('bandpass', 400, 3);
    bp.frequency.exponentialRampToValueAtTime(5000, t + 0.55);
    const n = this.noise(t, 0.6, 1);
    n.connect(bp).connect(sg);
    this.voice('odSwell', n, [bp, ...nodes]);
    this.boom('odBoom', t, 4, undefined, 0.6);
  }

  overdriveEnd() {
    if (!this.gate('odEnd', 0.3, 1)) return;
    const t = this.ctx.currentTime;
    const { g, nodes } = this.out(1, { verb: 0.5 });
    adEnv(g.gain, t, 0.12, 0.1, 0.5);
    const o = this.osc('triangle', 180, t, 0.65);
    o.frequency.exponentialRampToValueAtTime(900, t + 0.5);
    const bp = this.filter('bandpass', 600, 2);
    bp.frequency.exponentialRampToValueAtTime(4000, t + 0.5);
    const n = this.noise(t, 0.6);
    const ng = this.gain(0.4);
    n.connect(bp).connect(ng).connect(g);
    o.connect(g);
    this.voice('odEnd', o, [bp, n, ng, ...nodes]);
  }

  // ----------------------------------------------------------- stingers / ui

  waveStart(root: number) {
    if (!this.gate('waveStart', 0.5, 1, true)) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      this.tone('alert', 'square', mtof(root + 12), t + i * 0.22, 0.1, 0.1, { echo: 0.3 });
      this.tone('alert', 'square', mtof(root + 7), t + i * 0.22 + 0.1, 0.09, 0.1, { echo: 0.3 });
    }
  }

  arpeggio(name: string, midis: number[], gap: number, vel = 0.12, type: OscillatorType = 'triangle', decay = 0.35) {
    if (!this.gate(name, 0.25, 1, true)) return;
    const t = this.ctx.currentTime;
    midis.forEach((m, i) => this.tone(name + 'N', type, mtof(m), t + i * gap, vel, decay, { verb: 0.4, echo: 0.25 }));
  }

  sectorStart(midis: number[]) {
    if (!this.gate('sector', 1, 1, true)) return;
    const t = this.ctx.currentTime;
    this.chord('sectorChord', t, midis, 0.32, 0.6, 0.8, 1.6, 1800);
    this.boom('sectorBoom', t, 4, undefined, 0.6);
  }

  uiClick() {
    if (!this.gate('click', 0.03, 2, true)) return;
    const t = this.ctx.currentTime;
    this.tone('clickN', 'square', 1300, t, 0.06, 0.03, {}, 900);
  }

  uiHover() {
    if (!this.gate('hover', 0.04, 2, true)) return;
    this.tone('hoverN', 'sine', 2100, this.ctx.currentTime, 0.03, 0.025);
  }

  bossWarning() {
    if (!this.gate('warn', 2, 1, true)) return;
    const t = this.ctx.currentTime;
    const { g, nodes } = this.out(1, { verb: 0.4 });
    const dist = this.ctx.createWaveShaper();
    dist.curve = driveCurve(3);
    const bp = this.filter('bandpass', 900, 1.2);
    dist.connect(bp).connect(g);
    // three klaxon whoops
    const total = 2.7;
    g.gain.setValueAtTime(0, t);
    for (let i = 0; i < 3; i++) {
      const at = t + i * 0.9;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.28, at + 0.05);
      g.gain.setValueAtTime(0.28, at + 0.65);
      g.gain.linearRampToValueAtTime(0, at + 0.85);
    }
    const o = this.osc('sawtooth', 300, t, total);
    const o2 = this.osc('square', 302, t, total);
    for (let i = 0; i < 3; i++) {
      const at = t + i * 0.9;
      for (const osc of [o, o2]) {
        osc.frequency.setValueAtTime(260, at);
        osc.frequency.exponentialRampToValueAtTime(820, at + 0.7);
      }
    }
    const o2g = this.gain(0.5);
    o.connect(dist);
    o2.connect(o2g).connect(dist);
    this.voice('warn', o, [o2, o2g, dist, bp, ...nodes]);
  }

  bossSpawn(midis: number[]) {
    if (!this.gate('bossSpawn', 1, 1, true)) return;
    const t = this.ctx.currentTime;
    this.boom('bossSpawnBoom', t, 8, undefined, 1);
    this.chord('bossSpawnChord', t, midis, 0.3, 0.02, 0.4, 1.8, 1400);
  }

  bossPhase() {
    if (!this.gate('bossPhase', 0.5, 1, true)) return;
    const t = this.ctx.currentTime;
    this.boom('bossPhaseBoom', t, 5, undefined, 0.8);
    const g = this.gain();
    g.connect(this.crusher);
    adEnv(g.gain, t, 0.22, 0.002, 0.5);
    const o = this.osc('square', 200, t, 0.55);
    for (let i = 0; i < 14; i++) o.frequency.setValueAtTime(60 + Math.random() * 1400, t + i * 0.035);
    o.connect(g);
    this.voice('bossPhaseGlitch', o, [g]);
  }

  bossKilled(midis: number[]) {
    if (!this.gate('bossKilled', 1, 1, true)) return;
    const t = this.ctx.currentTime;
    this.boom('bossKilledA', t, 10, undefined, 1);
    this.boom('bossKilledB', t + 0.35, 7, -8, 0.8);
    this.boom('bossKilledC', t + 0.7, 7, 8, 0.8);
    // long dark noise tail
    const { g, nodes } = this.out(1, { verb: 0.8 });
    adEnv(g.gain, t, 0.35, 0.01, 3.2);
    const lp = this.filter('lowpass', 3000, 0.7);
    lp.frequency.exponentialRampToValueAtTime(90, t + 3.2);
    const n = this.noise(t, 3.3, 0.5);
    n.connect(lp).connect(g);
    this.voice('bossKilledTail', n, [lp, ...nodes]);
    // triumphant swell afterwards
    this.chord('bossKilledChord', t + 0.9, midis, 0.28, 0.8, 1.2, 2.4, 3200);
  }

  victory(midis: number[]) {
    if (!this.gate('victory', 2, 1, true)) return;
    const t = this.ctx.currentTime;
    this.chord('victoryChord', t, midis, 0.32, 0.15, 2.2, 2.5, 4200);
    midis.forEach((m, i) => this.tone('victorySparkle', 'triangle', mtof(m + 24), t + 0.15 + i * 0.09, 0.08, 0.6, { echo: 0.4, verb: 0.5 }));
  }
}
