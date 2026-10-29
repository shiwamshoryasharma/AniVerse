// Production build: Electron main + preload with esbuild, renderer with Vite.
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { oauthDefine } from './oauthConfig.mjs';
import { prepareMediaRuntime } from './prepare-media.mjs';

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
  define: { ...oauthDefine(), __ANIVERSE_UPSCALE_SCRIPT__: JSON.stringify(guestUpscale.outputFiles[0].text), __ANIVERSE_CHROME_PLAYER_SCRIPT__: JSON.stringify(chromePlayer.outputFiles[0].text) },
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
  await prepareMediaRuntime();
  // Only the renderer output is cleared (Vite's emptyOutDir); dist/electron is overwritten in place
  // so a running `npm run dev` session keeps its main bundle.
  await Promise.all([build({ ...mainOptions, minify: true }), build(preloadOptions)]);
  await viteBuild({ configFile: path.join(root, 'frontend/vite.config.ts'), mode: 'production', logLevel: 'warn' });
  console.log('Build complete → dist/');
}
