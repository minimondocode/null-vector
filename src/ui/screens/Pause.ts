import { settings } from '../../core/Settings';
import type { Game } from '../../game/Game';
import { UPGRADES } from '../../game/Upgrades';
import { esc, fmtInt, fmtTime } from '../dom';
import { S } from '../strings';
import { Nav, Screen, header, type NavItem, type UIContext } from '../widgets';
import { OptionsScreen } from './Options';

/** Stat rows shared by pause + end screens. */
export function statRows(game: Game): [string, string][] {
  const r = game.runStats;
  const acc = r.shotsFired > 0 ? Math.round((r.shotsHit / r.shotsFired) * 100) : 0;
  return [
    [S.stats.time, fmtTime(r.time)],
    [S.stats.kills, fmtInt(r.kills)],
    [S.stats.maxMult, `x${r.maxMultiplier}`],
    [S.stats.accuracy, `${Math.min(100, acc)}%`],
    [S.stats.bosses, String(r.bossesKilled)],
    [S.stats.overdrives, String(r.overdrives)],
    [S.stats.damage, String(r.damageTaken)],
    [S.stats.sector, String(r.sectorReached)],
    [S.stats.difficulty, S.difficulty[settings.data.difficulty] ?? ''],
  ];
}

export function buildList(game: Game): string {
  if (!game.ownedUpgrades.size) return `<div class="build-empty">${esc(S.pause.noBuild)}</div>`;
  return [...game.ownedUpgrades]
    .map(([id, n]) => {
      const u = UPGRADES.find((x) => x.id === id);
      if (!u) return '';
      return `<div class="build-item r-${u.rarity}"><span class="b-glyph">${esc(u.glyph)}</span><span class="b-name">${esc(u.name)}</span><span class="b-n">x${n}</span></div>`;
    })
    .join('');
}

export class PauseScreen extends Screen {
  constructor(ctx: UIContext) {
    super('pause-screen');
    const { kit, bus, game } = ctx;
    this.el.innerHTML = `
      <div class="pause-left">
        ${header(S.pause.title, S.pause.subtitle, 'left')}
        <div class="menu pause-menu"></div>
      </div>
      <div class="pause-right">
        <div class="panel frame side">
          <div class="side-h">// ${esc(S.pause.stats)}</div>
          <div class="stat-grid small">
            <div class="stat"><span>${esc(S.stats.score)}</span><b>${fmtInt(game.score)}</b></div>
            ${statRows(game)
              .map(([k, v]) => `<div class="stat"><span>${esc(k)}</span><b>${esc(v)}</b></div>`)
              .join('')}
          </div>
        </div>
        <div class="panel frame side">
          <div class="side-h">// ${esc(S.pause.build)}</div>
          <div class="build-list">${buildList(game)}</div>
        </div>
      </div>`;
    const menu = this.el.querySelector('.pause-menu') as HTMLElement;
    const nav = (this.nav = new Nav(bus));
    const add = (it: NavItem) => menu.appendChild(nav.add(it).el);
    add(kit.button(S.pause.resume, () => game.resume(), { cls: 'primary' }));
    add(kit.button(S.pause.options, () => ctx.push(new OptionsScreen(ctx))));
    add(kit.confirmButton(S.pause.restart, () => game.startRun(game.mode)));
    add(kit.confirmButton(S.pause.quit, () => game.quitToTitle()));
  }
}
