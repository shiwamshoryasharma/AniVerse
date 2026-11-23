import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const cache = path.join(root, 'test/cache');
mkdirSync(cache, {recursive:true});
const folder = mkdtempSync(path.join(cache, 'control-selection-'));
const bundle = path.join(folder, 'site-page.cjs');
await build({entryPoints:[path.join(root, 'electron/sitePage.ts')], bundle:true, platform:'node', outfile:bundle});
const electron = createRequire(import.meta.url)('electron');
const child = spawnSync(electron, [path.join(directory, 'drivers/source-control-selection.cjs')], {
  cwd:root, stdio:'inherit', windowsHide:true, timeout:30000,
  env:{...process.env, AV_CONTROL_BUNDLE:bundle, AV_CONTROL_PROFILE:path.join(folder, 'profile'), TEMP:folder, TMP:folder},
});
if (child.error) console.error(child.error);
process.exit(child.status ?? 1);
