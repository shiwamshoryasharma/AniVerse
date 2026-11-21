import path from 'node:path';
import { copyFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build as bundle } from 'esbuild';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const outDir = path.resolve(root, process.argv[2] || 'dist/aniverse2');
await build({
  configFile: path.join(root, 'frontend/vite.config.ts'),
  mode: 'production',
  build: { outDir, sourcemap: false },
});
await copyFile(path.join(root, 'assets/aniverse2/mark.png'), path.join(outDir, 'aniverse2-mark.png'));
const guestUpscale = await bundle({
  entryPoints: [path.join(root, 'electron/upscaleGuest.ts')],
  write: false, bundle: true, platform: 'browser', format: 'iife',
  globalName: 'AniVerseUpscale', minify: true,
});
const shared = await bundle({
  stdin: {
    contents: `import { z } from "zod";
      import { backupSchema } from "./app/shared/backup";
      export const BACKUP_JSON_SCHEMA = z.toJSONSchema(backupSchema, { io: "input" });
      export { DEFAULT_SETTINGS } from "./app/core/settings";
      export { MIGRATIONS } from "./app/core/db/store";
      export { RELEASES } from "./app/shared/changelog";
      export { CARD, BROWSE_TYPES, homeQuery, DETAILS_QUERY, searchQuery,
        SCHEDULE_QUERY, GENRES_QUERY, HOVER_QUERY } from "./app/core/metadata/anilist";
      export { FOCUS_CSS, PAGE_FN } from "./electron/sitePage";
      export { desktopAudioOptions } from "./electron/desktopSiteAudio";
      export { CATALOGUE_PAGE } from "./electron/cataloguePage";
      export { seriesMarkers } from "./app/core/sources/text";`,
    resolveDir: root,
  },
  write: false, bundle: true, platform: 'node', format: 'esm', external: ['node:sqlite'],
});
const {
  BACKUP_JSON_SCHEMA, DEFAULT_SETTINGS, MIGRATIONS, RELEASES, CARD, BROWSE_TYPES, homeQuery, DETAILS_QUERY, searchQuery,
  SCHEDULE_QUERY, GENRES_QUERY, HOVER_QUERY, FOCUS_CSS, PAGE_FN, desktopAudioOptions, CATALOGUE_PAGE, seriesMarkers,
} = await import('data:text/javascript;base64,' + Buffer.from(shared.outputFiles[0].text).toString('base64'));
await Promise.all(Object.entries({
  'changelog-versions.json': JSON.stringify(RELEASES.map(release=>release.version))+'\n',
  'settings-defaults.json': JSON.stringify(DEFAULT_SETTINGS) + '\n',
  'profile-migrations.json': JSON.stringify(MIGRATIONS) + '\n',
  'backup-schema.json': JSON.stringify(BACKUP_JSON_SCHEMA) + '\n',
  'anilist-home.graphql': homeQuery(true),
  'anilist-home-safe.graphql': homeQuery(false),
  'anilist-latest.graphql': SCHEDULE_QUERY.replace('sort: TIME)', 'sort: TIME_DESC)'),
  'anilist-catalogue.json': JSON.stringify({
    card: CARD, filters: BROWSE_TYPES, details: DETAILS_QUERY,
    search: searchQuery(true), safe_search: searchQuery(false), schedule: SCHEDULE_QUERY,
    genres: GENRES_QUERY, hover: HOVER_QUERY,
  }),
  'site-page.js': `(function(args) { return (${PAGE_FN.toString()})(args, (${seriesMarkers.toString()})); })`,
  'site-focus.css': FOCUS_CSS,
  'site-upscale.js': guestUpscale.outputFiles[0].text,
  'site-catalogue.js': `(${CATALOGUE_PAGE.toString()})`,
  'site-audio.js': `(${desktopAudioOptions.toString()})`,
}).map(([name, content]) => writeFile(path.join(outDir, name), content)));
