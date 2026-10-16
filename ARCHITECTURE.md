# NULL VECTOR — architecture

Neon twin-stick shooter, three.js + Vite + TypeScript. 100% procedural: no image/model/audio files.

## Design (agreed with the user)
- Top-down tilted camera; WASD/ZQSD move (KeyboardEvent.code), mouse aim, hold LMB to fire,
  Space/Shift/RMB dash (i-frames + damaging trail), E/F overdrive (bullet time + shockwave) when meter full,
  Esc/P pause.
- Campaign: 3 sectors (~3 min of waves each) + 1 boss each (FIREWALL, HYDRA.DLL, ROOT) ≈ 10–12 min, then victory.
  Endless mode unlocked after first victory (localStorage).
- Combo multiplier (decays without kills), score, 1-of-3 upgrade pick between waves, single upgradable weapon.
- 6–8 enemy types introduced progressively. Theme: a program purging a corrupted network. UI text in English.
- Adaptive synthesized music (Web Audio), synthesized SFX. Quality presets, accessibility options, local highscores.

## Module map / ownership
- `src/core/` EventBus (all cross-module events, typed), Settings (persisted), Input.
- `src/game/` Game (loop, state machine, collisions, combo, overdrive, camera), Player, Bullets (pooled instanced),
  Arena (boundary math), config (sectors, difficulty), Stats, Upgrades, Director (pacing), types (contracts).
- `src/enemies/` EnemyBase + enemy types.  `src/bosses/` boss encounters, entry `spawnBoss()`.
- `src/vfx/` VFX facade: post-processing, particles, deformable grid floor, arena walls, shake, flashes.
- `src/audio/` Audio facade: SFX + adaptive music, reacts to bus events.
- `src/ui/` DOM HUD/menus over the canvas, talks to Game only via its public API.

## Conventions
- Gameplay plane is XZ, y = PLAY_Y for ships. Screen-up is -Z.
- Neon look: MeshBasicMaterial / LineBasicMaterial with colours multiplied >1 and `toneMapped: false` -> bloom.
- World time (`dt` given to enemies/entities) is scaled by overdrive slow-mo; player uses real time.
- Modules talk via `ctx.bus` events; gameplay never imports audio/ui.
- `window.game` is exposed for debugging.
