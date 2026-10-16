import { settings, type Quality } from '../../core/Settings';
import { esc, h } from '../dom';
import { S } from '../strings';
import { Nav, Screen, header, type NavItem, type UIContext } from '../widgets';

export class OptionsScreen extends Screen {
  private unsub: () => void;

  constructor(ctx: UIContext) {
    super('options-screen sub');
    const { kit, bus } = ctx;
    const d = () => settings.data;
    this.el.innerHTML = `<div class="panel frame">${header(S.options.title, S.options.subtitle)}<div class="opt-list"></div></div>`;
    const list = this.el.querySelector('.opt-list') as HTMLElement;
    const nav = (this.nav = new Nav(bus));
    const section = (t: string) => list.appendChild(h('div', 'opt-section', esc(t)));
    const add = (it: NavItem) => list.appendChild(nav.add(it).el);

    section(S.options.video);
    const qs: Quality[] = ['low', 'medium', 'high', 'ultra'];
    add(
      kit.choice(
        S.options.quality,
        qs.map((q) => ({ value: q, label: S.options.qualities[q] })),
        () => d().quality,
        (v) => settings.set({ quality: v, autoQuality: false }),
      ),
    );
    add(kit.toggle(S.options.autoQuality, () => d().autoQuality, (v) => settings.set({ autoQuality: v })));
    add(kit.toggle(S.options.showFps, () => d().showFps, (v) => settings.set({ showFps: v })));

    section(S.options.access);
    add(kit.slider(S.options.shake, () => d().screenShake, (v) => settings.set({ screenShake: v })));
    add(kit.toggle(S.options.flashes, () => d().flashes, (v) => settings.set({ flashes: v })));
    add(kit.toggle(S.options.colorblind, () => d().colorblind, (v) => settings.set({ colorblind: v })));

    section(S.options.audio);
    add(kit.slider(S.options.master, () => d().masterVolume, (v) => settings.set({ masterVolume: v })));
    add(kit.slider(S.options.music, () => d().musicVolume, (v) => settings.set({ musicVolume: v })));
    add(kit.slider(S.options.sfx, () => d().sfxVolume, (v) => settings.set({ sfxVolume: v })));

    const back = kit.button(S.common.back, () => ctx.pop(), { cls: 'back' });
    add(back);

    // external changes (auto quality stepping, etc.) keep the widgets honest
    this.unsub = settings.onChange(() => nav.refresh());
  }

  destroy() {
    this.unsub();
  }
}
