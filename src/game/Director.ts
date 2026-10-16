import * as THREE from 'three';
import { spawnBoss, type BossId } from '../bosses/index';
import { createEnemy, Flock, tuning, type EnemyKind } from '../enemies/index';
import { ENDLESS_THEME, SECTORS, type SectorTheme } from './config';
import { pickupState, resetDrops } from './Pickups';
import { bindUpgradeContext } from './Upgrades';
import type { GameContext } from './types';

type Formation = 'edge' | 'cluster' | 'ring' | 'pincer' | 'line';

/** Authored spawn group: at wave-clock `t`, spawn `n` of `k` in formation `f`. */
interface Group {
  t: number;
  k: EnemyKind;
  n: number;
  f: Formation;
}

interface WaveDef {
  script: Group[];
  /** Weights for the budget-based random spawner. */
  pool: Partial<Record<EnemyKind, number>>;
  /** Points spent by the random spawner (see COST). */
  budget: number;
  /** Seconds between random groups. */
  every: number;
  /** Max alive cost before spawning pauses (keeps it readable). */
  cap: number;
  hp: number;
  speed: number;
  fire: number;
  tier: number;
}

interface Pending {
  at: number;
  kind: EnemyKind;
  x: number;
  z: number;
  flock?: Flock;
}

/** Threat points per unit. */
const COST: Record<string, number> = { seeker: 1, dart: 2, sentinel: 4, swarm: 0.5, splitter: 6, shielder: 5, weaver: 4 };
const MIN_SPAWN_DIST = 7;
const SAFE_EDGE_DIST = 9;

const G = (t: number, k: EnemyKind, n: number, f: Formation = 'edge'): Group => ({ t, k, n, f });

// ------------------------------------------------------------------------------------------
// Campaign: 3 sectors × 4 waves. Each wave = authored script + budget filler from a pool.
// New kinds get a solo intro group first, then are mixed in.
// ------------------------------------------------------------------------------------------
const S1 = { hp: 1, speed: 1, fire: 1, tier: 0 };
const S2 = { hp: 1.3, speed: 1.05, fire: 1.1, tier: 1 };
const S3 = { hp: 1.5, speed: 1.1, fire: 1.2, tier: 2 };

