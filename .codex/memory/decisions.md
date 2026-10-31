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

## 1.5.6 casting and upscaling recovery (2026-10-29)

The reported TV was visible in Windows + K but absent from Google Cast. These are different protocols. Provide the Windows Miracast chooser with explicit system-screen/audio sharing guidance; keep Google Cast-specific processing controls separate. Windows owns pairing/resolution/disconnect. Never claim discovery/pairing merely because a URI launch succeeded.

For origin-blocked website video, compatibility upscaling uses a video-only capture of the selected source webContents and a host-renderer GPU overlay; original audio/controls remain on the source. PlayerCapture owns the sole display-media handler for both upscaling and Google Cast mirror grants. It validates ownership, trusted frame, gesture, purpose/audio shape and expiry, and releases on navigation. Never return a desktop/device-audio source from this broker. Windows projection is a separately labelled system route. See docs/TROUBLESHOOTING-CAST-UPSCALE.md.

The 1.5.6 investigation also reproduced a separate WebGL 1 shader failure in the pinned Anime4K.js Darken/Thin fragments: integer max plus a uniform-dependent Gaussian loop bound. app/shared/lineEffects.ts specializes the loop bound per MAIN height through a constructor-local WebGL adapter. Do not patch WebGL globals or edit node_modules. Runtime GPU work is completed one frame at a time, with an 80 ms freshness deadline, seek-stale rejection, smaller models after sustained lateness and original-picture fallback. Original audio/media time are never sought or rate-adjusted to hide filter lag; compatibility capture may still add baseline delay.

## Catalogue audio contract, clarified 2026-10-31

DUB includes a series with both SUB and DUB, including SUB 12 / DUB 11. SUB includes mixed and sub-only series. Home/Browse must work on a fresh profile from the selected source's public catalogue, without requiring watch history or session observation hints. Episode filters use individual episode availability. ALL retains AniList discovery. Source counts and paging remain source-specific; an unreadable layout is an actionable error, not an empty dub catalogue. The old 2.0.2 latest-episode/session-hint implementation does not meet this contract.

2026-10-31 one-time release cleanup: while approving 2.1.1, the user explicitly requested removing all other GitHub releases. Publish and verify the new signed assets first, then remove the older release records/assets. This does not authorize rewriting Git history or deleting source tags, and is not an automatic retention policy for later releases.
