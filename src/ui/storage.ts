import type { GameMode } from '../core/EventBus';

/** Local persistence for highscores, callsign and the endless unlock. */

export interface ScoreEntry {
  name: string;
  score: number;
  difficulty: string;
  maxMult: number;
  time: number;
  date: number;
}

const MAX = 10;
const scoreKey = (mode: GameMode) => `null-vector:scores:${mode}`;
const UNLOCK_KEY = 'null-vector:endless-unlocked';
const NAME_KEY = 'null-vector:callsign';

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function write(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
}

export function loadScores(mode: GameMode): ScoreEntry[] {
  const list = read<ScoreEntry[]>(scoreKey(mode), []);
  return Array.isArray(list) ? list.filter((e) => e && typeof e.score === 'number').slice(0, MAX) : [];
}

/** 0-based rank the score would get, or -1 if it does not make the table. */
export function rankFor(mode: GameMode, score: number): number {
  if (score <= 0) return -1;
  const list = loadScores(mode);
  let i = list.findIndex((e) => score > e.score);
  if (i < 0) i = list.length;
  return i < MAX ? i : -1;
}

/** Inserts and returns the 0-based rank (-1 if it fell off). */
export function insertScore(mode: GameMode, entry: ScoreEntry): number {
  const list = loadScores(mode);
  list.push(entry);
  list.sort((a, b) => b.score - a.score || a.date - b.date);
  const trimmed = list.slice(0, MAX);
  write(scoreKey(mode), trimmed);
  return trimmed.indexOf(entry);
}

export function isEndlessUnlocked(): boolean {
  return read<boolean>(UNLOCK_KEY, false) === true;
}
export function unlockEndless() {
  write(UNLOCK_KEY, true);
}

export function lastCallsign(): string {
  const n = read<string>(NAME_KEY, '');
  return typeof n === 'string' ? n : '';
}
export function saveCallsign(name: string) {
  write(NAME_KEY, name);
}

export function sanitizeName(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9_\-.]/g, '').slice(0, 8);
}
