import * as THREE from 'three';
import type { Game } from '../game/Game';
import { fmtInt, h, hexCss } from './dom';

/** Tuning knobs */
const POOL = 28;
const LIFE = 0.9;
const RISE = 70; // px over lifetime

interface Pop {
  el: HTMLElement;
  x: number;
  y: number;
  t: number;
  alive: boolean;
  big: boolean;
}

const _v = new THREE.Vector3();

/** Pooled floating "+score" labels at kill positions. */
export class Popups {
  el: HTMLElement;
  private pool: Pop[] = [];
  private next = 0;

  constructor(private game: Game) {
    this.el = h('div', 'popups');
    for (let i = 0; i < POOL; i++) {
      const el = h('div', 'pop');
      el.style.display = 'none';
      this.el.appendChild(el);
      this.pool.push({ el, x: 0, y: 0, t: 0, alive: false, big: false });
    }
    game.bus.on('enemyKilled', (e) => {
      if (game.state !== 'playing' || e.score <= 0) return;
      this.spawn(e.pos, Math.round(e.score * game.multiplier), e.color, e.size);
    });
    game.bus.on('runStart', () => this.clear());
    game.bus.on('stateChange', (s) => {
      if (s.to === 'title' || s.to === 'gameover' || s.to === 'victory') this.clear();
    });
  }

  spawn(pos: THREE.Vector3, value: number, color: number, size: number) {
    _v.copy(pos).project(this.game.camera);
    if (_v.z > 1 || Math.abs(_v.x) > 1.1 || Math.abs(_v.y) > 1.1) return;
    // prefer a dead slot, else recycle round-robin (oldest-ish)
    let p = this.pool.find((pp) => !pp.alive);
    if (!p) {
      p = this.pool[this.next];
      this.next = (this.next + 1) % POOL;
    }
    p.x = (_v.x * 0.5 + 0.5) * innerWidth;
    p.y = (-_v.y * 0.5 + 0.5) * innerHeight;
    p.t = 0;
    p.alive = true;
    p.big = size >= 2.5 || value >= 1000;
    p.el.textContent = `+${fmtInt(value)}`;
    p.el.className = p.big ? 'pop big' : 'pop';
    p.el.style.color = hexCss(color);
    p.el.style.display = '';
  }

  clear() {
    for (const p of this.pool) {
      p.alive = false;
      p.el.style.display = 'none';
    }
  }

  update(dt: number) {
    for (const p of this.pool) {
      if (!p.alive) continue;
      p.t += dt;
      const k = p.t / LIFE;
      if (k >= 1) {
        p.alive = false;
        p.el.style.display = 'none';
        continue;
      }
      const ease = 1 - (1 - k) * (1 - k);
      const s = k < 0.12 ? 0.6 + (k / 0.12) * 0.7 : 1.3 - Math.min(1, (k - 0.12) / 0.2) * 0.3;
      p.el.style.transform = `translate3d(${p.x}px, ${p.y - ease * RISE * (p.big ? 1.3 : 1)}px, 0) translate(-50%, -50%) scale(${s})`;
      p.el.style.opacity = String(k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1);
    }
  }
}
