import * as THREE from 'three';
import type { EventBus } from '../core/EventBus';
import { settings, type Quality } from '../core/Settings';
import type { Arena } from '../game/Arena';
import { PLAYER_BULLET_COLOR, PLAYER_COLOR, PLAY_Y, type SectorTheme } from '../game/config';
import type { GameContext } from '../game/types';
import { Background } from './Background';
import { DashGhosts } from './DashGhosts';
import { Grid } from './Grid';
import { Particles, SHAPE_GLOW, SHAPE_SHARD, SHAPE_SPARK } from './Particles';
import { PostFX } from './PostFX';
import { AutoQuality, PRESETS, type QualityPreset } from './Quality';
import { Rings } from './Rings';
import { Shake } from './Shake';
import { Walls } from './Walls';

const _c = new THREE.Color();
const _c2 = new THREE.Color();
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const TAU = Math.PI * 2;

interface ShockSlot {
  pos: THREE.Vector3;
  t: number;
  dur: number;
  strength: number;
  maxR: number;
}

interface Delayed {
  t: number;
  fn: () => void;
}

/**
 * Visual effects facade: post-processing, GPU particles, shockwave rings, spring-mass grid floor,
 * arena walls, deep-space backdrop, trauma shake, flashes, quality presets (+ auto quality).
 * Reacts to bus events on its own; gameplay may also call burst/ring/flash/gridImpulse/shake.
 */
export class VFX {
  /** Camera offset to add this frame (screen shake). */
  shakeOffset = new THREE.Vector3();

  private post: PostFX;
  private particles: Particles;
  private rings: Rings;
  private grid: Grid;
  private walls: Walls;
  private bg: Background;
  private ghosts: DashGhosts;
  private shaker = new Shake();
  private auto = new AutoQuality();
  private preset: QualityPreset;
  private quality: Quality;

  private theme?: SectorTheme;
  private arena?: Arena;
  private worldTime = 0;
  private realTime = 0;

