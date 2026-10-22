---
name: ui-feedback
description: Corrections the user gave while testing AniVerse with npm run dev (2026-10-22) — loader, site navigation, release gating, controls
metadata:
  type: feedback
---

- **Website episodes must look native**: AniVerse drives the site (search → series → episode) behind the running-cat loader; the user must never see the site's page, URL bar or chrome — not even for a few seconds while the webview attaches. Only the player is shown (focus CSS), with SUB/DUB and server switches mirrored as AniVerse buttons.
  **Why:** the user reported "visiting the website" and later a brief leak before the loader as bugs.
  **How to apply:** the loader is keyed on the site key (shown before the webview has an id); verify with `node test/e2e/watch-gates.mjs` (counts frames where a webview is visible without the loader).
- **Loader = the user's own six cat drawings**, switched as image frames (no CSS/SVG cat). Source drawings are dropped in `.idea/01.png…06.png`; copy them with `npx electron scripts/import-cat-frames.cjs .idea` into `frontend/src/assets/cat/` — never import from `.idea`. Timing: 16 fps clock, drawing changes on twos (≈8 drawings/s, 0.75 s stride) with a ground strip scrolling every tick; cross-faded in-betweens were tried and rejected (double faces). The drawings' numbering is not stride order — played 01→06 the cat "rocks back and forth" (user report); the importer re-sequences them by gait (`GAIT = 01,03,06,04,02,05`). If the user supplies new drawings, check the order with `test/cache/cat-sheet.cjs` / `cat-diff.cjs` before blaming the code.
- **Not-out-yet titles never open a player or site**: premiere ahead (date or next airing), a film still in cinemas (AniList RELEASING + MOVIE), or an unaired episode → release page with date/countdown. AniList `status` alone is unreliable; use `app/shared/release.ts`. Home puts them in "Coming soon", not the hero/charts/season grid.
- **No browser-default controls anywhere**: custom Select/Checkbox/Radio/Range/scrollbars (incl. hover), custom right-click menu.
- The user tests in the running dev app and sends screenshots mid-task; check the screenshot against the current code before assuming the fix didn't land (it may predate the change).
