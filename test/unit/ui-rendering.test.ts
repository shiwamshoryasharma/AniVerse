import { expect, it } from 'vitest';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import path from 'node:path';
import { UiRenderingPreferences } from '../../electron/uiRendering';
const cache=path.resolve('test/cache/ui-rendering-unit');mkdirSync(cache,{recursive:true});
function withFile(test:(file:string)=>void){
 const directory=mkdtempSync(path.join(cache,'run-'));
 try{test(path.join(directory,'graphics.json'));}
 finally{if(!directory.startsWith(cache+path.sep))throw new Error('Unsafe cleanup path');rmSync(directory,{recursive:true,force:true});}
}
it('defaults Windows UI to stable compositing while other platforms keep acceleration',()=>withFile(file=>{
 expect(new UiRenderingPreferences(file,'win32').snapshot()).toEqual({active:'stable',preferred:'stable',restartRequired:false});
 expect(new UiRenderingPreferences(file,'linux').snapshot().active).toBe('accelerated');
}));
it('persists only a local compositor choice and applies it on the next launch',()=>withFile(file=>{
 const preferences=new UiRenderingPreferences(file,'win32');
 expect(preferences.set('accelerated')).toEqual({active:'stable',preferred:'accelerated',restartRequired:true});
 expect(new UiRenderingPreferences(file,'win32').snapshot()).toEqual({active:'accelerated',preferred:'accelerated',restartRequired:false});
 expect(preferences.set('stable').restartRequired).toBe(false);
}));
it('falls back safely for malformed or unrecognised data and rejects invalid writes',()=>withFile(file=>{
 for(const data of ['{','{"mode":"disable-security"}','null','[]']){
  writeFileSync(file,data);expect(new UiRenderingPreferences(file,'win32').snapshot().active).toBe('stable');
 }
 const preferences=new UiRenderingPreferences(file,'win32');
 expect(()=>preferences.set('unsafe' as never)).toThrow(/mode/i);
}));
it('reports an explicit software-compositor command-line override accurately',()=>withFile(file=>{
 writeFileSync(file,JSON.stringify({mode:'accelerated'}));
 expect(new UiRenderingPreferences(file,'win32',true).snapshot()).toEqual({active:'stable',preferred:'accelerated',restartRequired:true});
}));
