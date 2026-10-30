import {mkdtempSync,writeFileSync,rmSync,utimesSync} from 'node:fs';
import path from 'node:path';
import {expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({handlers:new Map<string,Function>(),download:vi.fn(),deserialize:vi.fn()}));
vi.mock('electron',()=>({ipcMain:{removeHandler:(name:string)=>mocks.handlers.delete(name),handle:(name:string,fn:Function)=>mocks.handlers.set(name,fn)},net:{fetch:vi.fn()}}));
vi.mock('@ghostery/adblocker-electron',()=>({ElectronBlocker:{fromPrebuiltFull:mocks.download,deserialize:mocks.deserialize}}));
import {Adblocker} from '../../electron/adblock';
function engine(){return {serialize:()=>new Uint8Array([1,2,3]),updateFromDiff:vi.fn(),onBeforeRequest:vi.fn((_details,callback)=>callback({cancel:true})),onHeadersReceived:vi.fn(),onInjectCosmeticFilters:vi.fn(),onIsMutationObserverEnabled:vi.fn(()=>true)};}
function fixture(){
 const folder=mkdtempSync(path.resolve('test/cache/adblock-unit-'));
 const cache=path.join(folder,'rules.bin'),filters=path.join(folder,'filters.txt');writeFileSync(filters,'! local rules\n||advert.test^\n');
 const before=vi.fn(),headers=vi.fn();const session={webRequest:{onBeforeRequest:before,onHeadersReceived:headers},registerPreloadScript:vi.fn(()=> 'preload'),unregisterPreloadScript:vi.fn()};
 return {folder,cache,filters,before,session,close:()=>rmSync(folder,{recursive:true,force:true})};
}
it('hot updates attached sessions without duplicate preloads and keeps working rules after a failed update',async()=>{
 mocks.download.mockReset();const first=engine(),second=engine();mocks.download.mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockRejectedValueOnce(Error('offline'));
 const f=fixture();vi.useFakeTimers();
 try{
  const blocker=new Adblocker(f.cache,f.filters,vi.fn());blocker.attach(f.session as never,'fixture');await blocker.load();
  expect(first.updateFromDiff).toHaveBeenCalledWith({added:['||advert.test^']});
  const originalCallback=f.before.mock.calls[0][1];await blocker.update();
  originalCallback({},vi.fn());expect(second.onBeforeRequest).toHaveBeenCalled();
  expect(f.session.registerPreloadScript).toHaveBeenCalledTimes(1);
  await expect(blocker.update()).rejects.toThrow('offline');
  expect(blocker.snapshot()).toMatchObject({ready:true,updating:false,error:expect.stringContaining('Existing rules')});
  originalCallback({},vi.fn());expect(second.onBeforeRequest).toHaveBeenCalledTimes(2);
  blocker.detach(f.session as never);expect(f.session.unregisterPreloadScript).toHaveBeenCalledWith('preload');
 }finally{vi.clearAllTimers();vi.useRealTimers();f.close();}
});
it('starts offline from a cached engine and rejects cosmetic IPC from an unowned session',async()=>{
 const cached=engine();mocks.download.mockReset().mockRejectedValue(Error('offline'));mocks.deserialize.mockReturnValue(cached);
 const f=fixture();writeFileSync(f.cache,new Uint8Array([1]));utimesSync(f.cache,new Date(0),new Date(0));vi.useFakeTimers();
 try{
  const blocker=new Adblocker(f.cache,f.filters,vi.fn());await blocker.load();blocker.attach(f.session as never,'fixture');
  const handler=mocks.handlers.get('@ghostery/adblocker/inject-cosmetic-filters')!;
  await handler({sender:{session:{}},senderFrame:{url:'https://frame.test'}},'https://frame.test');
  expect(cached.onInjectCosmeticFilters).not.toHaveBeenCalled();
  const event={sender:{session:f.session},senderFrame:{url:'https://frame.test',detached:false,executeJavaScript:vi.fn(async()=>{})}};
  await handler(event,'https://other.test');expect(cached.onInjectCosmeticFilters).not.toHaveBeenCalled();
  await handler(event,'https://frame.test');expect(cached.onInjectCosmeticFilters).toHaveBeenCalledOnce();
 }finally{vi.clearAllTimers();vi.useRealTimers();f.close();}
});
