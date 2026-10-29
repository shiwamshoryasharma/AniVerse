import { afterEach,expect,it,vi } from 'vitest';
afterEach(()=>vi.unstubAllGlobals());
function fixture(){
 let release!:(stream:MediaStream)=>void,listener:(event:{ticket:string})=>void=()=>undefined;
 const stopped=vi.fn(),stream={getTracks:()=>[{stop:stopped}]} as unknown as MediaStream;
 const invoke=vi.fn(async(method:string)=>method==='player.capturePrepare'?{ticket:'fixture'}:undefined);
 vi.stubGlobal('window',{aniverse:{invoke,on:(_name:string,handler:typeof listener)=>{listener=handler;return()=>undefined;}}});
 vi.stubGlobal('navigator',{mediaDevices:{getDisplayMedia:()=>new Promise<MediaStream>(resolve=>release=resolve)}});
 return {release:(value:MediaStream)=>release(value),stream,stopped,revoke:()=>listener({ticket:'fixture'}),invoke};
}
it('releases a capture that finishes after its source grant was revoked',async()=>{
 const f=fixture();const {capturePlayer}=await import('../../frontend/src/lib/playerCapture');const pending=capturePlayer(7);await Promise.resolve();f.revoke();f.release(f.stream);
 await expect(pending).rejects.toThrow(/cancelled/);expect(f.stopped).toHaveBeenCalledOnce();
 expect(f.invoke).toHaveBeenCalledWith('player.captureStop',{ticket:'fixture'});
});
it('releases a capture that finishes after the user disabled or left upscaling',async()=>{
 const f=fixture();const {capturePlayer}=await import('../../frontend/src/lib/playerCapture');let wanted=true;
 const pending=capturePlayer(7,()=>wanted);await Promise.resolve();wanted=false;f.release(f.stream);
 await expect(pending).rejects.toThrow(/cancelled/);expect(f.stopped).toHaveBeenCalledOnce();
});
