// Real isolated-world navigation learning; all routes are neutral local protocol fixtures.
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const cache=path.join(root,'test/cache/navigation-learning');
const temporary=path.join(cache,'temp');
const baseline=process.argv.includes('--baseline');
const runtime=path.join(cache,baseline?'baseline-runtime.cjs':'runtime.cjs');
mkdirSync(temporary,{recursive:true});
if(!baseline||!existsSync(runtime)){
  await build({stdin:{contents:"export {pageScript} from './electron/sitePage'; export {SiteNavigator} from './electron/siteNavigator'; export {Store} from './app/core/db/store'; export {SourceRegistry,WebSiteAdapter} from './app/core/sources/registry';",resolveDir:root},outfile:runtime,bundle:true,platform:'node',format:'cjs',external:['electron','node:sqlite'],logLevel:'warning'});
  const files=['electron/siteNavigator.ts','electron/sitePage.ts','app/core/sources/registry.ts','app/core/db/store.ts'];
  writeFileSync(path.join(cache,baseline?'baseline-hashes.json':'hashes.json'),JSON.stringify(Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(path.join(root,file))).digest('hex')])),null,2)+'\n');
}
const child=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'test/e2e/drivers/navigation-learning.cjs')],{
  cwd:root,windowsHide:true,stdio:'inherit',env:{...process.env,ANIVERSE_NAV_ROOT:root,ANIVERSE_NAV_RUNTIME:runtime,ANIVERSE_NAV_BASELINE:baseline?'1':'0',ANIVERSE_HEADLESS:'1',ANIVERSE_DATA_DIR:path.join(cache,'profile'),ANIVERSE_CONFIG_DIR:path.join(cache,'config'),TEMP:temporary,TMP:temporary,TMPDIR:temporary},
});
console.log('Navigation fixture Electron PID: '+child.pid);
let exited=false;
const watchdog=setTimeout(()=>{if(!exited){console.error('Navigation fixture exceeded its 8 minute process deadline; stopping owned PID '+child.pid);child.kill();process.exitCode=1;}},480000);
child.on('error',error=>{console.error(error);clearTimeout(watchdog);process.exitCode=1;});
child.on('exit',code=>{exited=true;clearTimeout(watchdog);process.exitCode=code??1;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(!exited)child.kill();});
