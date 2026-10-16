import type { Game } from '../game/Game';

/**
 * STUB HUD/menus — replaced by the full UI pass. Keep: constructor(game), update(realDt).
 * The UI drives the game only through Game's public API (startRun, pause, resume, quitToTitle, chooseUpgrade).
 */
export class UI {
  private root: HTMLElement;
  private hud: HTMLElement;
  private overlay: HTMLElement;
  private lastState = '';

  constructor(private game: Game) {
    this.root = document.getElementById('ui')!;
    this.root.innerHTML = `<div class="hud"></div><div class="overlay"></div>`;
    this.hud = this.root.querySelector('.hud')!;
    this.overlay = this.root.querySelector('.overlay')!;
    this.overlay.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
      if (!t) return;
      const a = t.dataset.action!;
      if (a === 'start') game.startRun('campaign');
      if (a === 'resume') game.resume();
      if (a === 'title') game.quitToTitle();
      if (a === 'upgrade') game.chooseUpgrade(t.dataset.id!);
    });
  }

  update(_dt: number) {
    const g = this.game;
    if (g.state !== this.lastState) {
      this.lastState = g.state;
      this.renderOverlay();
    }
    this.hud.style.display = g.state === 'title' ? 'none' : 'block';
    this.hud.textContent = `HP ${g.player.hp}/${g.player.stats.maxHp}  SCORE ${g.score}  x${g.multiplier}  OD ${Math.round(g.overdrive * 100)}%  ${g.boss ? g.boss.name + ' ' + Math.round(g.boss.health() * 100) + '%' : ''}`;
  }

  private renderOverlay() {
    const g = this.game;
    const o = this.overlay;
    o.style.display = g.state === 'playing' ? 'none' : 'flex';
    if (g.state === 'title') o.innerHTML = `<h1>NULL VECTOR</h1><button data-action="start">START</button>`;
    if (g.state === 'paused') o.innerHTML = `<h2>PAUSED</h2><button data-action="resume">RESUME</button><button data-action="title">QUIT</button>`;
    if (g.state === 'gameover') o.innerHTML = `<h2>PROCESS TERMINATED</h2><p>${g.score}</p><button data-action="start">RETRY</button><button data-action="title">TITLE</button>`;
    if (g.state === 'victory') o.innerHTML = `<h2>SYSTEM PURGED</h2><p>${g.score}</p><button data-action="title">TITLE</button>`;
    if (g.state === 'upgrade')
      o.innerHTML = `<h2>SELECT PATCH</h2><div class="cards">${g.currentOffer
        .map((u) => `<button data-action="upgrade" data-id="${u.id}"><b>${u.name}</b><br>${u.description}</button>`)
        .join('')}</div>`;
  }
}
