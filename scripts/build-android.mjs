// Shared React tablet UI plus Kotlin host. No Electron binaries enter the APK.
import { build as viteBuild } from 'vite';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdirSync,renameSync,writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
await viteBuild({configFile:path.join(root,'frontend/vite.android.config.ts'),mode:'production',logLevel:'warn'});
const dist=path.join(root,'dist/android');renameSync(path.join(dist,'android.html'),path.join(dist,'index.html'));
const runtime=path.join(root,'test/cache/android-0.1.0/site-page.cjs');mkdirSync(path.dirname(runtime),{recursive:true});
await build({entryPoints:[path.join(root,'electron/sitePage.ts')],outfile:runtime,bundle:true,platform:'node',format:'cjs',logLevel:'warning'});
const {pageScript,FOCUS_CSS}=createRequire(import.meta.url)(runtime);
const placeholder=JSON.stringify({op:'pageInfo'}),script=pageScript({op:'pageInfo'}),at=script.lastIndexOf(placeholder);
if(at<0)throw new Error('Source operation placeholder missing.');
writeFileSync(path.join(dist,'site-script.template'),script.slice(0,at)+'__ANIVERSE_PAGE_ARGS__'+script.slice(at+placeholder.length));
writeFileSync(path.join(dist,'source-focus.css'),FOCUS_CSS);
console.log('Android UI and shared browser navigation built → dist/android');
