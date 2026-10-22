// Production build: Electron main + preload with esbuild, renderer with Vite.
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { oauthDefine } from './oauthConfig.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  define: oauthDefine(),
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
  // Only the renderer output is cleared (Vite's emptyOutDir); dist/electron is overwritten in place
  // so a running `npm run dev` session keeps its main bundle.
  await Promise.all([build({ ...mainOptions, minify: true }), build(preloadOptions)]);
  await viteBuild({ configFile: path.join(root, 'frontend/vite.config.ts'), mode: 'production', logLevel: 'warn' });
  console.log('Build complete → dist/');
}
