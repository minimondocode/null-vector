import { settings } from '../core/Settings';
import type { Game } from '../game/Game';
import { ENDLESS_THEME, SECTORS } from '../game/config';
import { esc, fmtInt, h, q, retrigger } from './dom';
import { S } from './strings';

/** Tuning knobs */
const SCORE_ROLL_RATE = 11; // higher = snappier rolling counter
const BOSS_TRAIL_DELAY = 0.35; // seconds before the damage trail catches up
const BOSS_TRAIL_RATE = 2.2;

/**
 * In-run heads-up display. Writes to the DOM only when a displayed value changes.
 */
export class HUD {
  el: HTMLElement;
  private hpPips: HTMLElement;
  private hpBox: HTMLElement;
  private dashBox: HTMLElement;
  private dashFill: HTMLElement;
  private scoreEl: HTMLElement;
  private multBox: HTMLElement;
  private multX: HTMLElement;
  private multRing: SVGCircleElement;
  private chainEl: HTMLElement;
  private comboToast: HTMLElement;
  private fpsEl: HTMLElement;
  private odBox: HTMLElement;
  private odFill: HTMLElement;
  private odLabel: HTMLElement;
  private sectorEl: HTMLElement;
  private waveEl: HTMLElement;
  private bossBox: HTMLElement;
  private bossName: HTMLElement;
  private bossTitle: HTMLElement;
  private bossPhases: HTMLElement;
  private bossFill: HTMLElement;
  private bossTrail: HTMLElement;
  private vignette: HTMLElement;

  private shownScore = 0;
  private lastScoreText = '';
  private lastHp = -1;
  private lastMaxHp = -1;
  private lastShield = -1;
  private lastMult = -1;
  private comboAge = 0;
  private comboKills = 0;
  private comboWindow = 3;
  private hitTimer = 0;
  private toastTimer = 0;
  private odState = '';
  private dashReady = true;
  private fpsTimer = 0;
  private bossKey = '';
  private bossTrailV = 1;
  private bossTrailHold = 0;
  private bossPhaseBase: 0 | 1 = 1;
  private lastPhase = -1;
  private waveZeroBased = false;
  private wave = 0;
  private totalWaves = 0;
  private sectorIdx = 0;
  private sectorLabel = '';
  private sectorText = '';
  private waveText = '';
  private lowHp = false;

