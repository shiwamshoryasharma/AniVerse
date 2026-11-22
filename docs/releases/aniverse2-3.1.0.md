# AniVerse2 3.1.0 for Windows x64

- Restore the saved desktop palette, layout and custom surface colours on Home at startup. Appearance no longer waits for the Settings page to load.
- Profiles without a valid saved rendering preference use Stable UI to reduce dependence on the accelerated compositor. Explicitly saved rendering choices are preserved.
- Pass rendering options directly to the main WebView2 environment, preserving browser defaults, inherited options and browser isolation.

This release addresses appearance restoration and graphics compatibility. The reported recurring freezes on an Intel PC have not been reproduced on physical Intel hardware; this release does not claim Intel hardware certification.

The Windows x64 installer keeps the existing AniVerse2 installation identity, signed updater channel and profile data. Electron and Android remain separate release channels.
