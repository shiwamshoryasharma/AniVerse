// Development runner: Vite dev server for the renderer, esbuild watch for the
// main/preload bundles, and an Electron process restarted on main changes.
import { context } from 'esbuild';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {prepareSecurity} from './prepare-security.mjs';
import { mainOptions, preloadOptions } from './build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronBinary = createRequire(import.meta.url)('electron');

prepareSecurity();
const server = await createServer({ configFile: path.join(root, 'frontend/vite.config.ts'), mode: 'development' });
await server.listen();
const devUrl = server.resolvedUrls.local[0];
console.log(`[dev] renderer at ${devUrl}`);

let child = null;
let restarting = false;
function startElectron() {
  child = spawn(electronBinary, ['.'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ANIVERSE_DEV_URL: devUrl, ELECTRON_ENABLE_LOGGING: '1' },
  });
  child.on('exit', (code) => {
    if (!restarting) {
      void server.close();
      process.exit(code ?? 0);
    }
  });
}

function restart() {
  if (!child) return startElectron();
  restarting = true;
  child.once('exit', () => {
    restarting = false;
    startElectron();
  });
  child.kill();
}

let ready = 0;
const reloadPlugin = {
  name: 'electron-restart',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      if (++ready >= 2) restart();
    });
  },
};

const mainCtx = await context({ ...mainOptions, plugins: [reloadPlugin] });
const preloadCtx = await context({ ...preloadOptions, plugins: [reloadPlugin] });
await Promise.all([mainCtx.watch(), preloadCtx.watch()]);
