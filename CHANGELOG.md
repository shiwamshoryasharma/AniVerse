# Changelog

AniVerse also includes this history in **Settings → Changelog**, with release highlights shown after updates.

## 2.0.2 — 2026-10-31

- 🔎 Resolve named arcs and alternate English/romaji/Japanese titles even when only another metadata alias contains the season number. Explicitly different seasons and parts/cours remain separate; ordinal, shorthand, Roman and Japanese numeric markers are normalized.
- 🎬 Episode cards can use the source's actual per-episode artwork, including lazy-loaded images and opaque episode links. Images are read-only, bounded grants fetched through the original isolated source session. No stream extraction or replacement is added.
- 🔊 Add **ALL | DUB | SUB** to the episode list, home Latest Episodes and Browse. Only explicit source badges confirm language availability. Latest Episodes checks the specific episode, not merely an earlier dubbed episode of the same series.
- 🔒 Artwork grants expire/revoke with their source owner, do not expose source cookies, use origin-only referrers and do not persist image bytes. Spoiler Shield hides future artwork. Availability hints are session-local, excluded from sync, filtered by enabled sources and removed for private titles.

Home/Browse language filtering covers availability observed from source pages during this app session. AniList's catalogue does not provide reliable dub status; unknown titles remain in ALL. A source without per-episode images keeps the existing metadata artwork or neutral placeholder.

## 2.0.1 — 2026-10-30

- 🛡️ **Embedded Rust policy:** bounded, import-free WebAssembly checks source URLs, local-network destinations, source navigation and app asset identity.
- 🔒 **Software hardening:** exact trusted origins, own-property RPC dispatch, input/call budgets, app CSP and strict read-only media grants.
- 📦 **Production safeguards:** disable Node environment/inspector entry points; validate ASAR integrity and load only the signed application bundle.
- 🪔 **Temporary branding:** vector logo, running-window icon and lamp/pumpkin buffer; standard branding and the cat return in January, with reduced motion respected.
- 🎬 **Preserve playback:** normal/4K media, original controls and navigation remain; disposed iframe lifecycle handling is fixed.

[Full 2.0.1 release notes](docs/releases/2.0.1.md) · [Security scope](docs/SECURITY-ARCHITECTURE.md)

## 1.5.8 — 2026-10-30

- 🪔 **Diwali × Halloween:** restrained violet/ivory/amber dark palette, automatic through December with previous colours restored in January; early opt-out and later manual selection.
- 🎬 **Episode index:** thumbnail cards, active/watched indicators, search and grid/list controls with Spoiler Shield preserved.
- 🔎 **Search and recovery:** English, romaji and Japanese aliases, broader nearby word results, and bounded fallback across enabled TXT sources when content is missing.
- 🔒 **Private viewing:** temporary incognito and persistent private-title rules, memory-only website sessions, no new playback records or future sync, and private-title exclusion from new backups.
- 🖼️ **Player geometry:** correct cropped/offset videos, embedded player documents and Anime4K overlay alignment.
- 🚫 **Ad-blocker update:** deny same-site popups, protect top-frame redirects, inject cosmetic rules into the requesting frame, refresh filters automatically and expose Update filters.

- 🔍 **Clear interface:** removed remaining backdrop blur from dialogs, release highlights, menus and navigation overlays.
- 🖥️ **Stable Windows UI:** software window composition avoids the GPU presentation path while preserving available GPU video decoding, WebGL filtering and sender encoding.
- ⚙️ **Rendering choice:** Settings → Graphics & GPU offers device-local Stable / Accelerated UI modes, with explicit restart status.
- 🧪 **Regression coverage:** repeated resizes, fractional display scales, real GPU WebGL, video-codec availability and mode persistence across restarts.

[Full 1.5.8 release notes](docs/releases/1.5.8.md)

## 1.5.7 — 2026-10-29

- 📺 **Chrome casting:** uses installed Google Chrome’s native receiver discovery and tab-casting transport with an isolated companion window.
- 🔍 **Sharp UI:** removes cast backdrop blur; opening a cast chooser keeps AniVerse’s zoom, viewport and pixel ratio unchanged.
- 🧭 **Clear choices:** Windows Miracast is optional and separate; duplicate Chrome receiver names use an explicit native-menu choice.
- 🛑 **Cleanup:** cancelled native starts do not connect later; owned Chrome and media resources close when casting stops.
- 🎞️ **Sender processing:** existing embedded 4K HEVC input works in the companion. Chrome negotiates TV output resolution; 4K tab output is not guaranteed.

[Full 1.5.7 release notes](docs/releases/1.5.7.md)

## 1.5.6 — 2026-10-29

- 📺 **TV compatibility:** Windows Miracast chooser in both casting menus, with clear screen-sharing and 4K mode guidance.
- ✨ **Upscaling recovery:** GPU processing of selected-site capture when direct video pixel access fails, including cross-origin frames.
- 🖌️ **Line effects:** repaired Darken/Thin shader compilation across native and website video.
- ⏱️ **Playback timing:** bounded GPU work, lighter processing and original-picture fallback prevent delayed filtered-frame queues.
- 🔎 **Google Cast discovery:** cross-packet records, missing-record queries, interface scanning and network-error handling.

[Full 1.5.6 release notes](docs/releases/1.5.6.md) · [Recovery steps](docs/TROUBLESHOOTING-CAST-UPSCALE.md)

## 1.5.3 — 2026-10-29

- 🧩 **Layouts:** Classic, Studio and Cinema change navigation and episode placement.
- 📺 **Casting:** visible Cast to TV action, selected website video/audio mirroring, optional sender-side Anime4K 4K.
- ✨ **Discovery:** automatic update highlights, coloured feature cards and in-app release history.
- 🔒 **Capture:** single-use, owned-view grants; no desktop, camera or microphone capture.

[Full 1.5.3 release notes](docs/releases/1.5.3.md)

## 1.5.2 — 2026-10-29

- Anime4K presets and embedded local-video 4K casting.
- Google Drive app-data import/export using personal OAuth JSON and a stable backup format.
- Saved visual styles and distinct Settings icons.

[Full 1.5.2 release notes](docs/releases/1.5.2.md)
