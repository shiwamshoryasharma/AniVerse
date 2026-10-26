# Playback and GPU support

AniVerse preserves the website's original media element/player. Its audio, subtitle tracks, controls and decoder continue to use that player's timeline. It does not extract private stream URLs or build a second unsynchronized media pipeline.

Player-only mode rejects hidden/CAPTCHA frames and hides unrelated website siblings without deleting DOM nodes. Layout remains available to the existing SUB/DUB/server discovery.

## Playback Rescue

The watch page samples the existing player every three seconds. It reports native video dimensions, buffered seconds, interval frame rate and dropped-frame percentage. Frozen frames can be detected even when the media clock advances. Recover seeks the same media element to its current position and preserves paused/playing state; it does not reload or replace the stream.

These counters cannot measure audio/video lip-sync. A badly timestamped source or unavailable track needs another server or source. SUB/DUB choices reflect controls available on the episode; the app does not manufacture missing dubbed audio.

## Hybrid laptop graphics

Before GPU initialization, AniVerse requests Electron's documented `force_high_performance_gpu` preference. Hardware acceleration and Chromium's driver safeguards remain enabled. Settings → Graphics & GPU → Overview shows the adapter actually selected and all detected adapters, including integrated/software/unknown devices. Unknown names are not guessed to be discrete.

Windows and driver policy can override selection. If a dedicated GPU is detected but another adapter stays active, select High performance for AniVerse in Windows Graphics settings and restart AniVerse. Adapter selection does not prove the decoder for each individual codec is on that adapter.

For battery use/troubleshooting, launch with `--force_low_power_gpu`, or set `ANIVERSE_GPU_PREFERENCE=system` before starting the app. An explicit low-power choice takes precedence over the default high-performance request.

NVIDIA's driver can provide RTX Video enhancements for eligible playback. Enable the feature in NVIDIA's video settings; the UI does not claim it is active based only on GPU availability. A separate RTX Video SDK integration would require native frame-processing/rendering work.

Sources: [Electron GPU switches](https://www.electronjs.org/docs/latest/api/command-line-switches#--force_high_performance_gpu), [Electron GPU information](https://www.electronjs.org/docs/latest/api/app#appgetgpuinfoinfotype), [NVIDIA RTX Video SDK](https://developer.nvidia.com/rtx-video-sdk).

## Settings and typography

Graphics & GPU has separate Overview, Laptop GPU setup and NVIDIA RTX Video menus, with colored status icons and illustrated steps. It does not show the executable's filesystem path. Profile & appearance has a saved UI font selector and live preview: Inter, system UI, Arial, Georgia and Consolas, using local font fallbacks without external downloads.

## Checks

All test machinery is under `test/`. `npm test` covers GPU classification and video-health logic. `node test/e2e/player-focus.mjs` exercises the real focus CSS, serialized DOM operations and media probe/control scripts in hidden Electron with neutral fixtures.

The fixture checks retain the original video, controls and captions, reject hidden/decoy/challenge frames, and verify that recovery does not read or change media URLs. They do not certify every live website or physical hybrid-laptop configuration.