  constructor(private game: Game) {
    this.el = h(
      'div',
      'hud',
      `
      <div class="hud-tl">
        <div class="hud-block hp-box">
          <div class="hud-label">${S.hud.integrity}</div>
          <div class="hp-pips"></div>
        </div>
        <div class="hud-block dash-box">
          <span class="hud-label">${S.hud.dash}</span>
          <div class="dash-bar"><i></i></div>
        </div>
      </div>
      <div class="hud-top">
        <div class="sector-line"><span class="sector-name"></span><span class="wave-name"></span></div>
        <div class="boss">
          <div class="boss-head">
            <span class="boss-tag">${S.hud.threat}</span>
            <span class="boss-name"></span>
            <span class="boss-title"></span>
            <span class="boss-phases"></span>
          </div>
          <div class="boss-bar"><i class="trail"></i><i class="fill"></i><div class="ticks"></div></div>
        </div>
      </div>
      <div class="hud-tr">
        <div class="hud-label">${S.hud.score}</div>
        <div class="score">0</div>
        <div class="mult">
          <svg viewBox="0 0 48 48" class="mult-ring"><circle class="ring-bg" cx="24" cy="24" r="20"/><circle class="ring" cx="24" cy="24" r="20" pathLength="100"/></svg>
          <span class="mult-x">x1</span>
        </div>
        <div class="chain"></div>
        <div class="combo-toast"></div>
        <div class="fps"></div>
      </div>
      <div class="hud-bottom">
        <div class="od">
          <div class="od-label">${S.hud.overdrive}</div>
          <div class="od-bar"><i></i><div class="od-segs">${'<b></b>'.repeat(10)}</div></div>
        </div>
      </div>
      <div class="vignette"></div>
      <div class="lowhp"></div>
    `,
    );
    const e = this.el;
    this.hpBox = q(e, '.hp-box');
    this.hpPips = q(e, '.hp-pips');
    this.dashBox = q(e, '.dash-box');
    this.dashFill = q(e, '.dash-bar i');
    this.scoreEl = q(e, '.score');
    this.multBox = q(e, '.mult');
    this.multX = q(e, '.mult-x');
    this.multRing = e.querySelector('.ring') as SVGCircleElement;
    this.chainEl = q(e, '.chain');
    this.comboToast = q(e, '.combo-toast');
    this.fpsEl = q(e, '.fps');
    this.odBox = q(e, '.od');
    this.odFill = q(e, '.od-bar > i');
    this.odLabel = q(e, '.od-label');
    this.sectorEl = q(e, '.sector-name');
    this.waveEl = q(e, '.wave-name');
    this.bossBox = q(e, '.boss');
    this.bossName = q(e, '.boss-name');
    this.bossTitle = q(e, '.boss-title');
    this.bossPhases = q(e, '.boss-phases');
    this.bossFill = q(e, '.boss-bar .fill');
    this.bossTrail = q(e, '.boss-bar .trail');
    this.vignette = q(e, '.vignette');

    const bus = game.bus;
    bus.on('runStart', () => this.reset());
    bus.on('playerHit', () => {
      this.hitTimer = 0.5;
      retrigger(this.hpBox, 'hit', ['rt-shake']);
    });
    bus.on('playerHeal', () => retrigger(this.hpBox, 'heal', ['rt-heal']));
    bus.on('comboChange', (c) => {
      this.comboKills = c.kills;
      this.comboAge = 0;
      this.comboWindow = Math.max(0.1, game.player.stats.comboWindow);
      if (c.multiplier !== this.lastMult && c.multiplier > 1) retrigger(this.multBox, 'bump', ['rt-bump']);
      else if (c.kills > 0) retrigger(this.multX, 'tick');
    });
    bus.on('comboLost', (c) => {
      this.comboToast.textContent = S.hud.comboLost(c.multiplier);
      retrigger(this.comboToast, 'show');
      this.toastTimer = 1.6;
    });
    bus.on('dashReady', () => retrigger(this.dashBox, 'ready-flash', ['rt-flash']));
    bus.on('waveStart', (w) => {
      if (w.wave === 0) this.waveZeroBased = true;
      this.wave = w.wave + (this.waveZeroBased ? 1 : 0);
      this.totalWaves = w.totalWaves;
    });
    bus.on('sectorStart', (s) => {
      this.sectorIdx = s.sector;
      const st = HUD.sectorTitle(s.name, s.sector, game);
      this.sectorLabel = st.sub ? `${st.title} // ${st.sub}` : st.title;
      this.wave = 0;
      this.totalWaves = 0;
    });
    bus.on('bossPhase', () => retrigger(this.bossBox, 'phase-flash', ['rt-flash', 'rt-glitch-x']));
  }

  /** Resolve "SECTOR 01" + "PERIMETER" from a sectorStart name. */
  static sectorTitle(name: string, sector: number, game: Game): { title: string; sub: string } {
    if (name.includes('//')) {
      const [a, ...b] = name.split('//');
      return { title: a.trim(), sub: b.join('//').trim() };
    }
    const theme = [...SECTORS, ENDLESS_THEME].find((t) => t.name === name) ?? (game.theme.name === name ? game.theme : null);
    const title = name || S.hud.sector(sector + 1);
    let sub = theme?.subtitle ?? '';
    if (game.mode === 'endless' && theme === ENDLESS_THEME && sector > 0) sub = `${sub} // ${S.hud.loop(sector + 1)}`;
    return { title, sub };
  }

