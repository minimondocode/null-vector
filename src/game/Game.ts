import * as THREE from 'three';
import { EventBus, type GameMode, type GameState } from '../core/EventBus';
import { Input } from '../core/Input';
import { settings } from '../core/Settings';
import { Audio } from '../audio/Audio';
import { VFX } from '../vfx/VFX';
import { UI } from '../ui/UI';
import { Arena } from './Arena';
import { BulletPool } from './Bullets';
import { DIFFICULTY, ENEMY_BULLET_COLOR, PLAYER_BULLET_COLOR, PLAY_Y, SECTORS, type DifficultyParams, type SectorTheme } from './config';
import { Director } from './Director';
import { Player } from './Player';
import { rollUpgrades, UPGRADES, type UpgradeDef } from './Upgrades';
import type { BossInfo, Enemy, Entity, GameContext } from './types';

export interface RunStats {
  kills: number;
  time: number;
  maxMultiplier: number;
  shotsFired: number;
  shotsHit: number;
  damageTaken: number;
  sectorReached: number;
  bossesKilled: number;
  overdrives: number;
}

const _ray = new THREE.Raycaster();
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -PLAY_Y);
const _v = new THREE.Vector3();
const _ndc = new THREE.Vector2();

function distToSegmentSq(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) {
  const abx = b.x - a.x, abz = b.z - a.z;
  const l2 = abx * abx + abz * abz;
  let t = l2 > 0 ? ((p.x - a.x) * abx + (p.z - a.z) * abz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + abx * t - p.x, z = a.z + abz * t - p.z;
  return x * x + z * z;
}

export class Game implements GameContext {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 400);
  renderer: THREE.WebGLRenderer;
  bus = new EventBus();
  input: Input;
  arena = new Arena();
  vfx: VFX;
  audio: Audio;
  ui: UI;
  player: Player;
  enemies: Enemy[] = [];
  entities: Entity[] = [];
  playerBullets: BulletPool;
  enemyBullets: BulletPool;
  difficulty: DifficultyParams = DIFFICULTY.normal;
  theme: SectorTheme = SECTORS[0];
  mode: GameMode = 'campaign';
  state: GameState = 'title';
  sector = 0;
  time = 0;
  runTime = 0;
  timeScale = 1;
  score = 0;
  multiplier = 1;
  overdrive = 0;
  overdriveActive = false;
  boss: BossInfo | null = null;
  kills = 0;
  aimPoint = new THREE.Vector3(0, PLAY_Y, -5);

  director = new Director();
  ownedUpgrades = new Map<string, number>();
  /** Current 1-of-3 offer while state === 'upgrade'. */
  currentOffer: UpgradeDef[] = [];
  runStats: RunStats = this.freshStats();
  /** Wall-clock FPS (smoothed) for the HUD / auto quality. */
  fps = 60;

  private comboKills = 0;
  private comboTimer = 0;
  private overdriveTimer = 0;
  private hitStopTimer = 0;
  private upgradeDone?: () => void;
  private endTimer = -1;
  private pendingEnd: GameState | null = null;
  private stateBeforePause: GameState = 'playing';
  private camTarget = new THREE.Vector3();
  private intensityTimer = 0;
  private dashHits = new WeakMap<Enemy, number>();
  private last = performance.now();

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.id = 'game-canvas';

    this.input = new Input(this.renderer.domElement);
    this.vfx = new VFX(this.renderer, this.scene, this.camera, this.bus);
    this.audio = new Audio(this.bus);
    this.player = new Player(this.scene);
    this.playerBullets = new BulletPool(this.scene, 600, 'bolt', PLAYER_BULLET_COLOR);
    this.enemyBullets = new BulletPool(this.scene, 900, 'orb', ENEMY_BULLET_COLOR);
    this.playerBullets.onWallHit = (b) => this.vfx.burst(_v.set(b.x, PLAY_Y, b.z), PLAYER_BULLET_COLOR, 3, 5, 0.25, 0.5);
    this.enemyBullets.onWallHit = (b) => this.vfx.burst(_v.set(b.x, PLAY_Y, b.z), b.color.getHex(), 2, 3, 0.2, 0.5);

    this.camera.position.set(0, 32, 18);
    this.camera.lookAt(0, 0, 0);
    this.setTheme(SECTORS[0]);
    this.player.object.visible = false;

    this.bus.on('enemyKilled', (e) => this.onKill(e.score, e.kind));
    this.bus.on('playerHit', () => {
      this.runStats.damageTaken++;
      this.breakCombo();
      this.hitStop(0.12);
    });
    this.bus.on('playerDeath', () => {
      this.hitStop(0.35);
      this.scheduleEnd('gameover', 2.2);
    });
    this.bus.on('bossKilled', () => {
      this.runStats.bossesKilled++;
      this.hitStop(0.3);
    });
    this.bus.on('playerShoot', () => this.runStats.shotsFired++);

    this.ui = new UI(this);

    addEventListener('resize', () => this.resize());
    addEventListener('blur', () => {
      if (this.state === 'playing') this.pause();
    });
    // first user gesture unlocks audio
    const unlock = () => this.audio.unlock();
    addEventListener('pointerdown', unlock);
    addEventListener('keydown', unlock);

    this.renderer.setAnimationLoop(() => this.frame());
  }

  private freshStats(): RunStats {
    return { kills: 0, time: 0, maxMultiplier: 1, shotsFired: 0, shotsHit: 0, damageTaken: 0, sectorReached: 1, bossesKilled: 0, overdrives: 0 };
  }

  // ---------------- public API (UI / director) ----------------

  startRun(mode: GameMode) {
    this.clearWorld();
    this.mode = mode;
    this.difficulty = DIFFICULTY[settings.data.difficulty];
    this.sector = 0;
    this.time = 0;
    this.runTime = 0;
    this.score = 0;
    this.multiplier = 1;
    this.comboKills = 0;
    this.comboTimer = 0;
    this.overdrive = 0;
    this.overdriveActive = false;
    this.timeScale = 1;
    this.kills = 0;
    this.boss = null;
    this.endTimer = -1;
    this.pendingEnd = null;
    this.ownedUpgrades.clear();
    this.runStats = this.freshStats();
    this.player.reset(this.difficulty.playerMaxHp);
    this.director = new Director();
    this.setState('playing');
    this.bus.emit('runStart', { mode });
    this.director.start(this);
  }

  pause() {
    if (this.state !== 'playing' && this.state !== 'upgrade') return;
    this.stateBeforePause = this.state;
    this.setState('paused');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.last = performance.now();
    this.setState(this.stateBeforePause);
  }

  quitToTitle() {
    this.clearWorld();
    this.player.object.visible = false;
    this.setTheme(SECTORS[0]);
    this.setState('title');
  }

  chooseUpgrade(id: string) {
    if (this.state !== 'upgrade') return;
    const def = UPGRADES.find((u) => u.id === id);
    if (!def) return;
    def.apply(this.player, this);
    this.player.syncDrones();
    this.ownedUpgrades.set(id, (this.ownedUpgrades.get(id) ?? 0) + 1);
    this.currentOffer = [];
    this.bus.emit('upgradeChosen', { id });
    this.setState('playing');
    const done = this.upgradeDone;
    this.upgradeDone = undefined;
    done?.();
  }

  // ---------------- GameContext ----------------

  addEnemy(e: Enemy) {
    this.enemies.push(e);
  }

  addEntity(e: Entity) {
    this.entities.push(e);
  }

  setBoss(info: BossInfo | null) {
    this.boss = info;
    this.audio.setTheme(this.theme, !!info);
  }

  setTheme(theme: SectorTheme) {
    this.theme = theme;
    this.arena.configure(theme.arenaShape, theme.arenaSize);
    this.vfx.setTheme(theme, this.arena);
    this.audio?.setTheme(theme, false);
    this.scene.fog = new THREE.Fog(theme.background, 40, 90);
  }

  offerUpgrades(onDone?: () => void) {
    if (!this.player.alive) return;
    this.currentOffer = rollUpgrades(this.ownedUpgrades, 3);
    if (!this.currentOffer.length) {
      onDone?.();
      return;
    }
    this.upgradeDone = onDone;
    this.setState('upgrade');
    this.bus.emit('upgradeOffer', { ids: this.currentOffer.map((u) => u.id) });
  }

  hitStop(seconds: number) {
    this.hitStopTimer = Math.max(this.hitStopTimer, seconds);
  }

  victory() {
    this.bus.emit('victory', {});
    this.scheduleEnd('victory', 3);
  }

  // ---------------- internals ----------------

  private setState(to: GameState) {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    this.bus.emit('stateChange', { from, to });
  }

  private scheduleEnd(state: GameState, delay: number) {
    if (this.pendingEnd) return;
    this.pendingEnd = state;
    this.endTimer = delay;
  }

  private clearWorld() {
    for (const e of this.enemies) e.dispose();
    for (const e of this.entities) e.dispose();
    this.enemies.length = 0;
    this.entities.length = 0;
    this.playerBullets.clear();
    this.enemyBullets.clear();
    this.boss = null;
  }

  private onKill(score: number, _kind: string) {
    if (this.state !== 'playing') return;
    this.kills++;
    this.runStats.kills++;
    this.comboKills++;
    this.comboTimer = this.player.stats.comboWindow;
    const newMult = Math.min(12, 1 + Math.floor(this.comboKills / 6));
    if (newMult !== this.multiplier) {
      this.multiplier = newMult;
      this.runStats.maxMultiplier = Math.max(this.runStats.maxMultiplier, newMult);
    }
    this.bus.emit('comboChange', { multiplier: this.multiplier, kills: this.comboKills });
    this.score += Math.round(score * this.multiplier);
    if (!this.overdriveActive && this.overdrive < 1) {
      this.overdrive = Math.min(1, this.overdrive + 0.03 * this.player.stats.overdriveGain);
      if (this.overdrive >= 1) this.bus.emit('overdriveReady', {});
    }
  }

  private breakCombo() {
    if (this.multiplier > 1) this.bus.emit('comboLost', { multiplier: this.multiplier });
    this.comboKills = 0;
    this.comboTimer = 0;
    this.multiplier = 1;
    this.bus.emit('comboChange', { multiplier: 1, kills: 0 });
  }

  private triggerOverdrive() {
    this.overdriveActive = true;
    this.overdrive = 1;
    this.overdriveTimer = this.player.stats.overdriveDuration;
    this.runStats.overdrives++;
    const p = this.player.pos;
    for (const b of this.enemyBullets.items) if (b.active && (b.x - p.x) ** 2 + (b.z - p.z) ** 2 < 14 * 14) b.active = false;
    for (const e of this.enemies) {
      if (e.alive && e.collidable && e.pos.distanceToSquared(p) < 9 * 9) e.damage(this, 4 * this.player.stats.damage, p, 'overdrive');
    }
    this.bus.emit('overdriveStart', { pos: p.clone() });
    this.bus.emit('explosion', { pos: p.clone(), color: 0xffffff, size: 6 });
  }

  private updateAim() {
    _ndc.set(this.input.ndcX, this.input.ndcY);
    _ray.setFromCamera(_ndc, this.camera);
    _ray.ray.intersectPlane(_plane, this.aimPoint);
  }

  private frame() {
    const now = performance.now();
    const realDt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (realDt > 0) this.fps += (1 / realDt - this.fps) * 0.05;

    if (this.input.pausePressed()) {
      if (this.state === 'playing' || this.state === 'upgrade') this.pause();
      else if (this.state === 'paused') this.resume();
    }

    let worldDt = 0;
    if (this.state === 'playing') {
      this.updateAim();
      if (this.hitStopTimer > 0) {
        this.hitStopTimer -= realDt;
      } else {
        this.simulate(realDt);
        worldDt = realDt * this.timeScale;
      }
    } else if (this.state === 'title') {
      // slow attract-mode orbit
      const t = now / 1000;
      this.camera.position.set(Math.sin(t * 0.1) * 30, 26, Math.cos(t * 0.1) * 30);
      this.camera.lookAt(0, 0, 0);
      worldDt = realDt;
      this.time += realDt;
    } else if (this.state === 'gameover' || this.state === 'victory') {
      worldDt = realDt * 0.3;
      this.time += worldDt;
      for (const e of this.enemies) if (e.alive) e.update(this, worldDt);
    }

    this.playerBullets.sync(this.time);
    this.enemyBullets.sync(this.time);
    this.vfx.update(realDt, worldDt, this);
    if (this.state === 'playing' || this.state === 'upgrade' || this.state === 'paused') this.updateCamera(realDt);
    this.vfx.render();
    this.audio.update(realDt);
    this.ui.update(realDt);
    this.input.endFrame();
  }

  private simulate(realDt: number) {
    this.runTime += realDt;
    this.runStats.time = this.runTime;

    // overdrive
    if (this.overdriveActive) {
      this.overdriveTimer -= realDt;
      this.overdrive = Math.max(0, this.overdriveTimer / this.player.stats.overdriveDuration);
      this.timeScale += (0.3 - this.timeScale) * Math.min(1, realDt * 10);
      if (this.overdriveTimer <= 0) {
        this.overdriveActive = false;
        this.overdrive = 0;
        this.bus.emit('overdriveEnd', {});
      }
    } else {
      this.timeScale += (1 - this.timeScale) * Math.min(1, realDt * 6);
      if (this.overdrive >= 1 && this.player.alive && this.input.overdrivePressed()) this.triggerOverdrive();
    }

    const dt = realDt * this.timeScale;
    this.time += dt;

    // combo decay in world time so slow-mo also stretches it
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.breakCombo();
    }

    // player runs in real time — slow-mo is a player advantage
    this.player.update(this, realDt);
    if (this.player.alive) this.director.update(this, dt);

    for (const e of this.enemies) if (e.alive) e.update(this, dt);
    for (const e of this.entities) if (e.alive) e.update(this, dt);

    this.playerBullets.update(realDt, this.arena, this.enemies);
    this.enemyBullets.update(dt, this.arena);

    this.collide();

    // reap
    if (this.enemies.some((e) => !e.alive)) {
      this.enemies = this.enemies.filter((e) => {
        if (!e.alive) e.dispose();
        return e.alive;
      });
    }
    if (this.entities.some((e) => !e.alive)) {
      this.entities = this.entities.filter((e) => {
        if (!e.alive) e.dispose();
        return e.alive;
      });
    }

    // end of run
    if (this.pendingEnd) {
      this.endTimer -= realDt;
      if (this.endTimer <= 0) {
        const s = this.pendingEnd;
        this.pendingEnd = null;
        if (this.overdriveActive) this.bus.emit('overdriveEnd', {});
        this.overdriveActive = false;
        this.timeScale = 1;
        this.setState(s);
      }
    }

    this.intensityTimer -= realDt;
    if (this.intensityTimer <= 0) {
      this.intensityTimer = 0.25;
      const n = this.enemies.reduce((s, e) => s + (e.alive && e.countsForWave ? 1 : 0), 0);
      const v = this.boss ? 1 : Math.min(1, n / 25 + (this.multiplier - 1) / 20);
      this.bus.emit('intensity', { value: v });
    }
  }

  private collide() {
    const p = this.player;
    const stats = p.stats;
    // player bullets -> enemies
    for (const b of this.playerBullets.items) {
      if (!b.active) continue;
      for (const e of this.enemies) {
        if (!e.alive || !e.collidable) continue;
        const r = e.radius + b.radius;
        const dx = e.pos.x - b.x, dz = e.pos.z - b.z;
        if (dx * dx + dz * dz > r * r) continue;
        if (b.hit.includes(e)) continue;
        _v.set(b.x, 0, b.z);
        const landed = e.damage(this, b.damage, _v, 'bullet');
        if (landed) this.runStats.shotsHit++;
        if (!e.alive && stats.deathBlast > 0) this.deathBlast(e.pos, stats.deathBlast);
        b.hit.push(e);
        if (b.pierce > 0 && e.vulnerable) b.pierce--;
        else {
          b.active = false;
          break;
        }
      }
    }
    if (!p.alive) return;
    // enemy bullets -> player
    const pr = p.radius * 0.65;
    for (const b of this.enemyBullets.items) {
      if (!b.active) continue;
      const r = pr + b.radius * 0.85;
      if ((b.x - p.pos.x) ** 2 + (b.z - p.pos.z) ** 2 < r * r) {
        if (p.hurt(this, _v.set(b.x, 0, b.z))) b.active = false;
      }
    }
    // bodies
    for (const e of this.enemies) {
      if (!e.alive || !e.collidable) continue;
      if (p.dashing && stats.dashDamage > 0 && this.dashHits.get(e) !== p.dashId) {
        if (distToSegmentSq(e.pos, p.dashFrom, p.dashTo) < (e.radius + 0.9) ** 2) {
          this.dashHits.set(e, p.dashId);
          e.damage(this, stats.dashDamage * stats.damage, p.pos, 'dash');
          if (!e.alive && stats.deathBlast > 0) this.deathBlast(e.pos, stats.deathBlast);
          continue;
        }
      }
      if (!e.contactDamage) continue;
      const r = e.radius + p.radius * 0.75;
      if (e.pos.distanceToSquared(p.pos) < r * r) p.hurt(this, e.pos);
    }
  }

  private deathBlast(pos: THREE.Vector3, radius: number) {
    const c = pos.clone();
    this.bus.emit('explosion', { pos: c, color: 0x9ffcff, size: radius * 0.6 });
    for (const o of this.enemies) {
      if (o.alive && o.collidable && o.pos.distanceToSquared(c) < radius * radius) o.damage(this, this.player.stats.damage * 1.5, c, 'blast');
    }
  }

  private updateCamera(realDt: number) {
    const p = this.player.pos;
    // lean toward aim so you can see where you shoot
    _v.subVectors(this.aimPoint, p).setY(0).clampLength(0, 8).multiplyScalar(0.25);
    this.camTarget.lerp(_v.add(p).multiplyScalar(0.7), 1 - Math.exp(-5 * realDt));
    const zoom = this.boss ? 1.12 : 1;
    this.camera.position.set(this.camTarget.x, 30 * zoom, this.camTarget.z + 17 * zoom).add(this.vfx.shakeOffset);
    this.camera.lookAt(this.camTarget.x + this.vfx.shakeOffset.x * 0.5, 0, this.camTarget.z + this.vfx.shakeOffset.z * 0.5);
  }

  private resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this.vfx.resize(innerWidth, innerHeight);
  }
}
