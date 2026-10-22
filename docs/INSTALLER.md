# Windows installer

`npm run dist:installer` produces `release/AniVerse-Setup-<version>.exe`: an assisted NSIS installer (electron-builder, `oneClick: false`) with AniVerse's own pages and styling. `npm run dist` builds the installer and the portable `.exe`.

## What the user sees

| Page | What happens |
| --- | --- |
| **Welcome** | One of six anime wallpapers, picked at random on every start, fills the page with the AniVerse wordmark and a dark fade where the title and text sit. The window fades in. |
| **Install folder** | Dark page with the wallpaper strip in the header. Default `%LOCALAPPDATA%\Programs\AniVerse`; **Browse** works on any drive (C:, D:, E: …). Shows real *Space required* and *Space available*. On Next the folder is checked (see below). |
| **Shortcuts** | Final install folder, required space and free space on that drive, plus **Create a desktop shortcut** and **Create a Start Menu shortcut** (both on for a first install; on reinstall they mirror the shortcuts that exist). The Next button reads **Install**. |
| **Installing** | The real extraction progress of the app archive (7-Zip plug-in), in the AniVerse purple. |
| **Finished** | Wallpaper page, *AniVerse is ready*, the install folder, and **Launch AniVerse now** (ticked by default). The checkbox only appears when every install step succeeded; the app starts only if it is ticked, as the normal (non-elevated) user. |

The uninstaller uses the same look: a wallpaper welcome page explaining that the library and accounts are kept (its button reads **Uninstall**), a themed progress page, and a wallpaper *AniVerse was uninstalled* page.

## Behaviour

- **No administrator rights.** The installer runs per-user (`RequestExecutionLevel user`) and skips electron-builder's "all users / only me" page unless a machine-wide copy already exists. Choosing a folder the user can't write to (e.g. `C:\Program Files`) is refused with an explanation; running the installer as administrator makes such folders usable.
- **Folder checks (on Next):** a valid path; enough free space on that drive (`GetInstDirError`, with the MB needed and free); a real write test in the target folder (folders created only for the test are removed again). `D:\` becomes `D:\AniVerse`, `D:\Games` becomes `D:\Games\AniVerse`.
- **Shortcuts** are created, kept or removed after electron-builder's own install steps, according to the checkboxes (`--no-desktop-shortcut` also works for silent installs). The uninstaller removes them.
- **Upgrades and reinstalls** replace the app files in place (the previous version is uninstalled silently first). **Uninstall** removes the app folder, shortcuts, the *Apps & features* entry and the `aniverse://` sign-in link handler (when it points at that copy). **`%APPDATA%\AniVerse` is never touched**: library, history, settings, profile images and the encrypted AniList / MyAnimeList sessions survive upgrades, reinstalls and uninstalls (`deleteAppDataOnUninstall: false`; only `--delete-app-data` removes them).
- **Offline.** The installer embeds the whole app (Electron runtime, renderer, ad-block engine, native-free SQLite); nothing is downloaded during installation and there are no runtime prerequisites to install.
- **Cancel** before *Install* asks for confirmation and leaves nothing behind; failures during extraction are reported by electron-builder's own retry/cancel dialog, and the finish page then offers no launch.

## How it is built

| File | Role |
| --- | --- |
| `electron-builder.yml` → `nsis` | Assisted, per-user, own folder page (`allowToChangeInstallationDirectory: false`), shortcuts on (then adjusted), `include: build/installer.nsh`, art paths |
| `build/installer.nsh` | All customisation through electron-builder's hooks: `customWelcomePage`, `customPageAfterChangeDir` (folder + shortcuts pages, progress styling), `customInstall`, `customFinishPage`, `customInstallMode`, `customUnWelcomePage`, `customUninstallPage` + `customHeader` (uninstaller finish page), `customUnInstall` |
| `assets/installer/wallpaper-1..6.jpg` | The six wallpapers (source of truth) |
| `scripts/make-installer-art.cjs` | Renders `build/installer/welcome-N.bmp`, `header-N.bmp`, `sidebar.bmp` (24-bit BMP, 1.5× the NSIS page size) — run by `npm run dist` |

Replace the wallpapers with `npx electron scripts/make-installer-art.cjs --import <six images>` (copies them into `assets/installer/`), then build. NSIS can only display BMPs, which is why the art is generated at build time.

electron-builder compiles NSIS with warnings as errors: functions and variables are declared separately for the installer and the uninstaller build, and functions that use Modern UI page variables or `SetBrandingImage` are defined after the page that declares them (or the first page) is inserted. Modern UI re-shows the light separator lines (controls 1035, 1036, 1045) on every page change, so each page's show function hides them.

To iterate on the NSIS script without repackaging the app: `npx electron-builder --win nsis --prepackaged release/win-unpacked --config electron-builder.yml`.

## Testing

```bash
npm run dist:installer
```

```bash
pwsh -NoProfile -NonInteractive -File test/e2e/installer-silent.ps1
```

Silent per-user install into a custom folder (`test/cache/install-silent`), reinstall, uninstall; checks the files, the *Apps & features* entry and install location, the Start Menu shortcut, and that `%APPDATA%\AniVerse` is byte-for-byte unchanged.

```bash
pwsh -NoProfile -NonInteractive -File test/e2e/installer-ui.ps1
```

Drives the real installer window off-screen page by page and saves `test/artifacts/installer-1-welcome.png … installer-8-uninstalled.png`: welcome, folder page, the refusal for `C:\Program Files\AniVerse`, a folder on E:, the shortcuts page (desktop shortcut unticked), sampled progress, the finish page, then the uninstaller. It checks the desktop shortcut is absent, the Start Menu shortcut present, and everything removed again after uninstalling. Run it from a standalone `pwsh` (the in-app PowerShell host has no console), and expect the window to flash briefly while it fades in.

## Known limits

- NSIS draws push buttons (Back / Next / Cancel / Browse) with the Windows theme; they can't be recoloured without an extra skinning plug-in.
- Page changes aren't animated (NSIS has no transitions); only the window fades in.
- The "not enough space" message uses NSIS's own space check and wasn't exercised on a nearly full drive.
- The installer isn't code-signed, so SmartScreen may warn on first run until it is signed.
