# Product decisions and invariants

Inspected 2026-10-26 against current source, [CONTRIBUTING.md](../../CONTRIBUTING.md), [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md), and historical [.claude/memory/product-decisions.md](../../.claude/memory/product-decisions.md).

## Source playback

- AniVerse is a desktop browser with anime features. Website sources stay in isolated Chromium sessions and use the site's player. Search, title/episode navigation, SUB/DUB/server selection, learned links and focus CSS already exist.
- The `web` adapter returns a website page rather than an extracted native episode/stream catalog. The Electron navigator separately reads and drives the rendered page. Do not mistake older blanket “no episode scraping” text for absence of the implemented navigator.
- Preserve the project boundary against media hosting, stream extraction, private API access and DRM/login/paywall bypass. Native streams are for user-supplied or otherwise authorized inputs; official YouTube channels use the official embed.
- Source identities come from local `config/streaming-sites.txt`. Do not copy configured domains, private notes or source lists into public documentation/tests/memory. Per-site recipes are local configuration.
- Cloudflare verification shares the source session and uses real Chromium. Preserve user interaction for interactive challenges; do not introduce automated CAPTCHA clicking, solver services or fingerprint spoofing.

## Security and state

- The app renderer stays sandboxed with context isolation and no Node access. RPC requires zod input validation and the trusted main-window top frame.
- Webview guards strip preloads/Node, enforce configured partitions and navigation policy, and block unwanted downloads/popups.
- Tokens stay in the main process and use profile-bound OS encryption; preserve session-only behavior if secure storage is unavailable.
- Sign-in uses the system browser and `aniverse://` callbacks, single-use expiring state, and MAL PKCE. No provider secrets belong in the renderer.
- Sync is local-first, with coalesced jobs/backoff, reconciliation and removal tombstones. Preserve queue semantics during account failures/reconnects.
- Adblock owns the relevant source-session webRequest hooks. The project wires Ghostery per partition and registers cosmetic IPC once; avoid adding conflicting listeners or repeated global helper registration.

## Established UI behavior

- Compact dark UI with existing accent/density tokens, custom controls, scrollbars and context menus.
- The website watch path hides page chrome/navigation behind the cat loader while navigating; preserve the loader keyed before webview attachment and player focus CSS.
- Shared release gating handles upcoming titles, future episodes and cinema releases. AniList status alone is insufficient.
- Preserve the six existing cat-frame WebP assets and `CatLoader.tsx`. Historical source drawings lived under `.idea/`; new image-based experiments must use the user's `test/images/` location. Do not recreate the artwork without a request.
- YouTube embeds require the existing referrer handling in `WebSession.tsx`. Do not repeatedly reload the initial URL on `dom-ready`.

## Memory hygiene

Preserve existing Claude files. Treat its environment observations, network outcomes and test passes as dated reports. Do not translate them into current successful checks or incomplete-work assumptions. Record substantive changes to these decisions only when supported by user direction or inspected implementation.

## 1.5.3 layout, changelog and casting decisions (2026-10-29)

The user clarified that themes mean structural UI layouts. Classic preserves the original rail; Studio uses a permanent labelled sidebar/dashboard; Cinema uses top navigation and an episode shelf below playback. Legacy style IDs remain compatible. In-app changelogs are bundled offline with icons, Added/Improved/Fixed colours, feature links and a per-profile lastSeen receipt.

For website casting the user delegated the choice of approach. Use scoped mirroring of the owned source webContents plus its own audio. Do not extract website streams or capture desktop/system audio/camera/microphone. Main issues one fresh capture grant to the trusted host top frame; bounded ordered renderer chunks feed embedded FFmpeg. Normal output is H.264 1080p, optional Anime4K output HEVC 4K. Capture ends on navigation/episode exit/stop. Tests use controlled receiver transport; physical-TV compatibility remains unverified.
