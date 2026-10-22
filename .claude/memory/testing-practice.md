---
name: testing-practice
description: How to validate AniVerse changes without disturbing the user's desktop
metadata:
  type: feedback
---

- Run E2E with `ANIVERSE_HEADLESS=1` (set by test/e2e scripts): window is invisible, click-through and unfocused.
  **Why:** during early runs visible test windows (and a Cloudflare verify window) appeared on the user's screen and got clicked/closed mid-test, corrupting results.
  **How to apply:** never launch the app visibly for automated checks; only `npm run dev`/`npm start` for the user.
- Judge **websites** only with the in-process driver (`npm run test:sites`), not Playwright: Playwright's remote debugging sets `navigator.webdriver`, so anti-bot guards and Cloudflare react to the harness, not to the app (a site's "redirect bug" on 2026-10-22 was this).
  **Why:** a harness artifact was reported to the user as a site failure and nearly "fixed" in product code.
  **How to apply:** if a site fails only under Playwright scripts, confirm with `guard-probe.cjs` / the survey before changing the navigator.
- After a run, Read the PNGs in `test/artifacts/` — passing selectors alone missed real bugs (hero overlap, empty-state spacing, YouTube Error 153, AniList 500s).
- If a launch fails with "Target … has been closed", a previous *test* instance holds the single-instance lock: stop only electron processes whose command line contains `test/cache/e2e-profile` or `survey-profile` — never the user's own dev instance.
- The user's usage budget is tight: validate with targeted steps (`node test/e2e/smoke.mjs watch player-hls`) rather than full runs when iterating.
