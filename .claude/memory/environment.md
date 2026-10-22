---
name: environment
description: Toolchain and network facts for the AniVerse workspace (Windows 11, 2026-10-22)
metadata:
  type: reference
---

- Node 22.17, npm 11.16 (install scripts need `allowScripts` approval — electron, esbuild, electron-winstaller are approved in package.json), Python 3.14, VS 2022 present.
- Electron pinned to 44.9.3 (45.0.0 was one day old). Chromium 152, Node 24.22 inside Electron → `node:sqlite` available; no native modules needed.
- TypeScript pinned to 6.0.3 (7.x is the Go port), Vite 8 (rolldown) + React Compiler via `@rolldown/plugin-babel`, React Router 7, TanStack Query 5, zod 4, hls.js 1.7, dash.js 5 (named exports: `MediaPlayer`), Ghostery adblocker-electron 2.20.
- Network egress appears in Frankfurt (Cloudflare CF-RAY FRA): Muse Asia YouTube embeds report "not available in your country"; one configured site serves an interactive Cloudflare challenge.
- Packaging works: `electron-builder --win --dir` → `release/win-unpacked/AniVerse.exe` (config seeded to userData on first run).
