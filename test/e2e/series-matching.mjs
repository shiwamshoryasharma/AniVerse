// Real isolated-world title matching, with neutral rendered source fixtures only.
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const cache=path.join(root,'test/cache/series-matching'),temporary=path.join(cache,'temp');
mkdirSync(temporary,{recursive:true});
await build({stdin:{contents:"export {pageScript} from './electron/sitePage';export {SiteNavigator,searchQueries} from './electron/siteNavigator';export {Store} from './app/core/db/store';",resolveDir:root},outfile:path.join(cache,'runtime.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron','node:sqlite'],logLevel:'warning'});
const child=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'test/e2e/drivers/series-matching.cjs')],{cwd:root,windowsHide:true,stdio:'inherit',env:{...process.env,ANIVERSE_MATCH_ROOT:root,TEMP:temporary,TMP:temporary,TMPDIR:temporary}});
child.on('error',error=>{console.error(error);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
