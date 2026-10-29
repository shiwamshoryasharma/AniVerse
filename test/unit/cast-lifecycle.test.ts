import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { CastService } from '../../electron/cast/castService';
class Receiver extends EventEmitter{
 closed=0;
 async connect(){}async launch(){}async load(){this.emit('media',{mediaSessionId:1,playerState:'PLAYING',currentTime:0});}
 async media(){throw new Error('Owned Chrome closed during status polling.');}
 async stopApp(){}async volume(){}close(){this.closed++;}
}
afterEach(()=>vi.useRealTimers());
async function fixture(){
 const receiver=new Receiver(),cast=new CastService(()=>undefined,()=>null,undefined,()=>receiver);
 cast.rememberDevices([{id:'fixture',name:'Fixture',model:'Fixture',host:'127.0.0.1',port:0,transport:'chrome'}]);
 await cast.start('fixture',{url:'https://media-fixture.test/video.mp4',kind:'mp4',title:'Fixture'});
 return {cast,receiver};
}
it('stops polling and closes the transport when the owned route ends',async()=>{
 const {cast,receiver}=await fixture();
 receiver.emit('closed');
 expect(receiver.closed).toBe(1);expect(receiver.listenerCount('media')).toBe(0);
 expect(cast.snapshot().status).toBe('ended');await cast.stop();
});
it('handles a polling disconnect without an unhandled rejection or a leaked Chrome process',async()=>{
 vi.useFakeTimers();
 const {cast,receiver}=await fixture();
 await vi.advanceTimersByTimeAsync(2000);
 expect(cast.snapshot()).toMatchObject({status:'error',error:'Owned Chrome closed during status polling.'});
 expect(receiver.closed).toBe(1);await cast.stop();
});
