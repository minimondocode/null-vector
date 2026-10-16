import type { UpgradeDef } from '../../game/Upgrades';
import { esc, h } from '../dom';
import { S } from '../strings';
import { Nav, Screen, header, type UIContext } from '../widgets';

/** Tuning: seconds before picks are accepted (avoids accidental picks while firing). */
const INPUT_DELAY = 0.45;
/** Seconds the chosen card animates before gameplay resumes. */
const CONFIRM_DELAY = 0.24;

export class UpgradeScreen extends Screen {
  private t = 0;
  private picked = false;
  private offer: UpgradeDef[];
  private pending: { id: string; t: number } | null = null;

  constructor(private ctx: UIContext) {
    super('upgrade-screen');
    const { game, bus } = ctx;
    this.offer = game.currentOffer.slice();
    this.el.innerHTML = `${header(S.upgrade.title, S.upgrade.subtitle)}<div class="cards"></div><div class="up-hint">${esc(S.upgrade.hint)}</div>`;
    const cards = this.el.querySelector('.cards') as HTMLElement;
    const nav = (this.nav = new Nav(bus, 'horizontal'));
    this.offer.forEach((u, i) => {
      const owned = game.ownedUpgrades.get(u.id) ?? 0;
      const max = u.maxStacks ?? 99;
      const el = h(
        'div',
        `card r-${u.rarity}`,
        `<div class="card-in">
          <div class="card-top"><span class="card-key">${i + 1}</span><span class="card-rarity">${esc(S.upgrade.rarity[u.rarity] ?? u.rarity)}</span></div>
          <div class="card-glyph">${esc(u.glyph)}</div>
          <div class="card-name">${esc(u.name)}</div>
          <div class="card-desc">${esc(u.description)}</div>
          <div class="card-foot">${owned > 0 ? `<span class="lvl">${esc(S.upgrade.level(owned, max))}</span>${pips(owned, max)}` : `<span class="new">${esc(S.upgrade.newModule)}</span>`}</div>
        </div><div class="card-shine"></div>`,
      );
      el.style.setProperty('--d', `${i * 0.09}s`);
      el.addEventListener('mousemove', (e) => {
        const r = el.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        el.style.setProperty('--rx', `${(-y * 10).toFixed(2)}deg`);
        el.style.setProperty('--ry', `${(x * 12).toFixed(2)}deg`);
        el.style.setProperty('--mx', `${((x + 0.5) * 100).toFixed(1)}%`);
      });
      el.addEventListener('mouseleave', () => {
        el.style.setProperty('--rx', '0deg');
        el.style.setProperty('--ry', '0deg');
      });
      const item = { el, activate: () => this.pick(i) };
      el.addEventListener('click', () => item.activate());
      cards.appendChild(nav.add(item).el);
    });
    // start with the middle card highlighted only once the player touches the keys
    nav.items[0]?.el.classList.remove('sel');
    nav.index = -1;
    this.el.classList.add('locked');
  }

  private pick(i: number) {
    if (this.picked || this.t < INPUT_DELAY) return;
    const u = this.offer[i];
    if (!u) return;
    this.picked = true;
    this.ctx.kit.click();
    const cards = this.nav!.items;
    cards.forEach((c, j) => c.el.classList.add(j === i ? 'chosen' : 'rejected'));
    this.el.classList.add('done');
    this.pending = { id: u.id, t: CONFIRM_DELAY };
  }

  onKey(e: KeyboardEvent): boolean {
    const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
    if (m) {
      const i = Number(m[1]) - 1;
      if (i < this.offer.length) {
        this.nav!.select(i);
        this.pick(i);
      }
      return true;
    }
    if (this.t < INPUT_DELAY) return ['Enter', 'Space', 'NumpadEnter'].includes(e.code);
    if (this.nav!.index < 0 && /Arrow|Key[WASD]/.test(e.code)) {
      this.nav!.select(e.code === 'ArrowLeft' || e.code === 'KeyA' ? 0 : Math.min(1, this.offer.length - 1));
      return true;
    }
    return super.onKey(e);
  }

  update(dt: number) {
    const before = this.t < INPUT_DELAY;
    this.t += dt;
    if (before && this.t >= INPUT_DELAY) this.el.classList.remove('locked');
    if (this.pending) {
      this.pending.t -= dt;
      if (this.pending.t <= 0) {
        const id = this.pending.id;
        this.pending = null;
        this.ctx.game.chooseUpgrade(id);
      }
    }
  }
}

function pips(n: number, max: number): string {
  if (max > 8) return '';
  let s = '<span class="lv-pips">';
  for (let i = 0; i < max; i++) s += `<i class="${i < n ? 'on' : i === n ? 'next' : ''}"></i>`;
  return s + '</span>';
}
