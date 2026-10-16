import type * as THREE from 'three';
import type { EventBus, GameMode, GameState } from '../core/EventBus';
import type { Input } from '../core/Input';
import type { Arena } from './Arena';
import type { DifficultyParams, SectorTheme } from './config';
import type { BulletPool } from './Bullets';
import type { Player } from './Player';
import type { VFX } from '../vfx/VFX';

export type DamageSource = 'bullet' | 'dash' | 'blast' | 'overdrive';

/** Anything updated each frame in world time (boss controllers, hazards, pickups...). */
export interface Entity {
  alive: boolean;
  update(ctx: GameContext, dt: number): void;
  dispose(): void;
}

/** A damageable hostile body. Multi-part bosses register one Enemy per hittable part. */
export interface Enemy extends Entity {
  kind: string;
  /** XZ position; y is visual only. */
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  radius: number;
  hp: number;
  maxHp: number;
  /** False while spawning/phasing: bullets pass through, no contact damage. */
  collidable: boolean;
  /** Touching the player hurts them. */
  contactDamage: boolean;
  /** If false, bullets hit and are consumed but deal no damage (shields, armored segments). */
  vulnerable: boolean;
  scoreValue: number;
  color: number;
  isBoss: boolean;
  /** Counts toward "wave cleared". Boss minions / hazards may set false. */
  countsForWave: boolean;
  object: THREE.Object3D;
  /** Apply damage. `from` = position of the damage source. Returns true if it landed. */
  damage(ctx: GameContext, amount: number, from: THREE.Vector3, source: DamageSource): boolean;
}

/** Shown as the big boss bar in the HUD. */
export interface BossInfo {
  name: string;
  title: string;
  /** 0..1 */
  health(): number;
  phase: number;
  phases: number;
}

export interface GameContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  bus: EventBus;
  input: Input;
  arena: Arena;
  vfx: VFX;
  player: Player;
  enemies: Enemy[];
  entities: Entity[];
  playerBullets: BulletPool;
  enemyBullets: BulletPool;
  difficulty: DifficultyParams;
  theme: SectorTheme;
  mode: GameMode;
  state: GameState;
  /** Current sector index (campaign) or loop count (endless). */
  sector: number;
  /** World time in seconds (affected by slow motion). */
  time: number;
  /** Real seconds since run start. */
  runTime: number;
  /** World-time multiplier (overdrive slow-mo, hit-stop). Player ignores it. */
  timeScale: number;
  score: number;
  multiplier: number;
  /** 0..1 */
  overdrive: number;
  overdriveActive: boolean;
  boss: BossInfo | null;
  /** Kill count this run. */
  kills: number;

  addEnemy(e: Enemy): void;
  addEntity(e: Entity): void;
  setBoss(info: BossInfo | null): void;
  setTheme(theme: SectorTheme): void;
  /** Pause gameplay and show 1-of-3 upgrade picker. `onDone` runs after the pick. */
  offerUpgrades(onDone?: () => void): void;
  /** Brief freeze for impact (seconds, real time). */
  hitStop(seconds: number): void;
  /** Campaign finished. */
  victory(): void;
  /** Point on the gameplay plane under the mouse. */
  aimPoint: THREE.Vector3;
}