const CAMPAIGN: WaveDef[][] = [
  [
    // 1-1 BOOT: seekers only, teach aim + dash
    { ...S1, script: [G(0, 'seeker', 4, 'cluster'), G(5, 'seeker', 5, 'line'), G(11, 'seeker', 6, 'pincer'), G(18, 'seeker', 8, 'ring')], pool: { seeker: 1 }, budget: 8, every: 3.5, cap: 14 },
    // 1-2 dart intro
    { ...S1, hp: 1.05, script: [G(0, 'dart', 2, 'pincer'), G(5, 'seeker', 6, 'cluster'), G(11, 'dart', 3, 'edge'), G(16, 'seeker', 8, 'ring'), G(23, 'dart', 2, 'pincer'), G(23.5, 'seeker', 5, 'line')], pool: { seeker: 3, dart: 1.2 }, budget: 12, every: 3.5, cap: 16 },
    // 1-3 swarm intro
    { ...S1, hp: 1.1, script: [G(0, 'swarm', 9, 'cluster'), G(8, 'seeker', 6, 'line'), G(13, 'dart', 2, 'pincer'), G(18, 'swarm', 10, 'cluster'), G(25, 'seeker', 8, 'ring'), G(30, 'swarm', 11, 'cluster')], pool: { seeker: 3, dart: 1.5, swarm: 1 }, budget: 14, every: 3.4, cap: 20 },
    // 1-4 sentinel intro, full S1 mix
    { ...S1, hp: 1.15, script: [G(0, 'sentinel', 1, 'edge'), G(3, 'seeker', 6, 'ring'), G(10, 'sentinel', 2, 'pincer'), G(15, 'swarm', 10, 'cluster'), G(21, 'dart', 3, 'edge'), G(27, 'sentinel', 2, 'pincer'), G(27.5, 'seeker', 8, 'ring'), G(34, 'swarm', 12, 'cluster')], pool: { seeker: 3, dart: 1.5, swarm: 1, sentinel: 0.6 }, budget: 16, every: 3.3, cap: 24 },
  ],
  [
    // 2-1 splitter intro
    { ...S2, script: [G(0, 'splitter', 1, 'edge'), G(6, 'seeker', 6, 'ring'), G(11, 'splitter', 2, 'pincer'), G(17, 'swarm', 12, 'cluster'), G(23, 'dart', 3, 'line'), G(28, 'splitter', 1, 'edge'), G(28.5, 'sentinel', 2, 'pincer')], pool: { seeker: 2, dart: 1.5, swarm: 1, sentinel: 1, splitter: 0.7 }, budget: 18, every: 3.4, cap: 26 },
    // 2-2 weaver intro
    { ...S2, hp: 1.35, script: [G(0, 'weaver', 1, 'edge'), G(5, 'seeker', 6, 'cluster'), G(10, 'weaver', 2, 'pincer'), G(16, 'swarm', 10, 'cluster'), G(22, 'sentinel', 2, 'pincer'), G(28, 'weaver', 2, 'pincer'), G(28.5, 'dart', 3, 'edge')], pool: { seeker: 2, dart: 1.5, swarm: 1, sentinel: 1, splitter: 0.7, weaver: 0.8 }, budget: 20, every: 3.3, cap: 28 },
    // 2-3 crossfire
    { ...S2, hp: 1.4, script: [G(0, 'swarm', 11, 'cluster'), G(0.6, 'swarm', 9, 'cluster'), G(8, 'splitter', 2, 'pincer'), G(14, 'sentinel', 3, 'ring'), G(20, 'weaver', 2, 'edge'), G(20.5, 'dart', 4, 'pincer'), G(28, 'seeker', 12, 'ring'), G(33, 'splitter', 2, 'edge')], pool: { seeker: 2, dart: 1.5, swarm: 1.2, sentinel: 1, splitter: 0.8, weaver: 0.8 }, budget: 19, every: 3.1, cap: 30 },
    // 2-4 dense
    { ...S2, hp: 1.45, script: [G(0, 'sentinel', 2, 'pincer'), G(0.8, 'seeker', 8, 'ring'), G(7, 'weaver', 2, 'pincer'), G(12, 'splitter', 3, 'edge'), G(18, 'swarm', 12, 'cluster'), G(18.5, 'swarm', 12, 'cluster'), G(26, 'dart', 5, 'ring'), G(32, 'sentinel', 2, 'pincer'), G(32.5, 'weaver', 2, 'edge')], pool: { seeker: 2, dart: 1.6, swarm: 1.2, sentinel: 1.1, splitter: 0.9, weaver: 0.9 }, budget: 22, every: 3, cap: 32 },
  ],
  [
    // 3-1 shielder intro (shield protects the turrets behind it)
    { ...S3, script: [G(0, 'shielder', 1, 'edge'), G(4, 'seeker', 6, 'ring'), G(10, 'shielder', 1, 'edge'), G(10.3, 'sentinel', 2, 'pincer'), G(18, 'swarm', 12, 'cluster'), G(24, 'shielder', 2, 'pincer'), G(24.5, 'dart', 3, 'edge'), G(31, 'seeker', 10, 'ring')], pool: { seeker: 2, dart: 1.5, swarm: 1, sentinel: 1, splitter: 0.8, weaver: 0.8, shielder: 0.6 }, budget: 20, every: 3.1, cap: 30 },
    // 3-2
    { ...S3, hp: 1.55, script: [G(0, 'shielder', 2, 'pincer'), G(1, 'sentinel', 2, 'pincer'), G(8, 'weaver', 2, 'edge'), G(14, 'splitter', 2, 'pincer'), G(20, 'swarm', 12, 'cluster'), G(20.5, 'swarm', 12, 'cluster'), G(28, 'dart', 4, 'ring'), G(28.5, 'shielder', 1, 'edge'), G(34, 'sentinel', 3, 'ring')], pool: { seeker: 2, dart: 1.6, swarm: 1.2, sentinel: 1.1, splitter: 0.9, weaver: 0.9, shielder: 0.8 }, budget: 23, every: 3, cap: 32 },
    // 3-3
    { ...S3, hp: 1.6, script: [G(0, 'swarm', 12, 'cluster'), G(0.5, 'swarm', 12, 'cluster'), G(5, 'shielder', 2, 'pincer'), G(5.5, 'weaver', 2, 'edge'), G(12, 'splitter', 3, 'edge'), G(18, 'sentinel', 3, 'ring'), G(24, 'dart', 6, 'ring'), G(30, 'shielder', 2, 'edge'), G(30.5, 'seeker', 12, 'ring')], pool: { seeker: 2, dart: 1.7, swarm: 1.2, sentinel: 1.2, splitter: 1, weaver: 1, shielder: 0.9 }, budget: 26, every: 2.9, cap: 34 },
    // 3-4 final push before ROOT
    { ...S3, hp: 1.65, script: [G(0, 'sentinel', 2, 'pincer'), G(0.5, 'shielder', 2, 'pincer'), G(0.8, 'seeker', 10, 'ring'), G(8, 'swarm', 12, 'cluster'), G(8.5, 'swarm', 12, 'cluster'), G(15, 'splitter', 2, 'pincer'), G(15.5, 'weaver', 2, 'edge'), G(22, 'dart', 6, 'ring'), G(28, 'shielder', 3, 'edge'), G(28.5, 'sentinel', 3, 'ring'), G(36, 'seeker', 14, 'ring')], pool: { seeker: 2, dart: 1.7, swarm: 1.3, sentinel: 1.2, splitter: 1, weaver: 1, shielder: 1 }, budget: 29, every: 2.8, cap: 36 },
  ],
];

