# AniVerse2 3.1.1 for Windows x64

- Save selected clear HLS video when its media segments use image-like filenames. The downloader matches observed requests to the playlist and checks actual media bytes before assembling them in playlist order.
- Preserve the selected video rendition and matching audio. Include an accessible selected or default WebVTT subtitle track in the MP4, with timestamp alignment checked against the media timeline.
- Coordinate refresh work through the existing background manager: wait for settings initialization, share duplicate jobs and failures, limit concurrent work, and back off after recoverable errors. Hidden Home pages stop periodic refresh work.
- Keep manual refresh feedback separate from ordinary background queries. Cancel obsolete work and discard stale results instead of starting overlapping replacements.
- Bundle the pinned FFprobe alongside FFmpeg for subtitle synchronization; no system media-tool installation is required.

Downloads require playable clear media and a complete on-demand playlist. Subtitle availability depends on the selected player. Genuine images and protected or incomplete streams are not assembled as video.

The Windows installer and signed updater retain the existing AniVerse2 identity. Electron and Android use separate release channels.
