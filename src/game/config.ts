import type { Difficulty } from '../core/Settings';

export type ArenaShape = 'square' | 'circle' | 'hex';

export interface SectorTheme {
  id: string;
  /** Display name, e.g. "SECTOR 01 // PERIMETER". */
  name: string;
  subtitle: string;
  primary: number; // grid / arena lines
  secondary: number; // accents
  enemy: number; // default enemy tint
  background: number; // clear colour / fog
  arenaShape: ArenaShape;
  /** Half-extent (square) or radius (circle/hex) in world units. */
  arenaSize: number;
  bossId: 'firewall' | 'hydra' | 'root';
  /** Music tempo for this sector. */
  bpm: number;
}

export const SECTORS: SectorTheme[] = [
  {
    id: 's1',
    name: 'SECTOR 01',
    subtitle: 'PERIMETER',
    primary: 0x00e5ff,
    secondary: 0x2b6bff,
    enemy: 0xff3d7f,
    background: 0x02040c,
    arenaShape: 'square',
    arenaSize: 22,
    bossId: 'firewall',
    bpm: 120,
  },
  {
    id: 's2',
    name: 'SECTOR 02',
    subtitle: 'DEEP CACHE',
    primary: 0xff2bd6,
    secondary: 0x8a2bff,
    enemy: 0x39ff8b,
    background: 0x07020c,
    arenaShape: 'hex',
    arenaSize: 24,
    bossId: 'hydra',
    bpm: 128,
  },
  {
    id: 's3',
    name: 'SECTOR 03',
    subtitle: 'ROOT ACCESS',
    primary: 0xffb000,
    secondary: 0xff3b1f,
    enemy: 0x7df9ff,
    background: 0x0c0402,
    arenaShape: 'circle',
    arenaSize: 25,
    bossId: 'root',
    bpm: 136,
  },
];

/** Endless mode cycles palettes; this is its own look. */
export const ENDLESS_THEME: SectorTheme = {
  id: 'endless',
  name: 'ENDLESS',
  subtitle: 'NULL SPACE',
  primary: 0xb8ff2b,
  secondary: 0x00e5ff,
  enemy: 0xff3d7f,
  background: 0x030603,
  arenaShape: 'square',
  arenaSize: 24,
  bossId: 'firewall',
  bpm: 132,
};

export interface DifficultyParams {
  enemyHp: number;
  enemySpeed: number;
  enemyFireRate: number;
  enemyBulletSpeed: number;
  spawnCount: number;
  /** Damage the player takes per hit, in HP pips. */
  damageTaken: number;
  playerMaxHp: number;
}

export const DIFFICULTY: Record<Difficulty, DifficultyParams> = {
  easy: { enemyHp: 0.75, enemySpeed: 0.85, enemyFireRate: 0.7, enemyBulletSpeed: 0.8, spawnCount: 0.75, damageTaken: 1, playerMaxHp: 7 },
  normal: { enemyHp: 1, enemySpeed: 1, enemyFireRate: 1, enemyBulletSpeed: 1, spawnCount: 1, damageTaken: 1, playerMaxHp: 5 },
  hard: { enemyHp: 1.3, enemySpeed: 1.12, enemyFireRate: 1.35, enemyBulletSpeed: 1.15, spawnCount: 1.3, damageTaken: 1, playerMaxHp: 4 },
};

export const PLAYER_COLOR = 0x00ffe1;
export const PLAYER_BULLET_COLOR = 0x9ffcff;
export const ENEMY_BULLET_COLOR = 0xff4a2b;

/** World y of gameplay plane where ships hover. */
export const PLAY_Y = 0.6;
