import { app } from 'electron';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { DEEP_LINK_SCHEME } from './oauth';

/**
 * Registers `aniverse://` with the OS so provider sign-in pages can hand control
 * back to the app. Packaged installers also declare the scheme
 * (electron-builder.yml → protocols); this covers portable builds and dev runs.
 */
export function registerDeepLinks() {
  // `electron .` in development: the OS must launch Electron *with this app's folder*.
  const registered =
    process.defaultApp && process.argv.length >= 2
      ? app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])])
      : app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  // Browsers ask "Open <app>?" using Windows' friendly name for the handler, which
  // for a development run would be "Electron". Name it on AniVerse's own key only.
  if (registered && process.platform === 'win32') {
    const key = `HKCU\\Software\\Classes\\${DEEP_LINK_SCHEME}\\shell\\open`;
    execFile('reg', ['add', key, '/v', 'FriendlyAppName', '/t', 'REG_SZ', '/d', app.getName(), '/f'], { windowsHide: true }, (err) => {
      if (err) console.warn('[deep-link] could not set the handler name:', err.message);
    });
  }
}

/** The `aniverse://` link in a command line (Windows/Linux pass it as an argument). */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  return argv.find((a) => a.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}://`)) ?? null;
}
