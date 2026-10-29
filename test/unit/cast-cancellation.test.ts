import { expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { CastService } from '../../electron/cast/castService';
import type { SenderSession } from '../../electron/cast/sender4k';
import { DEFAULT_UPSCALE } from '../../app/shared/upscale';
const defer = () => { let resolve!: (value: number) => void; const promise = new Promise<number>(r => resolve = r); return {promise,resolve}; };
it('does not create a receiver after stop cancels mirror server startup', async () => {
  let created=0;
  const cast=new CastService(()=>undefined,()=>null,undefined,()=>{created++;return new EventEmitter() as never;});
  const internal=cast as unknown as {devices:Map<string,unknown>;ensureServer:()=>Promise<number>};
  internal.devices.set('fixture',{id:'fixture',name:'Fixture',host:'127.0.0.1',port:8009});
  const gate=defer(),entered=defer();
  internal.ensureServer=()=>{entered.resolve(1);return gate.promise;};
  const pending=cast.startMirror('fixture','Fixture',Promise.resolve({folder:'unused',width:1920,height:1080,duration:0,startAt:0,encoder:'libx264'} as SenderSession),DEFAULT_UPSCALE);
  await entered.promise;
  await cast.stop();
  gate.resolve(12345);
  await expect(pending).rejects.toThrow(/cancelled/);
  expect(created).toBe(0);
  expect(cast.snapshot().status).toBe('idle');
});

it('handles encoder failure even when the selected TV is no longer present', async () => {
  const cast=new CastService(()=>undefined,()=>null);
  const ready=Promise.reject(new Error('Encoder was cancelled'));
  await expect(cast.startMirror('missing','Fixture',ready,DEFAULT_UPSCALE)).rejects.toThrow(/no longer available/);
  await new Promise<void>(resolve=>setImmediate(resolve));
});
