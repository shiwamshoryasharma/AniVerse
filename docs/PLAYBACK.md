# Playback and GPU support

AniVerse preserves the website's original media element/player. Its audio, subtitle tracks, controls and decoder continue to use that player's timeline. It does not extract private stream URLs. Compatibility upscaling (below) adds a video-only compositor capture for rendering; audio stays with the original player.

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

## Anime4K and sender-side 4K casting (1.5.2)

Settings → Player and native-player 4K controls expose six Anime4K presets plus darken/thin effects. GPU filters process the existing decoded video, preserving audio and the source timeline. Native output fits within 3840 × 2160 without stretching. Website frames are filtered only when WebGL pixel access is allowed; CORS/protected-media failures keep the original player running. Disabling or changing sources releases filter resources.

For TV output, open a local video and choose Cast → **4K · process on this device**. The sender runs the embedded FFmpeg/FFprobe 9.0.2 tools, applies bundled Anime4K shaders through Vulkan/libplacebo, and encodes HEVC video plus AAC audio into HLS. Frames are fitted and padded to exactly 3840 × 2160. NVIDIA, Intel and AMD encoder availability is tested before use; CPU encoding is a fallback and may be too slow for real-time 4K.

The TV receives a processed media stream and decodes it; it does not perform Anime4K. It must support 4K HEVC and Google Cast. Older/1080p receivers cannot become 4K devices through software. LAN bandwidth and sender GPU/CPU capacity remain practical limits. Direct casting retains its existing media-URL path. Website streams are not extracted for casting.

The temporary HLS server uses a per-session random token, restricts filenames, supports byte ranges and bounds the rolling segment window. Stop, connection failure and app shutdown terminate owned encoding work and close the server. Pause/seek/resume can restart the encoder at the selected media position. No system FFmpeg installation or runtime executable download is used.

Native browser caption overlays are not burned into the FFmpeg output. Existing receiver-supported subtitle tracks remain separate. Browser upscaling does not follow into system PiP; use the dedicated sender path for processed TV output.

[Google Cast codec support](https://developers.google.com/cast/docs/media), [FFmpeg libplacebo](https://ffmpeg.org/ffmpeg-filters.html#libplacebo), [embedded notices](THIRD-PARTY.md).

## Checks

All test machinery is under `test/`. `npm test` covers GPU classification and video-health logic. `node test/e2e/player-focus.mjs` exercises the real focus CSS, serialized DOM operations and media probe/control scripts in hidden Electron with neutral fixtures.

The fixture checks retain the original video, controls and captions, reject hidden/decoy/challenge frames, and verify that recovery does not read or change media URLs. They do not certify every live website or physical hybrid-laptop configuration.

## Episode casting and interface layouts (1.5.3)

The Watch page has a labelled **Cast to TV** action above the player. Native/local media opens the existing receiver chooser. Website episodes open a separate chooser for mirroring the selected source view and its optional audio. Standard output is H.264/AAC at 1920 × 1080; the 4K option runs the bundled Anime4K shader and HEVC encoder locally at 3840 × 2160.

Electron captures the owned source webContents and its audio through a short-lived, single-use grant. The app does not capture the desktop, camera, microphone or other app audio. Capture stops on episode/source navigation, unmount, Stop casting or shutdown. Protected media can refuse capture. Keep the site player visible; mirroring has live-stream delay and seeks use the original website player.

Classic keeps the original rail. Studio has a permanent labelled sidebar and dashboard navigation. Cinema has horizontal navigation, a wide player and episodes below it. Settings → Interface themes selects structure; accent and typography are separate preferences.

Release notes are bundled offline in app/shared/changelog.ts. New versions show highlights once per profile acknowledgement, with a persistent header action and Settings → Changelog history.

## Miracast and compatibility upscaling (1.5.6)

Windows + K displays use Miracast, independently of the Google Cast list. Both AniVerse casting menus provide a fixed, validated Windows chooser action. Windows owns discovery, pairing, screen/audio sharing and display resolution; a successful launch is not a paired-TV claim. Use Windows + K to disconnect. The Google Cast HEVC option does not change Windows projection modes.

When direct website filtering fails, Use compatibility upscaling captures only the owned source view (video only), feeds those origin-clean displayed frames through Anime4K in the host renderer, and overlays the result with pointer events disabled. Source audio/controls remain with the original player. A shared PlayerCapture broker prevents conflicting handlers and restricts fresh grants to the trusted host frame and owned source webContents. It does not relax web security or extract media URLs.

Capture may introduce some video delay; protected content and unavailable GPUs remain limits. [Recovery instructions](TROUBLESHOOTING-CAST-UPSCALE.md) cover both routes.

The 1.5.6 line-effect adapter fixes WebGL 1 shader compilation in both native and website paths. Rendering has one GPU frame in flight; completed output older than the 80 ms render/media-clock deadline is hidden. Sustained lateness tries smaller shader models, then stops the filtered overlay. This keeps the original player authoritative and avoids seeking audio to compensate for an accumulating GPU queue. It does not repair a source that is already out of sync.

## Chrome-backed tab casting (1.5.7)

Both pickers offer **Find TVs with Chrome**. The main process launches installed Chrome with a dedicated cast-chrome profile, an inherited debugging pipe and a token-protected loopback companion. Normal Chrome profile data is never copied. Chrome supplies receiver discovery and Cast tab routing; AniVerse does not emulate Chrome’s proprietary/browser mirroring pipeline.

Website capture retains the same owned-source grant and embedded encoding path. Chrome fetches the resulting HLS locally on 127.0.0.1, avoiding TV access to AniVerse’s LAN HTTP port. Native local files use the existing token-protected server. The companion bundles hls.js; it does not fetch external scripts or source-site cookies.

A unique receiver name starts tab mirroring through Chrome’s Cast API. Duplicate names require a native Chrome-menu choice after the selected player is loaded. Stop, companion closure/navigation, route end and application shutdown release owned resources; unused discovery windows expire after two minutes. CDP's Cast domain is experimental, so errors stay visible and direct Google Cast remains available.

Opening a picker does not launch Windows projection or change AniVerse zoom/DPI. The website dialog dims its backdrop without blur. Windows Miracast is a separate optional section with explicit screen-sharing and display-mode guidance.

The 4K option controls sender filtering/encoding, not Chrome’s final mirroring resolution. Chrome/receiver/network capabilities determine TV quality. Physical TV casting and lip sync require hardware validation.
