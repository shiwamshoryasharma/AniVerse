# AniVerse2 3.1.2 for Windows x64

- Pause automatic query refresh from the native minimized-window state, including when WebView2 still reports the document as visible. Restore through the shared refresh manager without duplicate jobs. Admitted downloads and user operations are retained.
- Keep Save As tied to the same playing video while audio playlists and captions update. Real playback/document/episode changes still revoke the download.
- Suggest series/season/episode filenames from Watch metadata, preserving valid Unicode and sanitizing Windows filename characters. Explicit title/alias season numbers are used; otherwise the editable suggestion starts at season 1.
- Restore episode-card previews for delayed, lazy and cross-origin images through the owned source session, with bounded image conversion and revocation checks.

Clear complete VOD HLS with accessible audio and WebVTT captions remains required. Protected or unsupported streams are rejected. The installer retains the existing Windows preview identity and signed updater channel.
Graphics & GPU now explains interface compositing and offers **Use Accelerated UI and restart** for users who want to try GPU compositing for scrolling, menus and animations. It saves the preference before requesting restart, blocks duplicate pending actions and reports failures. Stable UI remains the compatibility default and reduced-motion preferences remain available.

A contained two-logical-processor native comparison confirmed substantially less raster-worker work with GPU compositing. The tool desktop exposed no foreground HWND and an approximately 30–32 Hz idle callback cadence, so this evidence does not establish physical display FPS or performance on Intel hardware.
