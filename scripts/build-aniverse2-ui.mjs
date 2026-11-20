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
const shared = await bundle({
  stdin: {
    contents: `export { DEFAULT_SETTINGS } from "./app/core/settings";
      export { homeQuery, SCHEDULE_QUERY } from "./app/core/metadata/anilist";`,
    resolveDir: root,
  },
  write: false, bundle: true, platform: 'node', format: 'esm',
});
const { DEFAULT_SETTINGS, homeQuery, SCHEDULE_QUERY } = await import('data:text/javascript;base64,' + Buffer.from(shared.outputFiles[0].text).toString('base64'));
await Promise.all(Object.entries({
  'settings-defaults.json': JSON.stringify(DEFAULT_SETTINGS) + '\n',
  'anilist-home.graphql': homeQuery(true),
  'anilist-home-safe.graphql': homeQuery(false),
  'anilist-latest.graphql': SCHEDULE_QUERY.replace('sort: TIME)', 'sort: TIME_DESC)'),
}).map(([name, content]) => writeFile(path.join(outDir, name), content)));