const BOSS_CYCLE: BossId[] = ['firewall', 'hydra', 'root'];
const ENDLESS_THEMES: SectorTheme[] = [ENDLESS_THEME, ...SECTORS];
const ENDLESS_UNLOCK: [EnemyKind, number, number][] = [
  // kind, first wave, weight
  ['seeker', 1, 3],
  ['dart', 2, 1.5],
  ['swarm', 3, 1.1],
  ['sentinel', 4, 1],
  ['splitter', 6, 0.8],
  ['weaver', 7, 0.8],
  ['shielder', 9, 0.7],
];

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();

/**
 * Run pacing: sectors -> waves -> boss (campaign) or infinite escalating waves (endless).
 * UI reads `wave`, `totalWaves` (0 = unbounded in endless) and `phase`; banners come from bus events.
 */
export class Director {
  wave = 0;
  totalWaves = 4;
  phase: 'intro' | 'wave' | 'breather' | 'boss' | 'done' = 'intro';

  private sectorIdx = 0;
  private def: WaveDef | null = null;
  private clock = 0;
  private scriptIdx = 0;
  private budget = 0;
  private nextRandom = 0;
  private queue: Pending[] = [];
  private timer = 0;
  private next: (() => void) | null = null;
  private bossDone = false;
  private endlessWave = 0;
  private endlessThemeIdx = -1;
  private ctx!: GameContext;

  start(ctx: GameContext) {
    this.ctx = ctx;
    bindUpgradeContext(ctx);
    resetDrops();
    if (ctx.mode === 'endless') {
      this.totalWaves = 0;
      this.endlessWave = 0;
      this.endlessThemeIdx = -1;
      this.nextEndlessWave();
    } else {
      this.totalWaves = CAMPAIGN[0].length;
      this.beginSector(0);
    }
  }

  update(ctx: GameContext, dt: number) {
    this.ctx = ctx;
    if (this.bossDone) {
      this.bossDone = false;
      this.onBossDefeated();
    }
    if (this.next) {
      this.timer -= dt;
      if (this.timer <= 0) {
        const fn = this.next;
        this.next = null;
        fn();
      }
    }
    if (this.phase === 'wave') this.runWave(ctx, dt);
  }

  // ------------------------------------------------------------------ flow

  private after(seconds: number, fn: () => void) {
    this.timer = seconds;
    this.next = fn;
  }

  private beginSector(i: number) {
    const ctx = this.ctx;
    this.sectorIdx = i;
    this.wave = 0;
    this.totalWaves = CAMPAIGN[i].length;
    ctx.sector = i;
    ctx.setTheme(SECTORS[i]);
    this.clearLeftovers(true);
    if (i > 0) {
      ctx.player.stats.maxHp += 1;
      ctx.player.heal(ctx, ctx.player.stats.maxHp);
    }
    ctx.bus.emit('sectorStart', { sector: i, name: SECTORS[i].name });
    this.phase = 'intro';
    this.after(2.6, () => this.startWave(CAMPAIGN[i][0]));
  }

