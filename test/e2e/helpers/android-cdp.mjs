// Test-only adapter for the explicitly owned Android debug app. No production policy changes.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright-core';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function androidClient({root,run,serial='emulator-5584',appId='app.aniverse.tablet.fixture'}){
 const adbPath='C:/Users/Admin/AppData/Local/Android/Sdk/platform-tools/adb.exe',temp=path.join(run,'temp');mkdirSync(temp,{recursive:true});
 const env={...process.env,TEMP:temp,TMP:temp,TMPDIR:temp},forwards=[];
 let browser,page;
 const adb=(...args)=>execFileSync(adbPath,['-s',serial,...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true,timeout:20000,maxBuffer:16*1024*1024,env}).trim();
 const native=(method,input={},timeout=12000)=>page.evaluate(({method,input,timeout})=>new Promise((resolve,reject)=>{
  const channel=window.AniVerseNative;if(!channel){reject(Error('Trusted native bridge unavailable'));return;}
  const id='android-test-'+crypto.randomUUID(),previous=channel.onmessage;
  const restore=()=>{if(channel.onmessage===receive)channel.onmessage=previous;};
  const timer=setTimeout(()=>{restore();reject(Error('Native reply timed out: '+method));},timeout);
  const receive=event=>{let reply;try{reply=JSON.parse(event.data);}catch{previous?.call(channel,event);return;}if(reply.id!==id){previous?.call(channel,event);return;}clearTimeout(timer);restore();if(reply.error){const error=Error(reply.error.message);error.code=reply.error.code;reject(error);}else resolve(reply.result);};
  channel.onmessage=receive;try{channel.postMessage(JSON.stringify({id,method,input}));}catch(error){clearTimeout(timer);restore();reject(error);}
 }),{method,input,timeout});
 async function connect(){
  assert.equal(adb('get-state'),'device');adb('shell','am','start','-n',appId+'/app.aniverse.tablet.MainActivity');let pid,socket;
  for(const until=Date.now()+25000;Date.now()<until;){try{pid=adb('shell','pidof',appId).split(/\s+/)[0];}catch(error){if(error.status===1&&!error.stdout&&!error.stderr)pid='';else throw error;}if(pid){socket=adb('shell','cat','/proc/net/unix').split(/\r?\n/).map(line=>line.trim().split(/\s+/).at(-1)).find(name=>name==='@webview_devtools_remote_'+pid);if(socket)break;}await delay(250);}
  assert.ok(pid&&socket,'Owned debug WebView socket is available');const port=adb('forward','tcp:0','localabstract:'+socket.substring(1));assert.match(port,/^\d+$/);forwards.push(port);
  browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{noDefaults:true,artifactsDir:run});
  for(const until=Date.now()+20000;Date.now()<until;){page=browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().startsWith('https://appassets.androidplatform.net/assets/'));if(page)break;await delay(150);}
  assert.ok(page,'Trusted application WebView is available');page.setDefaultTimeout(10000);await page.waitForFunction(()=>!!window.aniverse&&!!window.AniVerseNative);return {page,pid,socket,port};
 }
 async function touch(locator){await locator.scrollIntoViewIfNeeded();const box=await locator.boundingBox();assert.ok(box,'Tap target has visible geometry');const session=await locator.page().context().newCDPSession(locator.page());try{await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2,radiusX:1,radiusY:1,force:1}]});await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}finally{await session.detach();}}
 async function nav(name){
  let action=page.getByRole('navigation',{name:'Main',exact:true}).getByRole('link',{name,exact:true});
  if(!await action.count()){
    await touch(page.getByRole('navigation',{name:'Main',exact:true}).getByRole('button',{name:'More',exact:true}));
    action=page.getByRole('dialog',{name:'More',exact:true}).getByRole('link',{name:new RegExp('^'+name+'(?:\\s|$)')});
  }
  assert.equal(await action.count(),1);await touch(action);
 }
 const itemPath=(id,extension)=>{assert.match(id,/^[a-f0-9-]{36}$/);assert.ok(['part','video'].includes(extension));return 'files/offline/'+id+'.'+extension;};
 const fileSize=(id,extension)=>{try{return Number(adb('shell','run-as',appId,'stat','-c','%s',itemPath(id,extension)));}catch(error){if(error.status===1&&String(error.stdout??'').concat(String(error.stderr??'')).includes('No such file or directory'))return null;throw error;}};
 const fileHash=(id,extension)=>{const hash=adb('shell','run-as',appId,'sha256sum',itemPath(id,extension)).split(/\s+/)[0];assert.match(hash,/^[a-f0-9]{64}$/);return hash;};
 async function close(){if(browser)await browser.close().catch(()=>{});for(const port of forwards)try{adb('forward','--remove','tcp:'+port);}catch{}}
 return {adb,native,connect,touch,nav,fileSize,fileHash,close,serial,appId,get page(){return page;}};
}
