# Changelog

AniVerse also includes this history in **Settings → Changelog**, with release highlights shown after updates.

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