  private startWave(def: WaveDef) {
    const ctx = this.ctx;
    this.def = def;
    this.wave++;
    this.clock = 0;
    this.scriptIdx = 0;
    this.budget = def.budget * ctx.difficulty.spawnCount;
    this.nextRandom = 3;
    this.queue.length = 0;
    tuning.hp = def.hp;
    tuning.speed = def.speed;
    tuning.fire = def.fire;
    tuning.tier = def.tier;
    pickupState.vacuum = false;
    this.phase = 'wave';
    ctx.bus.emit('waveStart', { sector: ctx.sector, wave: this.wave, totalWaves: this.totalWaves });
  }

  private waveCleared() {
    const ctx = this.ctx;
    this.phase = 'breather';
    pickupState.vacuum = true;
    ctx.bus.emit('waveCleared', { sector: ctx.sector, wave: this.wave });
    if (ctx.mode === 'endless') {
      const n = this.endlessWave;
      const offer = n % 2 === 0;
      this.after(1.1, () => {
        if (offer) ctx.offerUpgrades(() => this.after(1.6, () => this.nextEndlessWave()));
        else this.after(0.9, () => this.nextEndlessWave());
      });
      return;
    }
    const waves = CAMPAIGN[this.sectorIdx];
    if (this.wave >= waves.length) {
      // last wave → upgrade, then boss
      this.after(1.1, () => ctx.offerUpgrades(() => this.after(1.2, () => this.startBoss(SECTORS[this.sectorIdx].bossId))));
    } else {
      const nextDef = waves[this.wave];
      this.after(1.1, () => ctx.offerUpgrades(() => this.after(1.8, () => this.startWave(nextDef))));
    }
  }

  private startBoss(id: BossId) {
    const ctx = this.ctx;
    this.phase = 'boss';
    this.clearLeftovers(true);
    ctx.enemyBullets.clear();
    pickupState.vacuum = false;
    let fired = false;
    spawnBoss(ctx, id, () => {
      if (fired) return;
      fired = true;
      // may be called from outside the game loop (timers): handle on next update
      this.bossDone = true;
    });
  }

  private onBossDefeated() {
    const ctx = this.ctx;
    this.phase = 'breather';
    pickupState.vacuum = true;
    ctx.bus.emit('sectorCleared', { sector: ctx.sector });
    if (ctx.mode === 'endless') {
      this.after(1.6, () => ctx.offerUpgrades(() => this.after(1.8, () => this.nextEndlessWave())));
      return;
    }
    if (this.sectorIdx >= SECTORS.length - 1) {
      this.phase = 'done';
      this.after(1.2, () => ctx.victory());
      return;
    }
    this.after(1.6, () => ctx.offerUpgrades(() => this.after(2.0, () => this.beginSector(this.sectorIdx + 1))));
  }

  // ------------------------------------------------------------------ endless

  private nextEndlessWave() {
    const ctx = this.ctx;
    const n = ++this.endlessWave;
    ctx.sector = Math.floor((n - 1) / 10);
    const ti = Math.floor((n - 1) / 5) % ENDLESS_THEMES.length;
    const isBoss = n % 10 === 0;
    const go = () => {
      if (isBoss) {
        this.wave = n;
        const id = BOSS_CYCLE[(n / 10 - 1) % BOSS_CYCLE.length];
        // keep scaling for any adds the boss spawns
        Object.assign(tuning, this.endlessScaling(n));
        this.startBoss(id);
      } else {
        this.wave = n - 1; // startWave increments
        this.startWave(this.endlessDef(n));
      }
    };
    if (ti !== this.endlessThemeIdx) {
      this.endlessThemeIdx = ti;
      const theme = ENDLESS_THEMES[ti];
      ctx.setTheme(theme);
      this.clearLeftovers(true);
      ctx.bus.emit('sectorStart', { sector: ctx.sector, name: theme.name });
      this.phase = 'intro';
      this.after(n === 1 ? 2.6 : 2.2, go);
    } else {
      go();
    }
  }

