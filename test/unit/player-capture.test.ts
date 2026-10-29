import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PlayerCapture } from '../../electron/playerCapture';
function fixture(){
 const target=Object.assign(new EventEmitter(),{id:7,mainFrame:{name:'source'},isDestroyed:()=>false});
 const host={webContents:{mainFrame:{name:'host'}}};
 const ended:string[]=[];
 const capture=new PlayerCapture(()=>host as never,id=>{if(id!==7)throw new Error('Unowned player');return target as never;},event=>ended.push(event.ticket));
 const request={frame:host.webContents.mainFrame,videoRequested:true,audioRequested:false,userGesture:true};
 return {capture,target,host,ended,request};
}
it('grants video-only compatibility capture of the owned source once',()=>{
 const {capture,request,target}=fixture(),{ticket}=capture.prepare(7,'upscale');
 let streams:any;capture.handle(request as never,value=>streams=value);
 expect(streams.video).toBe(target.mainFrame);expect(streams.audio).toBeUndefined();
 expect(capture.active(ticket,'upscale')).toBe(true);
 capture.handle(request as never,value=>streams=value);expect(streams).toBeNull();
 capture.stopAll();
});
it('denies device audio, untrusted frames and absent user activation',()=>{
 const {capture,request}=fixture();capture.prepare(7,'upscale');
 for(const patch of [{audioRequested:true},{frame:{}},{userGesture:false}]){
  let streams:any;capture.handle({...request,...patch} as never,value=>streams=value);expect(streams).toBeNull();
 }
 expect(()=>capture.prepare(8,'upscale')).toThrow(/Unowned/);capture.stopAll();
});
it('revokes compatibility capture on navigation and explicit stop without stopping a separate TV capture',()=>{
 const {capture,request,target,ended}=fixture(),filter=capture.prepare(7,'upscale');
 capture.handle(request as never,()=>undefined);
 const mirror=capture.prepare(7,'mirror');capture.handle({...request,audioRequested:true} as never,()=>undefined);
 capture.stop(filter.ticket);expect(capture.active(mirror.ticket,'mirror')).toBe(true);
 target.emit('did-navigate');
 expect(capture.active(mirror.ticket,'mirror')).toBe(false);
 expect(ended).toEqual([filter.ticket,mirror.ticket]);
});
it('expires an unused grant instead of leaving capture permissions enabled',()=>{
 vi.useFakeTimers();
 try{const {capture,host}=fixture();capture.prepare(7,'upscale');expect(capture.canCapture(host.webContents as never)).toBe(true);
 vi.advanceTimersByTime(15001);expect(capture.canCapture(host.webContents as never)).toBe(false);capture.stopAll();}finally{vi.useRealTimers();}
});
