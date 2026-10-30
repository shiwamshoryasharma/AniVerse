import {expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({handler:null as null|((...args:unknown[])=>Promise<unknown>)}));
vi.mock('electron',()=>({ipcMain:{handle:(_channel:string,handler:typeof state.handler)=>state.handler=handler}}));
import {registerRpc} from '../../electron/ipc';
it('rejects inherited method names rather than invoking schema prototype members',async()=>{
 registerRpc({'app.info':vi.fn()} as never,()=>true);
 await expect(state.handler!({sender:{id:1}},'__proto__',undefined)).resolves.toMatchObject({ok:false,error:{code:'invalid-input'}});
 await expect(state.handler!({sender:{id:1}},'constructor',undefined)).resolves.toMatchObject({ok:false});
});
it('rejects untrusted frames and excessive payload work before handlers run',async()=>{
 const handler=vi.fn(()=>({version:'fixture'}));
 registerRpc({'app.info':handler} as never,()=>true);
 expect(await state.handler!({sender:{id:1}},'app.info',{oversized:'x'.repeat(9*1024*1024)})).toMatchObject({ok:false});
 expect(handler).not.toHaveBeenCalled();
 registerRpc({'app.info':handler} as never,()=>false);
 expect(await state.handler!({sender:{id:1}},'app.info',undefined)).toMatchObject({ok:false,error:{code:'unauthorised'}});
});
