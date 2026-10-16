import type { Game } from '../game/Game';
import { h, q, retrigger, scramble } from './dom';
import { HUD } from './HUD';
import { S } from './strings';

type Lane = 'big' | 'small';
type Kind = 'sector' | 'wave' | 'cleared' | 'warning' | 'purged' | 'killed';

interface Active {
  title: string;
  sub: string;
  t: number;
  dur: number;
  reveal: number;
}

/** Tuning: seconds on screen per banner kind. */
const DURATION: Record<Kind, number> = { sector: 3.4, wave: 1.9, cleared: 1.7, warning: 3.6, purged: 3.2, killed: 2.6 };

/**
 * Centre-screen announcements with a terminal "decode" reveal.
 * Two lanes so a sector title and its first wave can coexist.
 */
export class Banners {
  el: HTMLElement;
  private lanes: Record<Lane, { el: HTMLElement; title: HTMLElement; sub: HTMLElement; a: Active | null }>;

  constructor(private game: Game) {
    this.el = h('div', 'banners');
    const mk = (lane: Lane) => {
      const el = h('div', `banner lane-${lane}`, `<div class="b-stripes"></div><div class="b-title"></div><div class="b-sub"></div><div class="b-stripes bottom"></div>`);
      this.el.appendChild(el);
      return { el, title: q(el, '.b-title'), sub: q(el, '.b-sub'), a: null as Active | null };
    };
    this.lanes = { big: mk('big'), small: mk('small') };

    const bus = game.bus;
    bus.on('sectorStart', (s) => {
      const { title, sub } = HUD.sectorTitle(s.name, s.sector, game);
      this.show('big', 'sector', title, sub);
    });
    bus.on('waveStart', (w) => {
      // HUD resolves 0/1-based indexing; read its interpretation via a fresh calc
      const zero = w.wave === 0 || this.zeroBased;
      if (w.wave === 0) this.zeroBased = true;
      const n = w.wave + (zero ? 1 : 0);
      this.show('small', 'wave', w.totalWaves > 0 ? S.hud.wave(n, w.totalWaves) : S.hud.waveOnly(n), '');
    });
    bus.on('waveCleared', () => this.show('small', 'cleared', S.banner.waveCleared, S.banner.waveSub));
    bus.on('bossWarning', (b) => this.show('big', 'warning', S.banner.warning, `${b.name}${b.title ? ' // ' + b.title : ''}`));
    bus.on('sectorCleared', () => this.show('big', 'purged', S.banner.sectorPurged, S.banner.sectorPurgedSub));
    bus.on('bossKilled', (b) => this.show('small', 'killed', S.banner.bossKilled(b.name), S.banner.bossKilledSub));
    bus.on('runStart', () => {
      this.zeroBased = false;
      this.clear();
    });
  }

  private zeroBased = false;

  show(lane: Lane, kind: Kind, title: string, sub: string) {
    const L = this.lanes[lane];
    // a boss warning must not be stomped by a lower-priority big banner
    if (L.a && L.el.dataset.kind === 'warning' && kind !== 'warning' && L.a.t < L.a.dur * 0.8) return;
    L.el.dataset.kind = kind;
    L.a = { title, sub, t: 0, dur: DURATION[kind], reveal: Math.min(0.7, 0.03 * title.length + 0.15) };
    L.title.textContent = '';
    L.sub.textContent = '';
    retrigger(L.el, 'show');
  }

  clear() {
    for (const L of Object.values(this.lanes)) {
      L.a = null;
      L.el.classList.remove('show');
    }
  }

  update(dt: number) {
    for (const L of Object.values(this.lanes)) {
      const a = L.a;
      if (!a) continue;
      a.t += dt;
      if (a.t < a.reveal + 0.5) {
        L.title.textContent = scramble(a.title, a.t / a.reveal);
        L.sub.textContent = scramble(a.sub, (a.t - a.reveal * 0.5) / (a.reveal + 0.2), 2);
      }
      if (a.t >= a.dur) {
        L.a = null;
        L.el.classList.remove('show');
      }
    }
  }
}
