import type { Game } from '../game/Game';
import { h } from './dom';

/** Neon reticle that replaces the system cursor over the canvas during play. */
export class Crosshair {
  el: HTMLElement;
  private rot = 0;
  private scale = 1;
  private visible = false;
  private hitCooldown = 0;
  private hitmark: HTMLElement;

  constructor(private game: Game) {
    this.el = h(
      'div',
      'crosshair',
      `<div class="ch-spin"><i class="t t1"></i><i class="t t2"></i><i class="t t3"></i><i class="t t4"></i><i class="ring"></i></div><i class="dot"></i><div class="hitmark"></div>`,
    );
    this.hitmark = this.el.querySelector('.hitmark') as HTMLElement;
    game.bus.on('enemyHit', () => {
      if (this.hitCooldown > 0) return;
      this.hitCooldown = 0.06;
      this.hitmark.animate([{ opacity: 1, transform: 'translate(-50%,-50%) scale(1.25) rotate(45deg)' }, { opacity: 0, transform: 'translate(-50%,-50%) scale(0.8) rotate(45deg)' }], { duration: 140, easing: 'ease-out' });
    });
  }

  update(dt: number) {
    const g = this.game;
    const show = g.state === 'playing' && g.player.alive;
    if (show !== this.visible) {
      this.visible = show;
      this.el.classList.toggle('visible', show);
    }
    if (!show) return;
    this.hitCooldown -= dt;
    const firing = g.input.mouseLeft;
    this.rot = (this.rot + dt * (firing ? 420 : 40)) % 360;
    this.scale += ((firing ? 1.3 : 1) - this.scale) * Math.min(1, dt * 14);
    this.el.classList.toggle('firing', firing);
    this.el.classList.toggle('od', g.overdriveActive);
    this.el.style.transform = `translate3d(${g.input.mouseX}px, ${g.input.mouseY}px, 0)`;
    (this.el.firstElementChild as HTMLElement).style.transform = `rotate(${this.rot}deg) scale(${this.scale})`;
  }
}
