import type { EventBus } from '../core/EventBus';
import type { Game } from '../game/Game';
import { clamp01, esc, h, retrigger } from './dom';
import { S } from './strings';

/** Shared services the screens use. Implemented by UI. */
export interface UIContext {
  game: Game;
  bus: EventBus;
  kit: Kit;
  push(screen: Screen): void;
  pop(): void;
  toast(msg: string, kind?: 'ok' | 'warn'): void;
}

export interface NavItem {
  el: HTMLElement;
  activate?(): void;
  adjust?(dir: number): void;
  refresh?(): void;
}

/** Keyboard/mouse focus ring over a list of interactive items. */
export class Nav {
  items: NavItem[] = [];
  index = -1;

  constructor(
    private bus: EventBus,
    private orientation: 'vertical' | 'horizontal' = 'vertical',
  ) {}

  add<T extends NavItem>(item: T): T {
    const i = this.items.length;
    this.items.push(item);
    item.el.classList.add('nav-item');
    item.el.addEventListener('mouseenter', () => this.select(i));
    if (i === 0) this.select(0, true);
    return item;
  }

  select(i: number, silent = false) {
    if (i === this.index) return;
    this.items[this.index]?.el.classList.remove('sel');
    this.index = i;
    this.items[i]?.el.classList.add('sel');
    if (!silent) this.bus.emit('uiHover', {});
  }

  move(d: number) {
    const n = this.items.length;
    if (!n) return;
    this.select((((this.index + d) % n) + n) % n);
  }

  handleKey(e: KeyboardEvent): boolean {
    const c = e.code;
    const up = c === 'ArrowUp' || c === 'KeyW';
    const down = c === 'ArrowDown' || c === 'KeyS';
    const left = c === 'ArrowLeft' || c === 'KeyA';
    const right = c === 'ArrowRight' || c === 'KeyD';
    const vertical = this.orientation === 'vertical';
    if (vertical ? up : left || up) return this.move(-1), true;
    if (vertical ? down : right || down) return this.move(1), true;
    if (vertical && (left || right)) {
      const it = this.items[this.index];
      if (it?.adjust) {
        it.adjust(left ? -1 : 1);
        return true;
      }
      return false;
    }
    if (c === 'Enter' || c === 'NumpadEnter' || c === 'Space') {
      if (e.repeat) return true;
      this.items[this.index]?.activate?.();
      return true;
    }
    return false;
  }

  refresh() {
    for (const it of this.items) it.refresh?.();
  }
}

/** A stacked overlay page. */
export abstract class Screen {
  el: HTMLElement;
  nav?: Nav;
  constructor(cls: string) {
    this.el = h('div', `screen ${cls}`);
  }
  onKey(e: KeyboardEvent): boolean {
    return this.nav?.handleKey(e) ?? false;
  }
  update(_dt: number) {}
  destroy() {}
}

interface ButtonOpts {
  cls?: string;
  hint?: string;
  glyph?: string;
}

/** Widget factory: buttons, choices, toggles, sliders. All emit uiClick/uiHover. */
export class Kit {
  constructor(private bus: EventBus) {}

  click() {
    this.bus.emit('uiClick', {});
  }

  button(label: string, fn: () => void, opts: ButtonOpts = {}): NavItem & { setLabel(s: string): void } {
    const el = h('button', `btn ${opts.cls ?? ''}`);
    el.type = 'button';
    el.innerHTML = `<span class="btn-caret">&gt;</span><span class="btn-label">${esc(label)}</span>${
      opts.glyph ? `<span class="btn-glyph">${esc(opts.glyph)}</span>` : ''
    }${opts.hint ? `<span class="btn-hint">${esc(opts.hint)}</span>` : ''}`;
    const lab = el.querySelector('.btn-label') as HTMLElement;
    const item = {
      el,
      activate: () => {
        this.click();
        retrigger(el, 'pressed');
        fn();
      },
      setLabel: (s: string) => (lab.textContent = s),
    };
    el.addEventListener('click', () => item.activate());
    return item;
  }

  /** Two-step button: first activation arms ("CONFIRM?"), second runs. */
  confirmButton(label: string, fn: () => void, opts: ButtonOpts = {}): NavItem {
    let armed = false;
    let timer = 0;
    const b = this.button(
      label,
      () => {
        if (armed) {
          clearTimeout(timer);
          fn();
          return;
        }
        armed = true;
        b.el.classList.add('armed');
        b.setLabel(`${label} — ${S.pause.confirm}`);
        timer = window.setTimeout(() => {
          armed = false;
          b.el.classList.remove('armed');
          b.setLabel(label);
        }, 2500);
      },
      opts,
    );
    return b;
  }