  private endlessScaling(n: number) {
    return {
      hp: 1 + 0.07 * (n - 1) + 0.15 * Math.floor(n / 10),
      speed: Math.min(1.25, 1 + 0.01 * n),
      fire: Math.min(1.6, 1 + 0.025 * n),
      tier: n < 8 ? 0 : n < 16 ? 1 : 2,
    };
  }

  private endlessDef(n: number): WaveDef {
    const pool: Partial<Record<EnemyKind, number>> = {};
    const unlocked: EnemyKind[] = [];
    for (const [k, first, w] of ENDLESS_UNLOCK) {
      if (n >= first) {
        pool[k] = w;
        unlocked.push(k);
      }
    }
    const newest = ENDLESS_UNLOCK.find(([, first]) => first === n)?.[0];
    const feature = newest ?? unlocked[Math.floor(Math.random() * unlocked.length)];
    const script: Group[] = [];
    // a featured opener, a seeker ring, then a mid-wave spike
    script.push(G(0, feature, this.groupSize(feature, n) + (newest ? 0 : 1), this.formationFor(feature)));
    script.push(G(5, 'seeker', Math.min(16, 5 + Math.floor(n / 2)), 'ring'));
    const spike = unlocked[Math.floor(Math.random() * unlocked.length)];
    script.push(G(14, spike, this.groupSize(spike, n) + 1, this.formationFor(spike)));
    if (n >= 12) script.push(G(14.5, 'swarm', 12, 'cluster'));
    return {
      ...this.endlessScaling(n),
      script,
      pool,
      budget: 10 + 4.2 * n + 0.06 * n * n,
      every: Math.max(1.6, 3.6 - n * 0.06),
      cap: Math.min(44, 14 + n * 1.3),
    };
  }

  // ------------------------------------------------------------------ wave runtime

