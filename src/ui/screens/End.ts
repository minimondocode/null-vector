import { settings } from '../../core/Settings';
import type { GameMode } from '../../core/EventBus';
import { copyText, esc, fmtInt, fmtTime, q, retrigger } from '../dom';
import { insertScore, lastCallsign, rankFor, sanitizeName, saveCallsign } from '../storage';
import { S } from '../strings';
import { Nav, Screen, header, type NavItem, type UIContext } from '../widgets';
import { statRows } from './Pause';
import { scoreTable } from './Scores';

/** Tuning: score count-up duration (s). */
const COUNT_UP = 1.8;

/** PROCESS TERMINATED / SYSTEM PURGED. */
export class EndScreen extends Screen {
  private t = 0;
  private finalScore: number;
  private scoreEl: HTMLElement;
  private rank: number;
  private saved = false;
  private input: HTMLInputElement | null = null;
  private mode: GameMode;
  private revealed = false;

  constructor(
    private ctx: UIContext,
    private win: boolean,
    endlessJustUnlocked: boolean,
  ) {
    super(`end-screen ${win ? 'win' : 'lose'}`);
    const { game, kit, bus } = ctx;
    this.mode = game.mode;
    this.finalScore = game.score;
    this.rank = rankFor(this.mode, this.finalScore);
    const stats = statRows(game);
    this.el.innerHTML = `
      ${header(win ? S.end.victory : S.end.gameover, win ? S.end.victorySub : S.end.gameoverSub, 'big')}
      ${endlessJustUnlocked ? `<div class="unlock-note">◆ ${esc(S.end.endlessUnlocked)} ◆</div>` : ''}
      <div class="end-body">
        <div class="end-left panel frame">
          <div class="final-label">${esc(S.end.finalScore)}</div>
          <div class="final-score">0</div>
          <div class="stat-grid">${stats.map(([k, v], i) => `<div class="stat" style="--i:${i}"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>
        </div>
        <div class="end-right panel frame">
          <div class="hs-entry"></div>
          <div class="side-h">// ${esc(S.scores.title)} — ${esc(this.mode === 'endless' ? S.scores.endless : S.scores.campaign)}</div>
          <div class="hs-table"></div>
        </div>
      </div>
      <div class="menu end-menu row"></div>`;
    this.scoreEl = q(this.el, '.final-score');

    if (this.rank >= 0) {
      const entry = q(this.el, '.hs-entry');
      entry.innerHTML = `
        <div class="hs-celebrate"><span class="hs-star">★</span> ${esc(S.end.newHigh)} <span class="hs-rank">${esc(S.end.rank(this.rank + 1))}</span> <span class="hs-star">★</span></div>
        <label class="hs-label">${esc(S.end.enterName)}</label>
        <div class="hs-form"><span class="hs-prompt">&gt;</span><input class="hs-input" maxlength="8" spellcheck="false" autocomplete="off" placeholder="${esc(S.end.namePlaceholder)}" /><button type="button" class="btn hs-save"><span class="btn-label">${esc(S.end.save)}</span></button></div>`;
      this.input = q<HTMLInputElement>(entry, '.hs-input');
      this.input.value = lastCallsign() || S.end.namePlaceholder;
      this.input.addEventListener('input', () => {
        const v = sanitizeName(this.input!.value);
        if (v !== this.input!.value) this.input!.value = v;
      });
      q(entry, '.hs-save').addEventListener('click', () => {
        kit.click();
        this.save();
      });
    }
    this.renderTable(-1);

    const menu = q(this.el, '.end-menu');
    const nav = (this.nav = new Nav(bus, 'horizontal'));
    const add = (it: NavItem) => menu.appendChild(nav.add(it).el);
    add(
      kit.button(
        S.end.retry,
        () => {
          this.save();
          game.startRun(this.mode);
        },
        { cls: 'primary' },
      ),
    );
    add(
      kit.button(S.end.title, () => {
        this.save();
        game.quitToTitle();
      }),
    );
    add(kit.button(S.end.copy, () => this.copy()));
  }

  private renderTable(highlight: number) {
    q(this.el, '.hs-table').innerHTML = scoreTable(this.mode, highlight);
  }

  private save() {
    if (this.saved || this.rank < 0) return;
    this.saved = true;
    let name = sanitizeName(this.input?.value ?? '');
    if (name.length < 3) name = S.end.namePlaceholder;
    saveCallsign(name);
    const r = this.ctx.game.runStats;
    const rank = insertScore(this.mode, {
      name,
      score: this.finalScore,
      difficulty: settings.data.difficulty,
      maxMult: r.maxMultiplier,
      time: Math.round(r.time),
      date: Date.now(),
    });
    this.input?.blur();
    const entry = this.el.querySelector('.hs-entry');
    entry?.classList.add('saved');
    if (entry) entry.querySelector('.hs-form')!.innerHTML = `<span class="hs-done">✓ ${esc(name)}</span>`;
    this.renderTable(rank);
  }

  private async copy() {
    const r = this.ctx.game.runStats;
    const text = S.end.share(
      this.win ? S.end.shareResultWin : S.end.shareResultLose,
      fmtInt(this.finalScore),
      r.maxMultiplier,
      fmtTime(r.time),
      settings.data.difficulty,
      this.mode,
    );
    const ok = await copyText(text);
    this.ctx.toast(ok ? S.end.copied : S.end.copyFailed, ok ? 'ok' : 'warn');
  }

  onKey(e: KeyboardEvent): boolean {
    if (this.input && document.activeElement === this.input) {
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        this.save();
        return true;
      }
      return false;
    }
    if (!this.revealed && (e.code === 'Enter' || e.code === 'Space')) {
      this.t = COUNT_UP; // skip count-up
      return true;
    }
    return super.onKey(e);
  }

  update(dt: number) {
    this.t += dt;
    const k = Math.min(1, this.t / COUNT_UP);
    const eased = 1 - Math.pow(1 - k, 3);
    this.scoreEl.textContent = fmtInt(this.finalScore * eased);
    if (k >= 1 && !this.revealed) {
      this.revealed = true;
      this.el.classList.add('revealed');
      retrigger(this.scoreEl, 'land');
      if (this.input && !this.saved) {
        this.input.focus();
        this.input.select();
      }
    }
  }

  destroy() {
    this.save();
  }
}