  reset() {
    this.shownScore = 0;
    this.lastScoreText = '';
    this.lastHp = this.lastMaxHp = this.lastShield = this.lastMult = -1;
    this.comboKills = 0;
    this.comboAge = 0;
    this.waveZeroBased = false;
    this.wave = this.totalWaves = 0;
    this.bossKey = '';
    this.sectorLabel = '';
    this.toastTimer = 0;
    this.comboToast.classList.remove('show');
  }

  setVisible(v: boolean, dim: boolean) {
    this.el.classList.toggle('visible', v);
    this.el.classList.toggle('dim', dim);
  }

  update(dt: number) {
    const g = this.game;
    const p = g.player;
    const playing = g.state === 'playing';

    // ---- HP pips + shield pips
    const maxHp = Math.max(1, Math.round(p.stats.maxHp));
    const shield = Math.max(0, Math.round(p.shieldCharges));
    if (maxHp !== this.lastMaxHp || shield !== this.lastShield) {
      let html = '';
      for (let i = 0; i < maxHp; i++) html += `<i class="pip"></i>`;
      for (let i = 0; i < shield; i++) html += `<i class="pip shield"></i>`;
      this.hpPips.innerHTML = html;
      this.lastMaxHp = maxHp;
      this.lastShield = shield;
      this.lastHp = -1;
    }
    const hp = Math.max(0, Math.ceil(p.hp));
    if (hp !== this.lastHp) {
      const pips = this.hpPips.children;
      for (let i = 0; i < maxHp; i++) {
        const el = pips[i] as HTMLElement;
        const lost = i >= hp;
        if (lost && !el.classList.contains('lost') && this.lastHp > i) retrigger(el, 'breaking');
        el.classList.toggle('lost', lost);
      }
      this.lastHp = hp;
      const low = hp <= 1 && p.alive && maxHp > 1;
      if (low !== this.lowHp) {
        this.lowHp = low;
        this.el.classList.toggle('low-hp', low);
      }
    }
    if (this.hitTimer > 0) {
      this.hitTimer = Math.max(0, this.hitTimer - dt);
      const k = settings.data.flashes ? 1 : 0.4;
      this.vignette.style.opacity = String((this.hitTimer / 0.5) * k);
    }

    // ---- dash
    const dashFrac = p.stats.dashCooldown > 0 ? 1 - p.dashCooldown / p.stats.dashCooldown : 1;
    this.dashFill.style.transform = `scaleX(${Math.max(0, Math.min(1, dashFrac))})`;
    const ready = dashFrac >= 1;
    if (ready !== this.dashReady) {
      this.dashReady = ready;
      this.dashBox.classList.toggle('ready', ready);
    }

    // ---- score (rolling)
    const target = g.score;
    this.shownScore += (target - this.shownScore) * (1 - Math.exp(-SCORE_ROLL_RATE * dt));
    if (Math.abs(target - this.shownScore) < 1) this.shownScore = target;
    const txt = fmtInt(this.shownScore);
    if (txt !== this.lastScoreText) {
      this.scoreEl.textContent = txt;
      this.lastScoreText = txt;
    }

    // ---- multiplier + draining ring
    if (g.multiplier !== this.lastMult) {
      this.multX.textContent = `x${g.multiplier}`;
      this.multBox.dataset.tier = g.multiplier >= 10 ? '3' : g.multiplier >= 6 ? '2' : g.multiplier >= 3 ? '1' : '0';
      this.lastMult = g.multiplier;
    }
    if (playing) this.comboAge += dt * g.timeScale;
    const active = this.comboKills > 0;
    const frac = active ? Math.max(0, 1 - this.comboAge / this.comboWindow) : 0;
    this.multRing.style.strokeDashoffset = String(100 * (1 - frac));
    this.multBox.classList.toggle('draining', active && frac < 0.3);
    const chain = active ? S.hud.combo(this.comboKills) : '';
    if (this.chainEl.textContent !== chain) this.chainEl.textContent = chain;
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.comboToast.classList.remove('show');
    }