  choice<T extends string>(label: string, options: { value: T; label: string }[], get: () => T, set: (v: T) => void): NavItem {
    const el = h('div', 'opt-row');
    el.innerHTML = `<span class="opt-label">${esc(label)}</span><div class="choice"><span class="ch-arrow l">◀</span>${options
      .map((o, i) => `<span class="ch" data-i="${i}">${esc(o.label)}</span>`)
      .join('')}<span class="ch-arrow r">▶</span></div>`;
    const chs = [...el.querySelectorAll<HTMLElement>('.ch')];
    const idx = () => Math.max(0, options.findIndex((o) => o.value === get()));
    const setIdx = (i: number) => {
      const n = options.length;
      const j = ((i % n) + n) % n;
      if (options[j].value !== get()) {
        set(options[j].value);
        this.bus.emit('uiHover', {});
      }
      item.refresh!();
    };
    const item: NavItem = {
      el,
      activate: () => {
        this.click();
        setIdx(idx() + 1);
      },
      adjust: (d) => setIdx(idx() + d),
      refresh: () => chs.forEach((c, i) => c.classList.toggle('on', i === idx())),
    };
    chs.forEach((c, i) =>
      c.addEventListener('click', () => {
        this.click();
        setIdx(i);
      }),
    );
    el.querySelector('.ch-arrow.l')!.addEventListener('click', () => item.adjust!(-1));
    el.querySelector('.ch-arrow.r')!.addEventListener('click', () => item.adjust!(1));
    item.refresh!();
    return item;
  }

  toggle(label: string, get: () => boolean, set: (v: boolean) => void): NavItem {
    const el = h('div', 'opt-row');
    el.innerHTML = `<span class="opt-label">${esc(label)}</span><div class="toggle"><span class="tg-track"><span class="tg-knob"></span></span><span class="tg-text"></span></div>`;
    const text = el.querySelector('.tg-text') as HTMLElement;
    const flip = () => {
      this.click();
      set(!get());
      item.refresh!();
    };
    const item: NavItem = {
      el,
      activate: flip,
      adjust: flip,
      refresh: () => {
        const on = get();
        el.classList.toggle('on', on);
        text.textContent = on ? S.common.on : S.common.off;
      },
    };
    el.addEventListener('click', flip);
    item.refresh!();
    return item;
  }

  slider(label: string, get: () => number, set: (v: number) => void, step = 0.05): NavItem {
    const el = h('div', 'opt-row');
    el.innerHTML = `<span class="opt-label">${esc(label)}</span><div class="slider"><div class="sl-track"><i class="sl-fill"></i><i class="sl-thumb"></i></div><span class="sl-val"></span></div>`;
    const track = el.querySelector('.sl-track') as HTMLElement;
    const fill = el.querySelector('.sl-fill') as HTMLElement;
    const thumb = el.querySelector('.sl-thumb') as HTMLElement;
    const val = el.querySelector('.sl-val') as HTMLElement;
    let lastTick = -1;
    const apply = (v: number) => {
      v = Math.round(clamp01(v) * 100) / 100;
      if (v !== get()) set(v);
      const tick = Math.round(v * 20);
      if (tick !== lastTick) {
        if (lastTick >= 0) this.bus.emit('uiHover', {});
        lastTick = tick;
      }
      item.refresh!();
    };
    const item: NavItem = {
      el,
      activate: () => {},
      adjust: (d) => apply(get() + d * step),
      refresh: () => {
        const v = clamp01(get());
        fill.style.transform = `scaleX(${v})`;
        thumb.style.left = `${v * 100}%`;
        val.textContent = `${Math.round(v * 100)}%`;
      },
    };
    const fromPointer = (e: PointerEvent) => {
      const r = track.getBoundingClientRect();
      apply((e.clientX - r.left) / r.width);
    };
    track.addEventListener('pointerdown', (e) => {
      track.setPointerCapture(e.pointerId);
      el.classList.add('drag');
      fromPointer(e);
    });
    track.addEventListener('pointermove', (e) => {
      if (track.hasPointerCapture(e.pointerId)) fromPointer(e);
    });
    const end = (e: PointerEvent) => {
      if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId);
      el.classList.remove('drag');
    };
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
    item.refresh!();
    return item;
  }
}

/** Standard screen header: glitchy title + terminal subtitle. */
export function header(title: string, sub: string, cls = ''): string {
  return `<header class="scr-head ${cls}"><h2 class="glitch" data-text="${esc(title)}">${esc(title)}</h2><div class="scr-sub">${esc(sub)}<span class="caret">_</span></div></header>`;
}
