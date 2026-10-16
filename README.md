# NULL VECTOR

Neon twin-stick shooter for the browser. three.js + Vite + TypeScript, 100% procedural: geometry, shaders and audio are all code.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/ (relative paths, GitHub Pages ready)
```

## Controls
WASD / ZQSD move · mouse aim · hold left click fire · Space / Shift / right click dash · E / F overdrive · Esc / P pause

## Content
3 sectors × 4 waves, a boss per sector (FIREWALL, HYDRA.DLL, ROOT), 7 enemy types, 23 upgrades,
endless mode unlocked after the first victory, adaptive synthesized music, quality presets, accessibility options, local high scores.

## Dev autoplay
`npm run dev`, then open `/?bot&start` (add `&god`, `&speed=3`, `&boss=firewall|hydra|root`, `&mode=endless`). Dev builds only.

See ARCHITECTURE.md for the module map.