  private runWave(ctx: GameContext, dt: number) {
    const def = this.def!;
    let aliveCost = 0;
    let alive = 0;
    for (const e of ctx.enemies) {
      if (!e.alive || !e.countsForWave || e.isBoss) continue;
      alive++;
      aliveCost += COST[e.kind] ?? 1;
    }
    for (const q of this.queue) aliveCost += COST[q.kind] ?? 1;

    const scriptDone = this.scriptIdx >= def.script.length;
    const budgetDone = this.budget < 1;

    // pacing: freeze the clock when the screen is saturated; fast-forward when it's empty
    if (aliveCost < def.cap * 1.3) this.clock += dt;
    if (alive === 0 && this.queue.length === 0 && !(scriptDone && budgetDone)) {
      let nextEvt = Infinity;
      if (!scriptDone) nextEvt = def.script[this.scriptIdx].t;
      if (!budgetDone) nextEvt = Math.min(nextEvt, this.nextRandom);
      if (nextEvt - this.clock > 0.6) this.clock = nextEvt - 0.6;
    }

    // authored groups
    while (this.scriptIdx < def.script.length && def.script[this.scriptIdx].t <= this.clock) {
      const g = def.script[this.scriptIdx++];
      this.queueGroup(ctx, g.k, this.scaleCount(ctx, g.k, g.n), g.f);
    }

    // budget filler
    if (!budgetDone && this.clock >= this.nextRandom && aliveCost < def.cap) {
      const pick = this.pickRandomGroup(def);
      if (pick) {
        this.budget -= pick.n * (COST[pick.k] ?? 1);
        this.queueGroup(ctx, pick.k, pick.n, this.formationFor(pick.k));
        this.nextRandom = this.clock + def.every * (0.8 + Math.random() * 0.4);
      } else {
        this.budget = 0;
      }
    }

    // staggered spawns
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i];
      if (q.at > this.clock) continue;
      this.queue.splice(i, 1);
      _p.set(q.x, 0, q.z);
      if (this.distToPlayer(_p) < MIN_SPAWN_DIST) this.randomEdge(ctx, _p);
      ctx.addEnemy(createEnemy(ctx, q.kind, _p.x, _p.z, q.flock));
    }

    if (this.scriptIdx >= def.script.length && this.budget < 1 && this.queue.length === 0 && alive === 0) this.waveCleared();
  }

  private scaleCount(ctx: GameContext, k: EnemyKind, n: number) {
    if (k === 'seeker' || k === 'swarm' || k === 'dart') return Math.max(1, Math.round(n * ctx.difficulty.spawnCount));
    return n;
  }

  private groupSize(k: EnemyKind, n: number) {
    const r = Math.random();
    const late = Math.min(1, n / 20);
    switch (k) {
      case 'seeker':
        return 3 + Math.floor(r * 4 + late * 4);
      case 'dart':
        return 1 + Math.floor(r * 2 + late * 2);
      case 'sentinel':
        return 1 + Math.floor(r * (1.5 + late));
      case 'swarm':
        return 8 + Math.floor(r * 5);
      case 'splitter':
        return 1 + Math.floor(r * late * 2);
      case 'shielder':
        return 1 + Math.floor(r * (0.5 + late));
      case 'weaver':
        return 1 + Math.floor(r * (1 + late));
    }
  }

  private pickRandomGroup(def: WaveDef): { k: EnemyKind; n: number } | null {
    const kinds = Object.keys(def.pool) as EnemyKind[];
    const affordable = kinds.filter((k) => (COST[k] ?? 1) * (k === 'swarm' ? 6 : 1) <= this.budget);
    if (!affordable.length) return null;
    let total = 0;
    for (const k of affordable) total += def.pool[k]!;
    let r = Math.random() * total;
    let k = affordable[0];
    for (const c of affordable) {
      r -= def.pool[c]!;
      if (r <= 0) {
        k = c;
        break;
      }
    }
    const progress = this.ctx.mode === 'endless' ? this.endlessWave : this.sectorIdx * 6 + this.wave * 1.5;
    let n = this.scaleCount(this.ctx, k, this.groupSize(k, progress));
    const minN = k === 'swarm' ? 6 : 1;
    while (n > minN && n * (COST[k] ?? 1) > this.budget) n--;
    return { k, n };
  }

  private formationFor(k: EnemyKind): Formation {
    const r = Math.random();
    switch (k) {
      case 'seeker':
        return r < 0.3 ? 'cluster' : r < 0.55 ? 'ring' : r < 0.8 ? 'line' : 'pincer';
      case 'dart':
        return r < 0.5 ? 'edge' : r < 0.8 ? 'pincer' : 'ring';
      case 'sentinel':
        return r < 0.6 ? 'pincer' : 'edge';
      case 'swarm':
        return 'cluster';
      default:
        return r < 0.5 ? 'edge' : 'pincer';
    }
  }

  // ------------------------------------------------------------------ spawn geometry

  private queueGroup(ctx: GameContext, k: EnemyKind, n: number, f: Formation) {
    if (n <= 0) return;
    const stagger = k === 'swarm' ? 0.035 : n > 6 ? 0.06 : 0.12;
    const t0 = this.clock;
    if (k === 'swarm') {
      // one flock per ≤12 boids, each from its own cluster
      let left = n;
      let delay = 0;
      while (left > 0) {
        const size = Math.min(12, left);
        left -= size;
        const flock = new Flock();
        this.randomEdge(ctx, _q);
        for (let i = 0; i < size; i++) {
          this.scatter(ctx, _q, 2.2, i, _p);
          this.queue.push({ at: t0 + delay + i * stagger, kind: k, x: _p.x, z: _p.z, flock });
        }
        delay += 0.4;
      }
      return;
    }
    const pts = this.formation(ctx, f, n, k);
    for (let i = 0; i < pts.length; i++) this.queue.push({ at: t0 + i * stagger, kind: k, x: pts[i].x, z: pts[i].z });
  }

  private formation(ctx: GameContext, f: Formation, n: number, k: EnemyKind): { x: number; z: number }[] {
    const out: { x: number; z: number }[] = [];
    const p = ctx.player.pos;
    const push = (v: THREE.Vector3) => {
      if (this.distToPlayer(v) < MIN_SPAWN_DIST) this.randomEdge(ctx, v);
      out.push({ x: v.x, z: v.z });
    };
    const spacing = k === 'shielder' || k === 'splitter' || k === 'sentinel' ? 3.2 : 2.2;
    switch (f) {
      case 'edge':
        for (let i = 0; i < n; i++) push(this.randomEdge(ctx, _p));
        break;
      case 'cluster': {
        this.randomEdge(ctx, _q);
        for (let i = 0; i < n; i++) push(this.scatter(ctx, _q, spacing, i, _p));
        break;
      }
      case 'pincer': {
        const a = this.pincerAngle(ctx);
        for (let i = 0; i < n; i++) {
          this.edgeAt(ctx, a + (i % 2) * Math.PI, 2.5, _q);
          push(this.scatter(ctx, _q, spacing, i >> 1, _p));
        }
        break;
      }
      case 'ring': {
        const R = 11.5;
        const off = Math.random() * Math.PI * 2;
        for (let i = 0; i < n; i++) {
          const a = off + (i / n) * Math.PI * 2;
          _p.set(p.x + Math.cos(a) * R, 0, p.z + Math.sin(a) * R);
          ctx.arena.clamp(_p, 2);
          push(_p);
        }
        break;
      }
      case 'line': {
        const a = this.pincerAngle(ctx);
        const step = spacing / Math.max(8, ctx.arena.size);
        for (let i = 0; i < n; i++) push(this.edgeAt(ctx, a + (i - (n - 1) / 2) * step, 2.5, _p));
        break;
      }
    }
    return out;
  }

  /** Point on a sunflower spiral around `c` (deterministic spread, no overlaps). */
  private scatter(ctx: GameContext, c: THREE.Vector3, spacing: number, i: number, out: THREE.Vector3) {
    const r = spacing * 0.6 * Math.sqrt(i);
    const a = i * 2.39996;
    out.set(c.x + Math.cos(a) * r, 0, c.z + Math.sin(a) * r);
    ctx.arena.clamp(out, 1.5);
    return out;
  }

  private distToPlayer(v: THREE.Vector3) {
    const p = this.ctx.player.pos;
    return Math.hypot(v.x - p.x, v.z - p.z);
  }

  /** Arena edge point along angle (x = cos, z = sin) from the centre, `inset` inside the wall. */
  private edgeAt(ctx: GameContext, angle: number, inset: number, out: THREE.Vector3) {
    const dx = Math.cos(angle), dz = Math.sin(angle);
    let lo = 0, hi = ctx.arena.size * 1.5;
    for (let i = 0; i < 18; i++) {
      const m = (lo + hi) / 2;
      if (ctx.arena.contains(dx * m, dz * m, inset)) lo = m;
      else hi = m;
    }
    return out.set(dx * lo, 0, dz * lo);
  }

  /** Random edge point well away from the player. */
  private randomEdge(ctx: GameContext, out: THREE.Vector3) {
    for (let i = 0; i < 16; i++) {
      this.edgeAt(ctx, Math.random() * Math.PI * 2, 2.5, out);
      if (this.distToPlayer(out) >= SAFE_EDGE_DIST) return out;
    }
    // fallback: the side of the arena opposite the player
    const p = ctx.player.pos;
    return this.edgeAt(ctx, Math.atan2(-p.z, -p.x) + (Math.random() - 0.5) * 0.8, 2.5, out);
  }

  /** Angle whose edge point AND opposite edge point are both safely away from the player. */
  private pincerAngle(ctx: GameContext) {
    let best = 0, bestScore = -1;
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const d1 = this.distToPlayer(this.edgeAt(ctx, a, 2.5, _q));
      const d2 = this.distToPlayer(this.edgeAt(ctx, a + Math.PI, 2.5, _q));
      const s = Math.min(d1, d2);
      if (s >= SAFE_EDGE_DIST) return a;
      if (s > bestScore) {
        bestScore = s;
        best = a;
      }
    }
    return best;
  }

  /** Remove hazards (mines etc.) between waves/sectors. `all` also removes counting enemies. */
  private clearLeftovers(all: boolean) {
    for (const e of this.ctx.enemies) {
      if (!e.alive || e.isBoss) continue;
      if (!all && e.countsForWave) continue;
      const d = e as unknown as { despawn?: () => void };
      if (d.despawn) d.despawn();
      else e.alive = false;
    }
  }
}
