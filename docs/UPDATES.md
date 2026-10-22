# Self-update

Installed copies of AniVerse update themselves from this repository's **GitHub Releases**.

```text
Your development machine   npm run dist:signed: signed installer + .blockmap + latest.yml
        │
        ▼
GitHub Releases            npm run release: tag v<version> and upload the three files (+ SHA-256)
        │
        ▼
AniVerse checks            at start-up (after 15 s) and every 6 hours: is latest.yml newer than me?
        │
        ▼
Download and apply         only the changed blocks when possible, signature checked,
                           installed silently on restart (or when AniVerse quits)
```

## In the app

**Settings → About → Updates** shows:
- the installed version and where the update stands;
- **Check for updates**, then **Download** or **Restart to update** as they apply;
- **What's new**, which opens the release page;
- two switches:
  - **Check for updates automatically** (on by default);
  - **Download updates automatically** (on by default; when off, you're asked first).

While an update downloads, or once it's ready, the top bar shows a pill. **Restart to update** quits AniVerse, runs the new installer silently and starts the new version. If you don't restart, the update installs when you quit AniVerse.

Your library, history, settings and AniList / MyAnimeList sign-ins live in `%APPDATA%\AniVerse` and are never touched by an update. The same goes for your install folder and shortcuts: the installer recognises an update (`--updated`) and skips its pages.

Updates are **off** for:
- development builds (`npm run dev` / `npm start`);
- the portable `.exe`;
- unsigned builds (`npm run dist` / `dist:installer`). Their feed names no publisher, so a downloaded file could not be verified.

Each case says why in Settings.

## How it works

| Piece | What it does |
| --- | --- |
| `electron-builder.yml` → `publish` | GitHub provider (`shiwamshoryasharma/AniVerse`). Every build writes `resources/app-update.yml` (feed address, publisher name, updater cache folder). `release/` gets `latest.yml` (version, file name, size, SHA-512) and the installer's `.blockmap`. |
| `electron/updater.ts` | `UpdateService` around **electron-updater**: checks, download progress, install on restart/quit, state pushed to the UI as `update.status`, log in `%APPDATA%\AniVerse\logs\updates.log`. |
| `electron/updateSignature.ts` | The signature check every download must pass (below). |
| `frontend/src/components/Updates.tsx`, `pages/Settings.tsx` | Top-bar pill and the Updates settings. |
| `scripts/releaseConfig.mjs` | One release configuration: signed, publisher name, no bundled site list. |
| `scripts/release.mjs` | Checks and publishes a release (below). |

**Differential download.** Each installer comes with a `.blockmap`, a list of content-defined blocks with their hashes. The installed copy keeps its own installer in `%LOCALAPPDATA%\aniverse-updater\installer.exe`. To update, AniVerse fetches the old and new blockmaps and downloads only the blocks that changed, using HTTP range requests. It rebuilds the new installer from the old one and checks the result against the SHA-512 in `latest.yml`. If anything goes wrong, it falls back to downloading the whole installer.

**Signature check.** Before installing, the downloaded installer's Authenticode signature is read with `Get-AuthenticodeSignature`. It must meet both conditions:
- **intact**: Windows reports `Valid`, or `UnknownError`, which is what a self-signed certificate gives. A modified file reports `HashMismatch` and is rejected.
- **signed by a pinned certificate**: the SHA-256 fingerprint of the signer certificate must be listed in `config/signing.json` → `updateSigners`, which is compiled into the app. A file signed by anyone else is rejected, even with a certificate Windows trusts.

Rejected downloads are deleted and never run, and the reason appears in Settings. So a compromised release page alone can't push code to installed copies; that would also need AniVerse's private signing key.

## Publishing a release

1. Bump `version` in `package.json` (for example `0.2.1`), commit and push `main`.
2. Build the signed installer. This needs the code-signing certificate in your Windows certificate store; see [INSTALLER.md](INSTALLER.md#signed-release-build).
   ```bash
   npm run dist:signed
   ```
3. Write the release notes (Markdown), then publish:
   ```bash
   npm run release -- --notes path/to/notes.md
   ```
   The script refuses to publish when:
   - the working tree isn't clean, or `main` isn't pushed;
   - the tag already exists;
   - `latest.yml` is for another version;
   - the installer isn't signed with the configured certificate.

   Otherwise it tags `v<version>` and uploads the installer, `.blockmap`, `latest.yml` and a `.sha256` file with the GitHub CLI (`gh`).

Installed copies pick the release up on their next check. Always upload the **`.blockmap`**: the next version needs it as its differential base. Never edit a published release's files: `latest.yml` pins the installer's SHA-512.

**Changing the signing certificate** (for example to a CA-issued one):
1. Ship one release, still signed with the old certificate, whose `updateSigners` lists **both** fingerprints.
2. Sign the releases after that with the new certificate.

Copies that skip the bridge release can't verify the new signature and won't update until reinstalled by hand.

## Testing

```bash
npm run build
```

```bash
npm run test:update
```

`test/e2e/updater.mjs` does a real update on this machine:
1. Builds AniVerse twice as signed installers (test versions 90.0.0 and 90.0.1), each with a feed pointing at a local server on `127.0.0.1:47811`. The server supports single-range requests, like GitHub.
2. Installs 90.0.0 silently with a throwaway profile.
3. Lets it find, download (differentially) and verify 90.0.1, then closes it so the update installs on quit.
4. Checks the installed version and the registry entry, that the download was differential, that the signature check passed, and that the Start Menu shortcut and profile are intact.
5. Uninstalls.

The report is written to `test/artifacts/updater.json`. `UPDATE_KEEP=1` keeps the two builds for a faster re-run. The unit tests (`test/unit/updates.test.ts`) cover the signature decision: intact and pinned, tampered, other signer, unsigned.
