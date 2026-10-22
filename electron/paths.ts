import { app } from 'electron';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_SITES_FILE } from '../app/core/config/sitesConfig';

export interface AppPaths {
  root: string;
  configDir: string;
  sitesFile: string;
  filtersFile: string;
  recipesFile: string;
  profileDir: string;
  dataDir: string;
  db: string;
  adblockCache: string;
  renderer: string;
  preload: string;
}

export const isDev = !app.isPackaged;

/**
 * Resolves where the app reads `config/streaming-sites.txt`:
 *  1. `ANIVERSE_CONFIG_DIR` (tests, custom setups)
 *  2. development: `<project>/config`
 *  3. packaged: `<exe dir>/config` when present (portable), otherwise
 *     `<userData>/config`, seeded from the bundled defaults on first run.
 */
export function resolvePaths(): AppPaths {
  // dist/electron/main.cjs → project root
  const root = path.resolve(__dirname, '..', '..');
  const dataDir = app.getPath('userData');

  let configDir: string;
  if (process.env.ANIVERSE_CONFIG_DIR) configDir = path.resolve(process.env.ANIVERSE_CONFIG_DIR);
  else if (isDev) configDir = path.join(root, 'config');
  else {
    const portable = path.join(path.dirname(app.getPath('exe')), 'config');
    configDir = existsSync(path.join(portable, 'streaming-sites.txt')) ? portable : path.join(dataDir, 'config');
  }
  mkdirSync(configDir, { recursive: true });
  const sitesFile = path.join(configDir, 'streaming-sites.txt');
  const filtersFile = path.join(configDir, 'filters.txt');
  const recipesFile = path.join(configDir, 'site-recipes.json');
  const bundled = path.join(isDev ? root : process.resourcesPath, 'config');
  seed(sitesFile, path.join(bundled, 'streaming-sites.txt'), DEFAULT_SITES_FILE);
  seed(filtersFile, path.join(bundled, 'filters.txt'), '! AniVerse extra filters (Adblock Plus syntax)\n');

  mkdirSync(dataDir, { recursive: true });
  return {
    root,
    configDir,
    sitesFile,
    filtersFile,
    recipesFile,
    profileDir: path.join(dataDir, 'profile'),
    dataDir,
    db: path.join(dataDir, 'aniverse.db'),
    adblockCache: path.join(dataDir, 'adblock-engine.bin'),
    renderer: path.join(root, 'dist', 'renderer'),
    preload: path.join(__dirname, 'preload.cjs'),
  };
}

function seed(target: string, bundled: string, fallback: string) {
  if (existsSync(target)) return;
  if (existsSync(bundled) && path.resolve(bundled) !== path.resolve(target)) copyFileSync(bundled, target);
  else writeFileSync(target, fallback, 'utf8');
}
