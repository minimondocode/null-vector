import type * as THREE from 'three';

/** Every cross-module signal in the game. Gameplay emits, VFX / audio / UI listen. */
export type GameEvents = {
  stateChange: { from: GameState; to: GameState };
  runStart: { mode: GameMode };
  playerShoot: { pos: THREE.Vector3; dir: THREE.Vector3 };
  playerHit: { pos: THREE.Vector3; hp: number };
  playerHeal: { hp: number };
  playerDeath: { pos: THREE.Vector3 };
  playerDash: { pos: THREE.Vector3; dir: THREE.Vector3 };
  dashReady: {};
  enemySpawn: { pos: THREE.Vector3; kind: string };
  enemyHit: { pos: THREE.Vector3; kind: string; color: number };
  enemyKilled: { pos: THREE.Vector3; kind: string; color: number; size: number; score: number };
  enemyShoot: { pos: THREE.Vector3; kind: string };
  /** Generic explosion: drives particles, grid deformation, shake, sound. size ~ 1 small, 3 big, 6+ huge. */
  explosion: { pos: THREE.Vector3; color: number; size: number };
  comboChange: { multiplier: number; kills: number };
  comboLost: { multiplier: number };
  overdriveReady: {};
  overdriveStart: { pos: THREE.Vector3 };
  overdriveEnd: {};
  waveStart: { sector: number; wave: number; totalWaves: number };
  waveCleared: { sector: number; wave: number };
  sectorStart: { sector: number; name: string };
  sectorCleared: { sector: number };
  bossWarning: { name: string; title: string };
  bossSpawn: { name: string };
  bossPhase: { name: string; phase: number };
  bossKilled: { name: string; pos: THREE.Vector3 };
  upgradeOffer: { ids: string[] };
  upgradeChosen: { id: string };
  victory: {};
  /** 0..1 how intense the action is (enemy count, boss). Used by adaptive music. */
  intensity: { value: number };
  uiClick: {};
  uiHover: {};
};

export type GameState = 'title' | 'playing' | 'upgrade' | 'paused' | 'gameover' | 'victory';
export type GameMode = 'campaign' | 'endless';

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof GameEvents, Set<Handler<any>>>();

  on<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of set) fn(payload);
  }
}
