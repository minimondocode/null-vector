import { settings, type Difficulty } from '../../core/Settings';
import { esc, retrigger } from '../dom';
import { isEndlessUnlocked } from '../storage';
import { S } from '../strings';
import { Nav, Screen, type NavItem, type UIContext } from '../widgets';
import { ControlsScreen } from './Controls';
import { OptionsScreen } from './Options';
import { ScoresScreen } from './Scores';

export function logoHtml(cls = ''): string {
  const t = esc(S.title.logo);
  return `<div class="logo ${cls}" aria-label="${t}">
    <div class="logo-frame"><i></i><i></i><i></i><i></i></div>
    <h1 class="logo-text" data-text="${t}">${t}</h1>
    <div class="logo-slice s1" data-text="${t}" aria-hidden="true">${t}</div>
    <div class="logo-slice s2" data-text="${t}" aria-hidden="true">${t}</div>
    <div class="logo-scan" aria-hidden="true"></div>
  </div>`;
}

export class TitleScreen extends Screen {
  private diffDesc: HTMLElement;

  constructor(private ctx: UIContext) {
    super('title-screen');
    const { kit, bus, game } = ctx;
    this.el.innerHTML = `
      <div class="title-hero">
        ${logoHtml()}
        <div class="tagline"><span class="tl-bracket">[</span> ${esc(S.title.tagline)} <span class="tl-bracket">]</span></div>
      </div>
      <div class="title-menu-wrap">
        <div class="menu title-menu"></div>
        <div class="diff-desc"></div>
      </div>
      <div class="boot">${S.title.boot.map((l, i) => `<div class="boot-line" style="--i:${i}">${esc(l)}</div>`).join('')}</div>
      <div class="title-foot"><span>${esc(S.title.navHint)}</span><span>${esc(S.title.version)}</span></div>
    `;
    const menu = this.el.querySelector('.title-menu') as HTMLElement;
    this.diffDesc = this.el.querySelector('.diff-desc') as HTMLElement;
    const nav = (this.nav = new Nav(bus));
    const add = (it: NavItem) => menu.appendChild(nav.add(it).el);

    add(kit.button(S.title.start, () => game.startRun('campaign'), { cls: 'primary' }));
    const unlocked = isEndlessUnlocked();
    const endless = kit.button(
      S.title.endless,
      () => {
        if (!isEndlessUnlocked()) {
          retrigger(endless.el, 'denied');
          ctx.toast(S.toast.locked, 'warn');
          return;
        }
        game.startRun('endless');
      },
      { hint: unlocked ? S.title.endlessHint : S.title.lockedHint, glyph: unlocked ? '∞' : '⊘' },
    );
    endless.el.classList.toggle('locked', !unlocked);
    add(endless);
    const diffs: Difficulty[] = ['easy', 'normal', 'hard'];
    const diff = kit.choice(
      S.title.difficulty,
      diffs.map((d) => ({ value: d, label: S.difficulty[d] })),
      () => settings.data.difficulty,
      (v) => {
        settings.set({ difficulty: v });
        this.updateDesc();
      },
    );
    diff.el.classList.add('diff-row');
    add(diff);
    add(kit.button(S.title.options, () => ctx.push(new OptionsScreen(ctx))));
    add(kit.button(S.title.scores, () => ctx.push(new ScoresScreen(ctx, 'campaign'))));
    add(kit.button(S.title.controls, () => ctx.push(new ControlsScreen(ctx))));
    this.updateDesc();
  }

  private updateDesc() {
    const d = settings.data.difficulty;
    this.diffDesc.dataset.diff = d;
    this.diffDesc.textContent = `> ${S.difficulty[d]}: ${S.difficultyDesc[d]}`;
  }
}
