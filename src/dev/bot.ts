/**
 * Dev-only autoplay used for playtesting: open with ?bot (optionally &god&speed=3&boss=firewall|hydra|root&sector=N).
 * Never included in production builds (guarded by import.meta.env.DEV in main.ts).
 */
import type { Game } from '../game/Game';
import { settings } from '../core/Settings';

export function installBot(game: Game) {
  const q = new URLSearchParams(location.search);
  const w = window as any;
  w.errs = [] as string[];
  w.log = [] as string[];
  addEventListener('error', (e) => w.errs.push(String(e.message)));
  addEventListener('unhandledrejection', (e) => w.errs.push(String((e as PromiseRejectionEvent).reason)));
  for (const k of ['waveStart', 'sectorStart', 'bossWarning', 'bossSpawn', 'bossPhase', 'bossKilled', 'victory', 'playerDeath', 'playerHit'] as const) {
    game.bus.on(k, (p: any) => w.log.push(`${k} ${JSON.stringify(p?.name ?? p?.wave ?? p?.phase ?? p?.hp ?? '')} t=${Math.round(game.runTime)}`));
  }
  const speed = Number(q.get('speed') ?? 1);
  if (speed !== 1) {
    const rn = performance.now.bind(performance);
    const t0 = rn();
    performance.now = () => t0 + (rn() - t0) * speed;
    settings.set({ autoQuality: false });
  }
  if (q.has('god')) game.player.hurt = () => false;

  const g = game as any;
  g.updateAim = function () {
    let best: any = null, bd = 1e9;
    for (const e of game.enemies) {
      if (!e.alive || !e.collidable || !e.vulnerable) continue;
      const d = e.pos.distanceToSquared(game.player.pos);
      if (d < bd) { bd = d; best = e; }
    }
    if (!best) for (const e of game.enemies) if (e.alive && e.collidable) best = e;
    if (best) game.aimPoint.set(best.pos.x, 0.6, best.pos.z);
    game.input.mouseLeft = true;
  };
  game.input.moveAxis = () => {
    const p = game.player.pos;
    let x = -p.x * 0.04, z = -p.z * 0.04;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      const dx = p.x - e.pos.x, dz = p.z - e.pos.z, d2 = dx * dx + dz * dz + 0.1;
      if (d2 < 100) { x += (dx / d2) * 3; z += (dz / d2) * 3; }
    }
    for (const b of game.enemyBullets.items) {
      if (!b.active) continue;
      const dx = p.x - b.x, dz = p.z - b.z, d2 = dx * dx + dz * dz + 0.1;
      if (d2 < 25) { x += dx / d2; z += dz / d2; }
    }
    const l = Math.hypot(x, z);
    return l > 0.05 ? { x: x / l, y: -z / l } : { x: 0, y: 0 };
  };
  setInterval(() => {
    if (game.state === 'upgrade' && game.currentOffer.length) game.chooseUpgrade(game.currentOffer[Math.floor(Math.random() * game.currentOffer.length)].id);
    if (game.overdrive >= 1 && !game.overdriveActive) (game.input as any).pressed.add('KeyE');
  }, 900);

  if (q.has('start')) {
    setTimeout(async () => {
      game.startRun(q.get('mode') === 'endless' ? 'endless' : 'campaign');
      const boss = q.get('boss');
      if (boss) {
        const { SECTORS } = await import('../game/config');
        const { spawnBoss } = await import('../bosses/index');
        const i = Math.max(0, SECTORS.findIndex((s) => s.bossId === boss));
        g.director.update = () => {};
        game.setTheme(SECTORS[i]);
        game.sector = i;
        for (const e of game.enemies) e.alive = false;
        spawnBoss(game, boss as any, () => w.log.push('BOSS DEFEATED callback'));
      }
    }, 500);
  }
}
