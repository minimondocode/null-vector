import { settings } from '../core/Settings';
import type { GameState } from '../core/EventBus';
import type { Game } from '../game/Game';
import type { SectorTheme } from '../game/config';
import { Banners } from './Banners';
import { Crosshair } from './Crosshair';
import { h, hexCss, hexRgb } from './dom';
import { HUD } from './HUD';
import { Popups } from './Popups';
import { EndScreen } from './screens/End';
import { PauseScreen } from './screens/Pause';
import { TitleScreen } from './screens/Title';
import { UpgradeScreen } from './screens/Upgrade';
import { isEndlessUnlocked, unlockEndless } from './storage';
import { Kit, type Screen, type UIContext } from './widgets';

/**
 * DOM HUD + menus over the canvas. Drives the game only through Game's public API.
 * Layers (bottom→top): HUD, popups, banners, overlay (screen stack), toasts, crosshair.
 */
export class UI implements UIContext {
  kit: Kit;
  private root: HTMLElement;
  private overlay: HTMLElement;
  private toasts: HTMLElement;
  private hud: HUD;
  private banners: Banners;
  private popups: Popups;
  private crosshair: Crosshair;
  private stack: Screen[] = [];
  private lastState: GameState | '' = '';
  private lastTheme: SectorTheme | null = null;
  private endlessJustUnlocked = false;

  constructor(public game: Game) {
    this.root = document.getElementById('ui')!;
    this.root.innerHTML = '';
    this.kit = new Kit(game.bus);
    this.hud = new HUD(game);
    this.popups = new Popups(game);
    this.banners = new Banners(game);
    this.crosshair = new Crosshair(game);
    this.overlay = h('div', 'overlay');
    this.toasts = h('div', 'toasts');
    this.root.append(this.hud.el, this.popups.el, this.banners.el, this.overlay, this.toasts, this.crosshair.el);

    // keep focus off buttons (keyboard nav is ours) but let text inputs / sliders work
    this.overlay.addEventListener('mousedown', (e) => {
      const t = e.target as HTMLElement;
      if (!t.closest('input, .sl-track')) e.preventDefault();
    });
    window.addEventListener('keydown', (e) => this.onKey(e), true);

    game.bus.on('victory', () => this.markVictory());
    game.bus.on('sectorStart', () => this.syncTheme(true));

    this.applySettings();
    settings.onChange(() => this.applySettings());
  }

  get bus() {
    return this.game.bus;
  }

  // ---------------- UIContext ----------------

  push(screen: Screen) {
    const top = this.stack[this.stack.length - 1];
    top?.el.classList.add('buried');
    this.stack.push(screen);
    this.overlay.appendChild(screen.el);
    this.overlay.classList.toggle('has-sub', this.stack.length > 1);
  }

  pop() {
    if (this.stack.length <= 1) return;
    const s = this.stack.pop()!;
    s.destroy();
    s.el.remove();
    this.kit.click();
    this.stack[this.stack.length - 1]?.el.classList.remove('buried');
    this.overlay.classList.toggle('has-sub', this.stack.length > 1);
  }

  toast(msg: string, kind: 'ok' | 'warn' = 'ok') {
    const el = h('div', `toast ${kind}`);
    el.textContent = msg;
    this.toasts.appendChild(el);
    while (this.toasts.children.length > 3) this.toasts.firstElementChild!.remove();
    setTimeout(() => el.classList.add('out'), 2000);
    setTimeout(() => el.remove(), 2500);
  }

  // ---------------- frame ----------------

  update(realDt: number) {
    const g = this.game;
    if (g.state !== this.lastState) this.onState(this.lastState, g.state);
    this.syncTheme(false);

    this.hud.update(realDt);
    this.banners.update(realDt);
    this.popups.update(realDt);
    this.crosshair.update(realDt);
    for (const s of this.stack) s.update(realDt);
  }

  private onState(from: GameState | '', to: GameState) {
    this.lastState = to;
    this.clearStack();
    const inRun = to === 'playing' || to === 'upgrade' || to === 'paused';
    this.hud.setVisible(inRun, to !== 'playing');
    if (!inRun) this.banners.clear();
    this.root.dataset.state = to;
    this.overlay.dataset.state = to;

    let base: Screen | null = null;
    switch (to) {
      case 'title':
        base = new TitleScreen(this);
        break;
      case 'upgrade':
        base = new UpgradeScreen(this);
        break;
      case 'paused':
        base = new PauseScreen(this);
        break;
      case 'gameover':
        base = new EndScreen(this, false, false);
        break;
      case 'victory': {
        const just = this.markVictory();
        base = new EndScreen(this, true, just || this.endlessJustUnlocked);
        this.endlessJustUnlocked = false;
        break;
      }
    }
    this.overlay.classList.toggle('open', !!base);
    if (base) this.push(base);
  }

  /** Persists the endless unlock. Returns true if this victory unlocked it. */
  private markVictory(): boolean {
    if (this.game.mode !== 'campaign' || isEndlessUnlocked()) return false;
    unlockEndless();
    this.endlessJustUnlocked = true;
    return true;
  }

  private clearStack() {
    for (const s of this.stack) {
      s.destroy();
      s.el.remove();
    }
    this.stack.length = 0;
    this.overlay.classList.remove('has-sub');
  }

  private onKey(e: KeyboardEvent) {
    const st = this.game.state;
    if (st === 'playing') return;
    const top = this.stack[this.stack.length - 1];
    if (!top) return;
    const inInput = e.target instanceof HTMLInputElement;
    const isBack = e.code === 'Escape' || (e.code === 'KeyP' && !inInput) || (e.code === 'Backspace' && !inInput);
    if (isBack) {
      if (this.stack.length > 1) {
        // submenu: go back one level, and keep Game from also toggling pause
        this.pop();
        e.preventDefault();
        e.stopImmediatePropagation();
      } else if (inInput && e.code === 'Escape') {
        (e.target as HTMLInputElement).blur();
        e.stopImmediatePropagation();
      }
      // base screen: let Game handle Esc/P (paused -> resume, upgrade -> pause)
      return;
    }
    if (top.onKey(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  private syncTheme(force: boolean) {
    const t = this.game.theme;
    if (!force && t === this.lastTheme) return;
    this.lastTheme = t;
    const s = this.root.style;
    s.setProperty('--c1', hexCss(t.primary));
    s.setProperty('--c1-rgb', hexRgb(t.primary));
    s.setProperty('--c2', hexCss(t.secondary));
    s.setProperty('--c2-rgb', hexRgb(t.secondary));
    s.setProperty('--c-enemy', hexCss(t.enemy));
    s.setProperty('--c-enemy-rgb', hexRgb(t.enemy));
  }

  private applySettings() {
    const d = settings.data;
    this.root.classList.toggle('reduce-flash', !d.flashes);
    this.root.classList.toggle('cb', d.colorblind);
  }
}