    // ---- overdrive
    const od = Math.max(0, Math.min(1, g.overdrive));
    this.odFill.style.transform = `scaleX(${od})`;
    const st = g.overdriveActive ? 'active' : od >= 1 ? 'ready' : 'charging';
    if (st !== this.odState) {
      this.odState = st;
      this.odBox.dataset.state = st;
      this.odLabel.textContent = st === 'active' ? S.hud.overdriveActive : st === 'ready' ? S.hud.overdriveReady : S.hud.overdrive;
    }

    // ---- sector / wave
    const dir = g.director as any;
    const dWave = typeof dir?.wave === 'number' ? dir.wave : undefined;
    const dTotal = typeof dir?.totalWaves === 'number' ? dir.totalWaves : undefined;
    if (!this.wave && dWave) this.wave = dWave;
    if (!this.totalWaves && dTotal) this.totalWaves = dTotal;
    const secText = this.sectorLabel || (g.mode === 'endless' ? ENDLESS_THEME.name : S.hud.sector(this.sectorIdx + 1));
    if (secText !== this.sectorText) this.sectorEl.textContent = this.sectorText = secText;
    const waveText = g.boss ? '' : this.wave > 0 ? (this.totalWaves > 0 ? S.hud.wave(this.wave, this.totalWaves) : S.hud.waveOnly(this.wave)) : '';
    if (waveText !== this.waveText) this.waveEl.textContent = this.waveText = waveText;

    // ---- boss
    const boss = g.boss;
    const key = boss ? `${boss.name}|${boss.title}|${boss.phases}` : '';
    if (key !== this.bossKey) {
      this.bossKey = key;
      this.bossBox.classList.toggle('show', !!boss);
      if (boss) {
        this.bossName.textContent = boss.name;
        this.bossTitle.textContent = boss.title ? `// ${boss.title}` : '';
        this.bossTrailV = 1;
        this.bossPhaseBase = boss.phase === 0 ? 0 : 1;
        this.lastPhase = -1;
        const n = Math.max(1, boss.phases);
        this.bossPhases.innerHTML = `<span class="ph-label">${esc(S.hud.phase)}</span>` + '<i></i>'.repeat(n);
        q(this.bossBox, '.ticks').innerHTML = n > 1 ? Array.from({ length: n - 1 }, (_, i) => `<b style="left:${((i + 1) / n) * 100}%"></b>`).join('') : '';
        retrigger(this.bossBox, 'enter', ['rt-boss-fill']);
      }
    }
    if (boss) {
      const hpv = Math.max(0, Math.min(1, boss.health()));
      this.bossFill.style.transform = `scaleX(${hpv})`;
      if (hpv < this.bossTrailV) {
        this.bossTrailHold += dt;
        if (this.bossTrailHold > BOSS_TRAIL_DELAY) this.bossTrailV = Math.max(hpv, this.bossTrailV - dt * BOSS_TRAIL_RATE * Math.max(0.15, this.bossTrailV - hpv));
      } else {
        this.bossTrailV = hpv;
        this.bossTrailHold = 0;
      }
      this.bossTrail.style.transform = `scaleX(${this.bossTrailV})`;
      if (boss.phase !== this.lastPhase) {
        this.lastPhase = boss.phase;
        const cur = boss.phase - this.bossPhaseBase; // 0-based current phase
        const pips = this.bossPhases.querySelectorAll('i');
        pips.forEach((pp, i) => {
          pp.classList.toggle('done', i < cur);
          pp.classList.toggle('cur', i === cur);
        });
      }
    }

    // ---- fps
    this.fpsTimer -= dt;
    if (this.fpsTimer <= 0) {
      this.fpsTimer = 0.25;
      const show = settings.data.showFps;
      this.fpsEl.style.display = show ? '' : 'none';
      if (show) {
        const f = Math.round(g.fps);
        this.fpsEl.textContent = S.hud.fps(f);
        this.fpsEl.dataset.bad = f < 40 ? '1' : '0';
      }
    }
  }
}
