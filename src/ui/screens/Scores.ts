import type { GameMode } from '../../core/EventBus';
import { esc, fmtInt, fmtTime } from '../dom';
import { loadScores } from '../storage';
import { S } from '../strings';
import { Nav, Screen, header, type UIContext } from '../widgets';

/** Top-10 table markup. `highlight` = 0-based row to celebrate. */
export function scoreTable(mode: GameMode, highlight = -1): string {
  const list = loadScores(mode);
  if (!list.length) return `<div class="score-empty">${esc(S.scores.empty)}</div>`;
  const c = S.scores.cols;
  const rows = list
    .map(
      (e, i) => `<tr class="${i === highlight ? 'me' : ''} ${i < 3 ? 'top' + (i + 1) : ''}">
        <td class="r">${String(i + 1).padStart(2, '0')}</td>
        <td class="n">${esc(e.name)}</td>
        <td class="s">${fmtInt(e.score)}</td>
        <td class="m">x${e.maxMult ?? 1}</td>
        <td class="t">${fmtTime(e.time ?? 0)}</td>
        <td class="d">${esc((S.difficulty as Record<string, string>)[e.difficulty] ?? e.difficulty ?? '')}</td>
      </tr>`,
    )
    .join('');
  return `<table class="score-table"><thead><tr><th>${c.rank}</th><th>${c.name}</th><th class="s">${c.score}</th><th>${c.mult}</th><th>${c.time}</th><th>${c.diff}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export class ScoresScreen extends Screen {
  private mode: GameMode;
  private tableWrap: HTMLElement;

  constructor(ctx: UIContext, mode: GameMode) {
    super('scores-screen sub');
    this.mode = mode;
    const { kit, bus } = ctx;
    this.el.innerHTML = `<div class="panel frame wide">${header(S.scores.title, S.scores.subtitle)}<div class="sc-controls"></div><div class="sc-table"></div><div class="sc-back"></div></div>`;
    this.tableWrap = this.el.querySelector('.sc-table') as HTMLElement;
    const nav = (this.nav = new Nav(bus));
    const modeSel = kit.choice<GameMode>(
      S.scores.mode,
      [
        { value: 'campaign', label: S.scores.campaign },
        { value: 'endless', label: S.scores.endless },
      ],
      () => this.mode,
      (v) => {
        this.mode = v;
        this.render();
      },
    );
    this.el.querySelector('.sc-controls')!.appendChild(nav.add(modeSel).el);
    this.el.querySelector('.sc-back')!.appendChild(nav.add(kit.button(S.common.back, () => ctx.pop(), { cls: 'back' })).el);
    this.render();
  }

  private render() {
    this.tableWrap.innerHTML = scoreTable(this.mode);
  }
}
