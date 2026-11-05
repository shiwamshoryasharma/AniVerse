import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {connectNative,nativeCall} from '../../frontend/src/android/native';

describe('Android native request cancellation',()=>{
  let posted:{id:string;method:string}[];
  let channel:{postMessage:(packet:string)=>void;onmessage:((event:{data:string})=>void)|null};
  beforeEach(()=>{
    vi.useFakeTimers();posted=[];
    channel={postMessage:packet=>posted.push(JSON.parse(packet)),onmessage:null};
    vi.stubGlobal('window',{AniVerseNative:channel});
    connectNative();
  });
  afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
  it('does not submit an already cancelled request',async()=>{
    const controller=new AbortController();controller.abort();
    await expect(nativeCall('api.request',{},controller.signal)).rejects.toMatchObject({name:'AbortError'});
    expect(posted).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('settles at the caller deadline instead of waiting for the 35s bridge timeout',async()=>{
    const controller=new AbortController();
    const request=nativeCall('api.request',{},controller.signal);
    const verdict=expect(request).rejects.toMatchObject({name:'AbortError'});
    expect(posted).toHaveLength(1);
    controller.abort();await verdict;
    expect(vi.getTimerCount()).toBe(0);
    channel.onmessage?.({data:JSON.stringify({id:posted[0].id,result:{body:'late'}})});
    expect(vi.getTimerCount()).toBe(0);
  });
  it('removes its deadline and cancellation listener after a normal reply',async()=>{
    const controller=new AbortController();
    const request=nativeCall<{status:number}>('api.request',{},controller.signal);
    channel.onmessage?.({data:JSON.stringify({id:posted[0].id,result:{status:200}})});
    await expect(request).resolves.toEqual({status:200});
    controller.abort();expect(vi.getTimerCount()).toBe(0);
  });
});
