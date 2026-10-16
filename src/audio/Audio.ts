import type { EventBus, GameState } from '../core/EventBus';
import { SECTORS, type SectorTheme } from '../game/config';
import { Mixer } from './Mixer';
import { Music, buildTrack } from './Music';
import { Sfx } from './Sfx';

/** Tuning: music lowpass cutoffs per situation (Hz). */
const MUFFLE = { paused: 420, upgrade: 900, overdrive: 1300, open: 20000 };

/**
 * Audio facade: 100% Web Audio synthesis. SFX + adaptive music, driven by bus events.
 * Nothing is created until unlock() runs from a user gesture.
 */
export class Audio {
  private bus: EventBus;
  private ctx: AudioContext | null = null;
  private mx: Mixer | null = null;
  private sfx: Sfx | null = null;
  private music: Music | null = null;
  private state: GameState = 'title';
  private theme: SectorTheme = SECTORS[0];
  private isBoss = false;
  private overdrive = false;
  private lastMult = 1;

  constructor(bus: EventBus) {
    this.bus = bus;
    this.wire();
    document.addEventListener('visibilitychange', () => {
      const ctx = this.ctx;
      if (!ctx) return;
      if (document.hidden) void ctx.suspend().catch(() => {});
      else this.resume();
    });
  }

  /** Must be called from a user gesture (click / key) to start the AudioContext. Idempotent and cheap. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state !== 'running' && !document.hidden) this.resume();
      return;
    }
    const AC: typeof AudioContext | undefined = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!AC) return;
    let ctx: AudioContext;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
    } catch {
      return;
    }
    this.ctx = ctx;
    this.mx = new Mixer(ctx);
    this.sfx = new Sfx(this.mx);
    this.music = new Music(this.mx);
    this.music.onBeat = (b) => this.bus.emit('beat', b);
    ctx.onstatechange = () => {
      if (ctx.state === 'running') this.music?.resync();
    };
    this.resume();
    this.refreshMusic(true);
  }

  /** 0..1 position within the current music beat (for visuals). */
  get beatPhase(): number {
    return this.music?.beatPhase ?? 0;
  }

  /** Audible bar counter. */
  get bar(): number {
    return this.music?.bar ?? 0;
  }

  setTheme(theme: SectorTheme, isBoss = false) {
    this.theme = theme;
    this.isBoss = isBoss;
    if (isBoss && this.music) this.music.breakdown = false;
    this.refreshMusic(false);
  }

  update(realDt: number) {
    const music = this.music;
    const mx = this.mx;
    if (!music || !mx) return;
    music.update(Math.min(realDt, 0.1));
    const s = this.state;
    const f = s === 'paused' ? MUFFLE.paused : s === 'upgrade' ? MUFFLE.upgrade : this.overdrive && s === 'playing' ? MUFFLE.overdrive : MUFFLE.open;
    mx.setMusicFilter(f, f < 20000 ? 0.08 : 0.25);
  }

  // -----------------------------------------------------------------------

  private resume() {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return;
    void ctx
      .resume()
      .then(() => this.music?.resync())
      .catch(() => {});
  }

  private refreshMusic(urgent: boolean) {
    const m = this.music;
    if (!m) return;
    switch (this.state) {
      case 'title':
        m.request(buildTrack('title', null), true);
        break;
      case 'playing':
      case 'upgrade':
      case 'paused':
        m.request(buildTrack(this.isBoss ? 'boss' : 'game', this.theme), urgent || m.style === 'title' || m.style === 'victory');
        break;
      case 'victory':
        m.request(buildTrack('victory', this.theme), true);
        break;
      case 'gameover':
        m.tapeStop();
        break;
    }
  }

  private setOverdrive(on: boolean) {
    this.overdrive = on;
    this.music?.setOverdrive(on);
  }

  /** Scale-degree helper that follows the music key so stingers stay in harmony. */
  private n(degree: number, octave = 5) {
    return this.music?.scaleNote(degree, octave) ?? 69;
  }

