import { esc } from '../dom';
import { S } from '../strings';
import { Nav, Screen, header, type UIContext } from '../widgets';

export class ControlsScreen extends Screen {
  constructor(ctx: UIContext) {
    super('controls-screen sub');
    const c = S.controls;
    const keys = c.keys
      .map(([k, a]) => `<div class="key-row"><span class="keys">${k.split(' / ').map((x) => `<kbd>${esc(x)}</kbd>`).join('<em>/</em>')}</span><span class="act">${esc(a)}</span></div>`)
      .join('');
    const tips = c.tips.map(([t, d]) => `<div class="tip"><div class="tip-t">// ${esc(t)}</div><div class="tip-d">${esc(d)}</div></div>`).join('');
    this.el.innerHTML = `<div class="panel frame wide">${header(c.title, c.subtitle)}<div class="ctl-grid"><div class="ctl-keys">${keys}</div><div class="ctl-tips">${tips}</div></div><div class="ctl-back"></div></div>`;
    this.nav = new Nav(ctx.bus);
    this.el.querySelector('.ctl-back')!.appendChild(this.nav.add(ctx.kit.button(S.common.back, () => ctx.pop(), { cls: 'back' })).el);
  }
}
