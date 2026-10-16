export type Quality = 'low' | 'medium' | 'high' | 'ultra';
export type Difficulty = 'easy' | 'normal' | 'hard';

export interface SettingsData {
  quality: Quality;
  /** Set to false once the user picks a quality manually. */
  autoQuality: boolean;
  /** 0..1 multiplier on all camera shake. */
  screenShake: number;
  /** Full-screen flashes and strong chromatic aberration. */
  flashes: boolean;
  /** Adds high-contrast outlines / shape markers; enemies already differ by silhouette. */
  colorblind: boolean;
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  difficulty: Difficulty;
  showFps: boolean;
}

const KEY = 'null-vector:settings';

const defaults: SettingsData = {
  quality: 'high',
  autoQuality: true,
  screenShake: 1,
  flashes: true,
  colorblind: false,
  masterVolume: 0.8,
  musicVolume: 0.7,
  sfxVolume: 0.8,
  difficulty: 'normal',
  showFps: false,
};

type Listener = (s: SettingsData, changed: Partial<SettingsData>) => void;

class SettingsStore {
  data: SettingsData;
  private listeners = new Set<Listener>();

  constructor() {
    let stored: Partial<SettingsData> = {};
    try {
      stored = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    } catch {}
    this.data = { ...defaults, ...stored };
  }

  set(patch: Partial<SettingsData>) {
    Object.assign(this.data, patch);
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {}
    for (const l of this.listeners) l(this.data, patch);
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const settings = new SettingsStore();