  private wire() {
    const b = this.bus;
    const sfx = () => this.sfx;
    const duck = (amount: number, hold = 0.05, release = 0.4) => this.mx?.duck(amount, hold, release);

    b.on('stateChange', ({ to }) => {
      this.state = to;
      if (to !== 'playing' && to !== 'paused' && to !== 'upgrade' && this.overdrive) this.setOverdrive(false);
      if (to === 'title') {
        this.isBoss = false;
        if (this.music) this.music.breakdown = false;
      }
      this.refreshMusic(false);
    });
    b.on('runStart', () => {
      this.lastMult = 1;
      this.isBoss = false;
      this.setOverdrive(false);
      if (this.music) {
        this.music.setCombo(1);
        this.music.setIntensity(0);
        this.music.breakdown = false;
      }
    });
    b.on('intensity', ({ value }) => this.music?.setIntensity(value));

    b.on('playerShoot', () => sfx()?.playerShoot());
    b.on('enemyHit', (e) => sfx()?.enemyHit(e.pos.x));
    b.on('enemyKilled', (e) => sfx()?.enemyKilled(e.kind, e.size, e.pos.x));
    b.on('enemyShoot', (e) => sfx()?.enemyShoot(e.pos.x));
    b.on('enemySpawn', (e) => sfx()?.enemySpawn(e.pos.x));
    b.on('explosion', (e) => {
      sfx()?.explosion(e.size, e.pos.x);
      if (e.size >= 3) duck(Math.min(0.6, 0.12 + e.size * 0.06), 0.04, 0.35 + e.size * 0.05);
    });
    b.on('playerHit', () => {
      sfx()?.playerHit();
      duck(0.6, 0.12, 0.6);
    });
    b.on('playerDeath', () => {
      sfx()?.playerDeath();
      duck(0.85, 0.4, 1.2);
    });
    b.on('playerDash', () => sfx()?.dash());
    b.on('dashReady', () => sfx()?.dashReady());

    b.on('comboChange', ({ multiplier }) => {
      this.music?.setCombo(multiplier);
      if (multiplier > this.lastMult) sfx()?.combo(this.n(Math.min(multiplier - 1, 14), 5));
      this.lastMult = multiplier;
    });
    b.on('comboLost', ({ multiplier }) => {
      this.music?.setCombo(1);
      this.lastMult = 1;
      if (multiplier >= 2) sfx()?.comboLost([this.n(4), this.n(2), this.n(0)]);
    });

    b.on('overdriveReady', () => sfx()?.overdriveReady([this.n(0, 6), this.n(2, 6), this.n(4, 6), this.n(7, 6)]));
    b.on('overdriveStart', () => {
      sfx()?.overdriveStart();
      duck(0.75, 0.25, 0.9);
      this.setOverdrive(true);
    });
    b.on('overdriveEnd', () => {
      sfx()?.overdriveEnd();
      this.setOverdrive(false);
    });

    b.on('waveStart', () => sfx()?.waveStart(this.n(0, 4)));
    b.on('waveCleared', () => sfx()?.arpeggio('waveCleared', [0, 2, 4, 7].map((d) => this.n(d, 5)), 0.08, 0.12));
    b.on('sectorStart', () => sfx()?.sectorStart([this.n(0, 3), this.n(4, 3), this.n(7, 3), this.n(9, 3)]));
    b.on('sectorCleared', () => sfx()?.arpeggio('sectorCleared', [0, 2, 4, 7, 9, 11, 14].map((d) => this.n(d, 5)), 0.07, 0.12));
    b.on('upgradeOffer', () => sfx()?.arpeggio('upgradeOffer', [0, 2, 4, 6].map((d) => this.n(d, 6)), 0.06, 0.07, 'sine', 0.5));
    b.on('upgradeChosen', () => sfx()?.arpeggio('upgradeChosen', [this.n(4, 5), this.n(7, 5), this.n(11, 5)], 0.05, 0.12, 'triangle', 0.4));
    b.on('uiClick', () => sfx()?.uiClick());
    b.on('uiHover', () => sfx()?.uiHover());

    b.on('bossWarning', () => {
      sfx()?.bossWarning();
      duck(0.35, 2.4, 0.8);
      if (this.music) this.music.breakdown = true;
    });
    b.on('bossSpawn', () => {
      if (this.music) this.music.breakdown = false;
      sfx()?.bossSpawn([this.n(0, 2), this.n(0, 3), this.n(4, 3), this.n(7, 3)]);
      duck(0.7, 0.2, 1);
    });
    b.on('bossPhase', () => {
      sfx()?.bossPhase();
      duck(0.45, 0.1, 0.6);
    });
    b.on('bossKilled', () => {
      // relative-major chord built on the III degree: triumphant against the minor key
      const r = this.n(2, 3);
      sfx()?.bossKilled([r, r + 4, r + 7, r + 12]);
      duck(0.85, 0.6, 2);
    });
    b.on('victory', () => {
      const r = this.n(2, 4);
      sfx()?.victory([r, r + 4, r + 7, r + 12, r + 16]);
    });
  }
}
