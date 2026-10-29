# Embedded media components

## Anime4K

Browser filtering uses `anime4k.js` 1.1.3 (MIT), a WebGL port of Anime4K 4.0.1. Sender-side casting uses unmodified mpv-hook GLSL shaders from bloc97/Anime4K commit `7684e95`.

Source shader files and both copyright/license notices are in `assets/anime4k/`. The installer includes them under its resources/anime4k directory. Preset A/B/C and stronger variants select real restore, soft-restore, denoise and optional darken/thin filters.

[Anime4K.js source](https://github.com/monyone/Anime4K.js), [Anime4K source](https://github.com/bloc97/Anime4K/tree/7684e95).

## FFmpeg / FFprobe

Windows x64 builds embed the unmodified Gyan full static FFmpeg **9.0.2** tools, licensed GPLv3. AniVerse does not search PATH for them, download executable tools at playback time, or modify a system installation.

`config/ffmpeg.json` pins the release, archive URL, SHA-256 and upstream source revision. `npm run media:prepare` downloads/verifies the archive and prepares `build/vendor/ffmpeg/`; production builds call this automatically. Download/extraction scratch data stays under `test/cache/vendor/`. Packaged tools, their original GPL license, build/dependency information and hash manifest are under resources/ffmpeg.

To update embedded FFmpeg, review the new upstream build, update the pinned manifest/checksum, rebuild and validate the encode path, then ship a new AniVerse release. Existing installed tools update with AniVerse.

- [Original binary archive](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-full_build.7z)
- [Published archive checksum](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-full_build.7z.sha256)
- [FFmpeg corresponding source archive](https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz)
- [Exact upstream revision](https://github.com/FFmpeg/FFmpeg/commit/946fcce07b)
- [Distributor build details](https://www.gyan.dev/ffmpeg/builds/)
- [FFmpeg license and legal information](https://ffmpeg.org/legal.html)

The original distributor README shipped alongside the binaries records build settings and external library versions. Preserve these notices, the source information and applicable source-distribution obligations when redistributing the binaries.
