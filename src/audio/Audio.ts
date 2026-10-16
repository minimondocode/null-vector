import type { EventBus } from '../core/EventBus';
import type { SectorTheme } from '../game/config';

/** STUB — replaced by the full synth SFX + adaptive music engine. Keep this public API. */
export class Audio {
  constructor(_bus: EventBus) {}
  /** Must be called from a user gesture (click / key) to start the AudioContext. */
  unlock() {}
  setTheme(_theme: SectorTheme, _isBoss = false) {}
  update(_realDt: number) {}
}
