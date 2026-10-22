---
name: product-decisions
description: Scope decisions taken when building AniVerse from the brief in .prompts/01.txt (2026-10-22)
metadata:
  type: project
---

- The brief forbids "unauthorised API access" and DRM bypass. Most sites in the config are unlicensed mirrors, so website sources are **browsed in isolated sessions with the site's own player**; AniVerse only discovers their search (OpenSearch / GET form / schema.org SearchAction) and lets the user pin an anime's page. No episode/stream scraping.
  **Why:** extracting streams from those sites would be unauthorised access and would facilitate infringement.
  **How to apply:** native HLS/DASH/MP4 playback is for authorised sources only (user URLs/files, future licensed adapters); YouTube official channels use the official embed.
- Phase 2 (user request): AniVerse now *drives* the site page itself (site search → series → episode, clicks SUB/DUB/server buttons) and visually isolates the site's own player. Still no stream extraction — the media plays inside the site's page, which is why website sources can't be Chromecast'ed (casting covers native-player media only).
- "Auto Cloudflare submission" = run the challenge in a real Chromium window in the source's session; non-interactive checks clear by themselves (window hidden), interactive ones are shown to the user. No auto-clicking or fingerprint spoofing.
- "Block ads and promotion" = Ghostery prebuilt full lists (ads + tracking + annoyances) + `config/filters.txt` + popup/cross-site-redirect/download blocking per source session.
- Comments: AniList episode threads (read + post when connected), MAL forum topics (read-only — MAL API has no posting), YouTube comments (read-only, needs API key). Site comment widgets stay on the site page.
- Accounts (user request, session 3): users never enter client IDs/redirects/tokens. The *app's* client IDs are compiled in from `config/oauth.json` (env overrides), sign-in runs in the system browser and returns via `aniverse://oauth/anilist` / `aniverse://oauth/myanimelist` deep links (AniList implicit grant; MAL PKCE plain, public client, no secret). Two-way sync is optional (default on), newest edit wins. Details: docs/ACCOUNTS.md.
- Disclaimer wording (user request): AniVerse is "a browser with custom features" — hosts/serves nothing, loads third-party pages, reads them (web scraping/automated navigation), overlays CSS to show only the site's player; legal/DMCA notices belong to the sites' operators/hosts. Shown in Settings → About and the README. Keep it factually accurate (no download/extraction of videos).
- The "previously approved UI mockup" mentioned in the brief was not found in the project or the user's artifacts; the UI was designed from two reference sites the user named (black, orange accent, skewed CTAs, ranked trending; icon rail, filter grid, schedule timeline, episode panel), with original branding. Names in .claude/private-notes.md.
- `frontend/` Vite template was consolidated into the root package; `app/` holds the framework-free core, `electron/` the main process.