  // transient state (all decay in update)
  private beat = 0;
  private lastBeatEvent = -100;
  private lastSelfBeat = -1;
  private flashLevel = 0;
  private flashColor = new THREE.Color(1, 1, 1);
  private chroma = 0;
  private damage = 0;
  private invert = 0;
  private blur = 0;
  private bloomBoost = 0;
  private od = 0;
  private shocks: ShockSlot[] = [];
  private shockHead = 0;
  private delayed: Delayed[] = [];
  private ghostTimer = 0;
  private wasDashing = false;
  private lastWallHit = 0;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    bus: EventBus,
  ) {
    this.quality = settings.data.quality;
    this.preset = PRESETS[this.quality] ?? PRESETS.high;
    this.post = new PostFX(renderer, scene, camera);
    this.particles = new Particles(this.preset.particles);
    this.rings = new Rings();
    this.grid = new Grid();
    this.walls = new Walls();
    this.bg = new Background();
    this.ghosts = new DashGhosts(PLAYER_COLOR);
    scene.add(this.bg.group, this.grid.group, this.walls.group, this.rings.mesh, this.particles.mesh, this.ghosts.group);
    for (let i = 0; i < 2; i++) this.shocks.push({ pos: new THREE.Vector3(), t: 1, dur: 1, strength: 0, maxR: 1 });
    this.post.setSize(innerWidth, innerHeight);
    this.applyQuality(this.quality, true);

    settings.onChange((s, changed) => {
      if (changed.quality && changed.quality !== this.quality) {
        this.applyQuality(changed.quality);
        this.auto.reset();
      }
    });

    this.wire(bus);
  }

  // ---------------------------------------------------------------- public API

  setTheme(theme: SectorTheme, arena: Arena) {
    this.theme = theme;
    this.arena = arena;
    this.grid.setColors(theme.primary, theme.secondary);
    this.grid.build(arena, this.preset.gridRes);
    this.walls.setColors(theme.primary, theme.secondary);
    this.walls.layout(arena);
    this.bg.setTheme(theme.background, theme.primary, theme.secondary);
    this.bg.build(arena.size, this.preset.motes, this.preset.streams);
    this.scene.background = new THREE.Color(theme.background);
    this.grid.sweep();
    this.auto.reset(); // rebuild/shader-compile hitch shouldn't count against the frame budget
  }

  /** Arena size changed at runtime (ROOT shrinks it): re-clip floor and move walls, no rebuild. */
  refreshArena(arena: Arena) {
    this.arena = arena;
    this.grid.refresh(arena);
    this.walls.layout(arena);
  }

  /** Generic burst of sparks + glow motes. */
  burst(pos: THREE.Vector3, color: number, count: number, speed = 8, life = 0.6, size = 1) {
    // bullets dying on the wall come through here: light the wall up
    if (this.arena && count <= 4 && this.arena.distanceToEdge(pos.x, pos.z) < 0.9) this.wallHit(pos, count > 2 ? 1 : 0.6);
    _c.setHex(color);
    const n = Math.max(1, Math.round(count * this.preset.particleMul));
    const P = this.particles;
    const y = pos.y > 0.01 ? pos.y : PLAY_Y;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const up = Math.random() * 0.45;
      const sp = speed * (0.35 + Math.random() * 0.65);
      const ca = Math.cos(a), sa = Math.sin(a);
      const l = life * (0.5 + Math.random() * 0.5);
      if (i % 5 < 3) {
        P.emit(pos.x, y, pos.z, ca * sp, up * sp, sa * sp, l, 0.07 * size, 3.2, _c.r * 2.6, _c.g * 2.6, _c.b * 2.6, SHAPE_SPARK, 0.045, 6);
      } else {
        P.emit(pos.x, y, pos.z, ca * sp * 0.45, up * sp * 0.3, sa * sp * 0.45, l * 1.2, 0.28 * size, 4, _c.r * 1.3, _c.g * 1.3, _c.b * 1.3, SHAPE_GLOW);
      }
    }
  }

  /** Expanding shockwave ring on the floor. */
  ring(pos: THREE.Vector3, color: number, radius: number, duration = 0.5) {
    _c.setHex(color);
    this.rings.emit(pos.x, 0.12, pos.z, radius, _c.r * 2.2, _c.g * 2.2, _c.b * 2.2, duration, 0.18 + radius * 0.03);
  }

  /** Full-screen colour flash (scaled down heavily when flashes are disabled). */
  flash(color: number, strength: number) {
    const s = settings.data.flashes ? strength : strength * 0.15;
    if (s <= this.flashLevel * 0.5) return;
    this.flashColor.setHex(color);
    this.flashLevel = Math.min(1, Math.max(this.flashLevel, s));
  }

  gridImpulse(pos: THREE.Vector3, strength: number, radius: number) {
    this.grid.impulse(pos.x, pos.z, strength, radius);
  }

  shake(amount: number) {
    this.shaker.add(amount);
  }

  /** Spike chromatic aberration (0..~1.5). */
  aberration(amount: number) {
    this.chroma = Math.min(2, this.chroma + amount);
  }

  /** Screen-space shockwave distortion (ultra only). */
  shockwave(pos: THREE.Vector3, strength = 1, duration = 0.9, maxR = 1.3) {
    if (!this.preset.shockwave) return;
    const s = this.shocks[this.shockHead];
    this.shockHead = (this.shockHead + 1) % this.shocks.length;
    s.pos.copy(pos);
    s.t = 0;
    s.dur = duration;
    s.strength = strength;
    s.maxR = maxR;
  }

  /** Radial motion blur kick (high/ultra). */
  radialBlur(amount: number) {
    this.blur = Math.max(this.blur, amount);
  }

  /** Light up the arena wall at an impact point. */
  wallHit(pos: THREE.Vector3, intensity = 1) {
    if (this.realTime - this.lastWallHit < 0.02) return;
    this.lastWallHit = this.realTime;
    this.walls.hit(pos.x, pos.z, this.worldTime, intensity);
    this.grid.impulse(pos.x, pos.z, 2 * intensity, 1.6);
  }

  /** Kill all transient particles/rings (e.g. on returning to title). */
  clearTransient() {
    this.particles.clear();
    this.rings.clear();
  }

  update(realDt: number, worldDt: number, ctx: GameContext) {
    this.realTime += realDt;
    this.worldTime += worldDt;
    const playing = ctx.state === 'playing';

    // auto quality
    if (settings.data.autoQuality) {
      const q = this.auto.sample(realDt, this.quality, playing || ctx.state === 'title');
      if (q) settings.set({ quality: q });
    }

    // delayed effect queue (real time)
    for (let i = this.delayed.length - 1; i >= 0; i--) {
      const d = this.delayed[i];
      d.t -= realDt;
      if (d.t <= 0) {
        this.delayed.splice(i, 1);
        d.fn();
      }
    }

    // beat: use Audio's `beat` events when they arrive, otherwise pulse at theme bpm
    if (this.realTime - this.lastBeatEvent > 2 && this.theme) {
      const idx = Math.floor((this.realTime * this.theme.bpm) / 60);
      if (idx !== this.lastSelfBeat) {
        this.lastSelfBeat = idx;
        this.beat = Math.max(this.beat, idx % 4 === 0 ? 1 : 0.55);
      }
    }
    this.beat *= Math.exp(-realDt * 7);

    // decays
    this.flashLevel *= Math.exp(-realDt * 5);
    this.chroma *= Math.exp(-realDt * 5);
    this.damage = Math.max(0, this.damage - realDt * 1.8);
    this.invert = Math.max(0, this.invert - realDt * 5);
    this.blur *= Math.exp(-realDt * 4);
    this.bloomBoost *= Math.exp(-realDt * 4);
    this.od += ((ctx.overdriveActive ? 1 : 0) - this.od) * Math.min(1, realDt * 5);

    // player-driven effects
    const p = ctx.player;
    const alive = p.alive && (playing || ctx.state === 'paused' || ctx.state === 'upgrade');
    if (playing && p.dashing) {
      this.ghostTimer -= realDt;
      if (this.ghostTimer <= 0 || !this.wasDashing) {
        this.ghostTimer = 0.022;
        this.ghosts.spawn(p.pos.x, p.pos.z, Math.atan2(-p.aim.x, -p.aim.z));
        this.grid.impulse(p.pos.x, p.pos.z, 3, 2.4);
        _c.setHex(PLAYER_COLOR);
        for (let i = 0; i < 3; i++) {
          const j = (Math.random() - 0.5) * 0.8;
          this.particles.emit(
            p.pos.x + j, PLAY_Y, p.pos.z + (Math.random() - 0.5) * 0.8,
            -p.dashDir.x * 6 + (Math.random() - 0.5) * 3, Math.random() * 1.5, -p.dashDir.z * 6 + (Math.random() - 0.5) * 3,
            0.35, 0.06, 4, _c.r * 2.5, _c.g * 2.5, _c.b * 2.5, SHAPE_SPARK, 0.05,
          );
        }
      }
    }
    this.wasDashing = p.dashing;

    // simulation / animation
    this.particles.update(worldDt);
    this.rings.update(worldDt);
    this.ghosts.update(realDt);
    const light = alive ? 1 : 0;
    this.grid.update(worldDt, this.worldTime, this.beat, p.pos.x, p.pos.z, light, this.od * 0.12 + this.flashLevel * 0.3);
    this.walls.update(realDt, this.worldTime, this.beat, alive ? p.pos.x : 1e4, alive ? p.pos.z : 1e4);
    this.bg.update(this.realTime, this.beat);

    // shake
    this.shaker.update(realDt, settings.data.screenShake);
    this.shakeOffset.copy(this.shaker.offset);

    // post uniforms
    const u = this.post.u;
    const flashes = settings.data.flashes;
    u.uTime.value = this.realTime;
    u.uChroma.value = Math.min(flashes ? 2 : 0.35, 0.12 + this.chroma + this.od * 0.25);
    u.uFlash.value = this.flashLevel;
    u.uFlashColor.value.copy(this.flashColor);
    u.uOverdrive.value = this.od;
    u.uInvert.value = flashes ? this.invert * this.invert : 0;
    let heart = 0;
    if (alive && playing) {
      const max = p.stats.maxHp || 5;
      if (p.hp <= 1 || p.hp / max <= 0.34) {
        const ph = (this.realTime * 1.25) % 1;
        const a = (ph - 0.04) * 16, b = (ph - 0.24) * 16;
        heart = 0.12 + 0.45 * Math.max(Math.exp(-a * a), 0.7 * Math.exp(-b * b));
      }
    }
    u.uHeart.value = heart;
    u.uDamage.value = this.damage * this.damage;
    u.uBarrel.value = this.od * 0.14;
    u.uExposure.value = 1 + this.od * 0.05;
    const blurK = this.preset.radialBlur / 10;
    u.uBlur.value = (this.blur + this.od * 0.025) * blurK;
    if (u.uBlur.value > 0.0005) this.toScreen(alive ? _p.set(p.pos.x, PLAY_Y, p.pos.z) : _p.set(0, 0, 0), u.uBlurCenter.value);
    this.updateShock(this.shocks[0], u.uShock.value, realDt);
    this.updateShock(this.shocks[1], u.uShock2.value, realDt);
    this.post.setBloomStrength(this.post.bloomBase * (1 + this.bloomBoost + this.od * 0.15));
  }

  render() {
    this.post.render();
  }

  resize(w: number, h: number) {
    this.post.setSize(w, h);
    this.updatePointScale();
  }

  // ---------------------------------------------------------------- internals

  private applyQuality(q: Quality, initial = false) {
    const preset = PRESETS[q];
    if (!preset) return;
    const gridChanged = preset.gridRes !== this.preset.gridRes;
    const bgChanged = preset.motes !== this.preset.motes || preset.streams !== this.preset.streams;
    this.quality = q;
    this.preset = preset;
    this.post.applyQuality(preset);
    this.particles.setCapacity(preset.particles);
    this.ghosts.setCount(preset.ghosts);
    if (!initial && this.arena) {
      if (gridChanged) this.grid.build(this.arena, preset.gridRes);
      if (bgChanged) this.bg.build(this.arena.size, preset.motes, preset.streams);
    }
    if (!preset.shockwave) for (const s of this.shocks) s.t = s.dur;
    this.updatePointScale();
  }

  private updatePointScale() {
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    this.bg.setScale(this.post.bufferHeight / (2 * Math.tan(fov / 2)));
  }

  private toScreen(world: THREE.Vector3, out: THREE.Vector2) {
    _v.copy(world).project(this.camera);
    out.set(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5);
  }

  private updateShock(s: ShockSlot, out: THREE.Vector4, dt: number) {
    if (s.t >= s.dur || !this.preset.shockwave) {
      out.w = 0;
      return;
    }
    s.t += dt;
    const k = Math.min(1, s.t / s.dur);
    const e = 1 - Math.pow(1 - k, 2.2);
    _v.copy(s.pos).project(this.camera);
    out.set(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5, e * s.maxR, s.strength * (1 - k) * (settings.data.flashes ? 1 : 0.4));
  }

  private later(t: number, fn: () => void) {
    this.delayed.push({ t, fn });
  }

  /** Shards + sparks + glow core: the standard "something died" look. */
  private shatter(pos: THREE.Vector3, color: number, scale: number) {
    const P = this.particles;
    const mul = this.preset.particleMul;
    const y = pos.y > 0.01 ? pos.y : PLAY_Y;
    _c.setHex(color);
    const shards = Math.round((8 + scale * 10) * mul);
    for (let i = 0; i < shards; i++) {
      const a = Math.random() * TAU;
      const sp = (4 + Math.random() * 8) * (0.8 + scale * 0.25);
      P.emit(
        pos.x, y, pos.z,
        Math.cos(a) * sp, 2 + Math.random() * 5, Math.sin(a) * sp,
        0.6 + Math.random() * 0.6, 0.16 + Math.random() * 0.14 * scale, 2.4,
        _c.r * 2.4, _c.g * 2.4, _c.b * 2.4, SHAPE_SHARD, 0, 14, (Math.random() - 0.5) * 18,
      );
    }
    const sparks = Math.round((10 + scale * 12) * mul);
    _c2.copy(_c).lerp(_c2.setRGB(1, 1, 1), 0.55);
    for (let i = 0; i < sparks; i++) {
      const a = Math.random() * TAU;
      const sp = 10 + Math.random() * 14 * (0.7 + scale * 0.3);
      P.emit(
        pos.x, y, pos.z,
        Math.cos(a) * sp, Math.random() * 3, Math.sin(a) * sp,
        0.25 + Math.random() * 0.3, 0.06, 5,
        _c2.r * 3, _c2.g * 3, _c2.b * 3, SHAPE_SPARK, 0.04, 4,
      );
    }
    // hot core flash
    P.emit(pos.x, y, pos.z, 0, 0, 0, 0.22, 1.1 + scale * 0.6, 0, _c.r * 2 + 1.5, _c.g * 2 + 1.5, _c.b * 2 + 1.5, SHAPE_GLOW);
    // lingering embers
    for (let i = 0; i < Math.round(6 * mul * scale); i++) {
      const a = Math.random() * TAU;
      const sp = 1 + Math.random() * 3;
      P.emit(pos.x, y, pos.z, Math.cos(a) * sp, 0.5 + Math.random(), Math.sin(a) * sp, 1 + Math.random() * 0.8, 0.22, 1.5, _c.r * 1.4, _c.g * 1.4, _c.b * 1.4, SHAPE_GLOW, 0, -0.6);
    }
  }

  private wire(bus: EventBus) {
    bus.on('explosion', (e) => {
      const s = Math.max(0.5, e.size);
      this.gridImpulse(e.pos, 5 + 3.2 * s, 2.5 + 1.4 * s);
      this.burst(e.pos, e.color, Math.round(8 + 6 * s), 7 + 2 * s, 0.45 + 0.08 * s, 1);
      if (s >= 1.5) this.ring(e.pos, e.color, 1.5 + 1.3 * s, 0.35 + 0.05 * s);
      this.shake(Math.min(0.5, 0.03 + 0.045 * s));
      if (s >= 3) {
        this.aberration(0.15 * s);
        this.bloomBoost = Math.max(this.bloomBoost, 0.08 * s);
        this.walls.pulse(Math.min(1, s * 0.12));
      }
    });

    bus.on('enemyKilled', (e) => {
      this.shatter(e.pos, e.color, Math.max(0.6, e.size));
      this.ring(e.pos, e.color, 1.6 + e.size * 2.2, 0.28);
    });

    bus.on('enemyHit', (e) => {
      _c.setHex(e.color).lerp(_c2.setRGB(1, 1, 1), 0.4);
      const n = Math.max(2, Math.round(3 * this.preset.particleMul));
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU;
        const sp = 6 + Math.random() * 8;
        this.particles.emit(e.pos.x, PLAY_Y, e.pos.z, Math.cos(a) * sp, Math.random() * 2, Math.sin(a) * sp, 0.18 + Math.random() * 0.12, 0.05, 5, _c.r * 3, _c.g * 3, _c.b * 3, SHAPE_SPARK, 0.035);
      }
    });

    bus.on('playerShoot', (e) => {
      _c.setHex(PLAYER_BULLET_COLOR);
      for (let i = 0; i < 2; i++) {
        const sp = 8 + Math.random() * 8;
        const j = (Math.random() - 0.5) * 0.7;
        const dx = e.dir.x + e.dir.z * j, dz = e.dir.z - e.dir.x * j;
        this.particles.emit(e.pos.x + e.dir.x * 0.9, PLAY_Y, e.pos.z + e.dir.z * 0.9, dx * sp, 0, dz * sp, 0.09, 0.05, 8, _c.r * 2.5, _c.g * 2.5, _c.b * 2.5, SHAPE_SPARK, 0.03);
      }
    });

    bus.on('playerHit', (e) => {
      this.burst(e.pos, 0xff2040, 28, 12, 0.6, 1.2);
      this.burst(e.pos, 0xffffff, 12, 9, 0.4, 0.8);
      this.ring(e.pos, 0xff2040, 5, 0.4);
      this.gridImpulse(e.pos, 16, 6);
      this.aberration(1.2);
      this.damage = 1;
      this.flash(0xff1030, 0.22);
      this.shake(0.55);
      this.shockwave(e.pos, 0.6, 0.5, 0.5);
    });

    bus.on('playerHeal', () => {
      if (!this.theme) return;
      this.walls.pulse(0.6);
    });

    bus.on('playerDeath', (e) => {
      this.shatter(e.pos, PLAYER_COLOR, 4);
      this.burst(e.pos, 0xffffff, 80, 22, 1.0, 1.4);
      this.ring(e.pos, PLAYER_COLOR, 9, 0.6);
      this.later(0.12, () => this.ring(e.pos, 0xffffff, 16, 0.9));
      this.later(0.25, () => this.ring(e.pos, 0xff2040, 24, 1.3));
      this.gridImpulse(e.pos, 45, 16);
      this.flash(0xffffff, 0.6);
      this.aberration(1.6);
      this.shake(1);
      this.radialBlur(0.5);
      this.shockwave(e.pos, 1.4, 1.2, 1.6);
      this.walls.pulse(1);
    });

    bus.on('playerDash', (e) => {
      this.gridImpulse(e.pos, 7, 3.2);
      this.radialBlur(0.08);
      this.ghostTimer = 0;
    });

    bus.on('overdriveStart', (e) => {
      this.rings.emit(e.pos.x, 0.12, e.pos.z, 14, 3, 3, 3, 0.6, 0.7);
      _c.setHex(this.theme?.secondary ?? 0x00e5ff);
      this.rings.emit(e.pos.x, 0.12, e.pos.z, 22, _c.r * 2.5, _c.g * 2.5, _c.b * 2.5, 1.0, 0.5);
      this.gridImpulse(e.pos, 50, 18);
      this.grid.sweep();
      this.invert = 1;
      this.flash(0xffffff, 0.35);
      this.aberration(1.4);
      this.radialBlur(0.6);
      this.shockwave(e.pos, 1.6, 1.0, 1.8);
      this.walls.pulse(1);
      this.shake(0.35);
    });

    bus.on('enemySpawn', (e) => {
      this.gridImpulse(e.pos, -4, 3);
    });

    bus.on('bossSpawn', () => {
      _p.set(0, 0, 0);
      this.gridImpulse(_p, 30, 30);
      this.grid.sweep();
      this.walls.pulse(1);
      this.shake(0.45);
      this.aberration(0.8);
      if (this.theme) this.ring(_p, this.theme.secondary, 30, 1.4);
    });

    bus.on('bossPhase', () => {
      this.walls.pulse(0.8);
      this.shake(0.3);
      this.flash(0xffffff, 0.15);
      this.aberration(0.6);
      this.grid.sweep();
    });

    bus.on('bossKilled', (e) => {
      const base = e.pos.clone();
      const color = this.theme?.enemy ?? 0xff3d7f;
      for (let i = 0; i < 7; i++) {
        this.later(i * 0.13, () => {
          const q = _p.set(base.x + (Math.random() - 0.5) * 6, PLAY_Y, base.z + (Math.random() - 0.5) * 6);
          this.shatter(q, i % 2 ? 0xffffff : color, 2);
          this.ring(q, color, 6, 0.5);
          this.gridImpulse(q, 20, 7);
          this.shake(0.3);
        });
      }
      this.later(1.0, () => {
        this.shatter(base, color, 6);
        this.burst(base, 0xffffff, 120, 26, 1.2, 1.6);
        this.ring(base, 0xffffff, 20, 1.0);
        this.ring(base, color, 34, 1.6);
        this.gridImpulse(base, 60, 26);
        this.flash(0xffffff, 0.7);
        this.aberration(1.8);
        this.radialBlur(0.7);
        this.shockwave(base, 2, 1.4, 2);
        this.walls.pulse(1);
        this.shake(1);
        this.bloomBoost = 0.6;
      });
    });

    bus.on('waveStart', () => this.grid.sweep());
    bus.on('sectorStart', () => {
      this.grid.sweep();
      this.walls.pulse(1);
    });
    bus.on('runStart', () => {
      this.clearTransient();
      this.damage = 0;
      this.grid.sweep();
      _p.set(0, 0, 0);
      this.gridImpulse(_p, 18, 12);
    });
    bus.on('comboLost', () => this.aberration(0.25));

    // Audio may publish beats; not in GameEvents at the time of writing, so subscribe loosely.
    (bus as any).on('beat', (e: { index?: number; bar?: number; strong?: boolean }) => {
      this.lastBeatEvent = this.realTime;
      this.beat = Math.max(this.beat, e?.strong ? 1 : 0.55);
    });
  }
}
