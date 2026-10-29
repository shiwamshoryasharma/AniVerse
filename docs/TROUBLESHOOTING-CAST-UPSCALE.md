# Casting and upscaling: recovery steps

## Chrome can cast to the TV but AniVerse cannot

Install 1.5.7 or newer and choose **Cast to TV → Find TVs with Chrome → your TV**. This uses installed Google Chrome’s Media Router rather than AniVerse’s direct CASTV2/Default Media Receiver path. A separate, app-owned Chrome window receives the selected video. It does not use the normal Chrome profile or change Windows display resolution.

If several receivers have the same name, AniVerse prepares the player and asks you to use **Chrome’s Cast menu → Sources → Cast tab** in that window. Choose the correct TV there. Stop through AniVerse or close the companion. Do not close/minimize the source episode while mirroring.

For website episodes, keep **Include website audio** enabled and use the TV’s speakers. All filtering/encoding stays on the sender. Chrome negotiates final TV output quality; a processed 4K input is not a guarantee of 4K tab output. Try standard 1080p if HEVC decoding or GPU load is a problem.

The 1.5.7 test host verified real Chrome video/HEVC playback and discovery API access but received no TV announcements. A physical-TV connection and lip-sync result are still unverified.

## AniVerse looks blurry after clicking Cast

Version 1.5.7 removes the cast dialog’s intentional background blur and checks that opening/closing the chooser preserves app zoom, viewport and device pixel ratio. Chrome casting does not invoke Windows projection.

If you already connected through Windows wireless display, Windows may have changed desktop resolution or scaling. Disconnect through Windows + K and restore the monitor’s recommended resolution/scale in Windows Display settings. AniVerse does not force global display modes.

## The TV appears in Windows Cast but AniVerse’s Google Cast list is empty

Windows + K discovers **Miracast wireless displays**. Chromecast / Google TV uses **Google Cast**. A TV can support one without the other.

1. Open an episode and choose **Cast to TV**.
2. Under **Windows wireless display**, choose **Find wireless displays**.
3. Select the TV in Windows and approve its connection on the TV.
4. Play the episode. Use **TV audio** if Windows selected a different sound output.
5. Use Windows + K to disconnect. Windows owns this connection; AniVerse’s Google Cast Stop button does not disconnect Miracast.

Windows projection can share the desktop and other visible apps. Use Extend and move AniVerse to the TV for a separate display. For 4K, choose 3840 × 2160 in Windows Display settings if that mode is offered. PC/TV/driver/connection support determines available modes; the Google Cast HEVC switch cannot configure Miracast.

For an actual Google Cast receiver, connect it to the same reachable LAN, scan again and check whether a VPN or firewall blocks multicast discovery. AniVerse does not change firewall/security settings automatically.

## “Anime4K could not process this video”

A website can play a cross-origin video while refusing WebGL access to its pixels. Browser extensions can have different permissions or capture paths; normal page WebGL does not automatically get those privileges.

1. Keep the episode’s original player playing.
2. Enable Anime4K in the episode’s **Anime4K Upscale** section.
3. Choose **Use compatibility upscaling** below the section.
4. Use player-only mode so the selected source view contains the video.
5. Choose Mode A/B/C or a combined preset. The status changes to **Compatibility · Anime4K …** when GPU processing is active.
6. Choose **Stop compatibility upscaling**, disable Anime4K or leave the episode to release capture.

Compatibility mode captures only the selected source webContents, including cross-origin player frames, and filters those displayed frames locally. It requests no microphone/camera/system audio, records no video and extracts no media URL. The original player supplies audio and receives controls. Capture may add some video delay. A working WebGL GPU is still required.

Protected/DRM content can be black or refuse capture. An inaccessible GPU or protected video cannot be made universally compatible by this path. Stop compatibility mode to return to the original view; inspect Settings → Graphics & GPU if GPU initialization fails.

## What was verified

The 1.5.6 fixture reproduces a SecurityError from WebGL on a video served without CORS permission, including a cross-origin iframe. All six Anime4K presets process captured frames up to 4K while source playback/audio continue, and stop/navigation release the stream. This checks the recovery mechanism, not every website or a universal quality improvement.

[Windows wireless-display guide](https://support.microsoft.com/en-gb/windows/hardware/display-graphics/screen-mirroring-and-projecting-to-your-pc-or-wireless-display), [playback architecture](PLAYBACK.md).

## Audio/video timing gets worse with upscaling enabled

1. Install 1.5.6: it repairs Darken/Thin shader compilation and prevents an accumulating queue of GPU work.
2. AniVerse only presents filtered output that completes within its frame deadline. It automatically tries lighter shader models when rendering falls behind.
3. If the GPU remains too slow, the filtered overlay is hidden and the original picture/audio continue. Reduce line effects or use a lighter preset before retrying.
4. Compatibility capture itself can introduce some video delay; use direct filtering when it works, or stop compatibility mode if the added delay is noticeable.
5. If the original player is already out of sync with scaling off, try Playback Rescue or another source/server. Frame timing does not certify the source’s encoded audio/video synchronization.

The timing regression test injects 130 ms render delays and checks that delayed output is rejected while the source clock, playing state and audio remain intact. This is an overload-recovery check, not a measured lip-sync certification.

For TV playback, use the TV’s audio output rather than comparing a delayed TV picture with the PC speakers. The Windows route includes a TV audio button for output selection; Google Cast website mirroring has Include website audio. If a 4K receiver/connection cannot keep up, try standard 1080p casting or a lower Windows display mode. The 1.5.6 encoder check verifies early and late HLS presentation timestamps over at least 14 seconds; physical TV transport and decoder delay still need testing on the actual TV.
