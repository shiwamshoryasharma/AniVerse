// Tests real sitePage DOM operations in hidden Electron without network or the app profile.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cache = path.join(root, 'test/cache/player-focus');
const temporary = path.join(cache, 'temp');
mkdirSync(temporary, { recursive: true });
await build({
  entryPoints: [path.join(root, 'electron/sitePage.ts')],
  outfile: path.join(cache, 'site-page.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'warning',
});
await build({
  entryPoints: [path.join(root, 'electron/mediaPage.ts')],
  outfile: path.join(cache, 'media-page.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'warning',
});
const child = spawn(createRequire(import.meta.url)('electron'), [path.join(root, 'test/e2e/drivers/player-focus.cjs')], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    ANIVERSE_FOCUS_ROOT: root,
    ANIVERSE_DATA_DIR: path.join(cache, 'profile'),
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
  },
});
child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code) => { process.exitCode = code ?? 1; });
