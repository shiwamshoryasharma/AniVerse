// Production build: Electron main + preload with esbuild, renderer with Vite.
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { oauthDefine } from './oauthConfig.mjs';
import { prepareSecurity } from './prepare-security.mjs';
import { prepareMediaRuntime } from './prepare-media.mjs';
import { prepareMediaTransfer } from './prepare-media-transfer.mjs';
import { prepareQuantumAudio, copyQuantumAudio } from './quantum-assets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const guestUpscale = await build({ entryPoints: [path.join(root, 'electron/upscaleGuest.ts')], bundle: true, platform: 'browser', format: 'iife', globalName: 'AniVerseUpscale', minify: true, write: false, logLevel: 'warning' });

const chromePlayer = await build({ entryPoints: [path.join(root, 'electron/cast/chromePlayer.ts')], bundle: true, platform: 'browser', format: 'iife', minify: true, write: false, logLevel: 'warning' });

export const mainOptions = {
  entryPoints: [path.join(root, 'electron/main.ts')],
  outfile: path.join(root, 'dist/electron/main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  // Ghostery resolves its preload script from node_modules at runtime.
  external: ['electron', '@ghostery/*', 'node:sqlite'],
  // AniVerse's OAuth client IDs (config/oauth.json) are compiled in; restart `npm run dev` after changing them.
  define: { ...oauthDefine(), __ANIVERSE_UPSCALE_SCRIPT__: JSON.stringify(guestUpscale.outputFiles[0].text),
    __ANIVERSE_CHROME_PLAYER_SCRIPT__: JSON.stringify(chromePlayer.outputFiles[0].text),
    __ANIVERSE_DOWNLOAD_SCRIPT__: JSON.stringify(readFileSync(path.join(root, 'electron/sourceMp4Guest.js'), 'utf8')),
    __ANIVERSE_QUANTUM_GUEST_SCRIPT__: JSON.stringify(readFileSync(path.join(root, 'electron/quantum-guest.js'), 'utf8')) },
  logLevel: 'warning',
};

export const preloadOptions = {
  entryPoints: [path.join(root, 'electron/preload.ts')],
  outfile: path.join(root, 'dist/electron/preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'chrome140',
  sourcemap: 'inline',
  external: ['electron'],
  logLevel: 'warning',
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareSecurity();
  await prepareMediaRuntime();
  await prepareMediaTransfer();
  if (process.platform === 'win32') await prepareQuantumAudio();
  // Only the renderer output is cleared (Vite's emptyOutDir); dist/electron is overwritten in place
  // so a running `npm run dev` session keeps its main bundle.
  await Promise.all([build({ ...mainOptions, minify: true }), build(preloadOptions)]);
  await viteBuild({ configFile: path.join(root, 'frontend/vite.config.ts'), mode: 'production', logLevel: 'warn' });
  if (process.platform === 'win32') await copyQuantumAudio(path.join(root, 'dist/renderer'));
  console.log('Build complete → dist/');
}
