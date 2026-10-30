import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {RustPolicy} from '../../app/core/security/rustPolicy';
import {SourceNetworkGuard} from '../../electron/sourceNetwork';
const policy=()=>new RustPolicy(readFileSync('dist/electron/security.wasm'));
it('rejects private DNS results, including mixed public/private answers, before source requests continue',async()=>{
 const resolveHost=vi.fn(async()=>({endpoints:[{address:'1.1.1.1'},{address:'127.0.0.1'}]}));
 const session={resolveHost,protocol:{isProtocolHandled:async()=>false}};
 const guard=new SourceNetworkGuard(policy(),session as never,()=> 'https://source.example.org');
 expect(await guard.check({url:'https://cdn.example.org/video.mp4',resourceType:'media'})).toBe(false);
 expect(await guard.check({url:'https://cdn.example.org/other.mp4',resourceType:'media'})).toBe(false);
 expect(resolveHost).toHaveBeenCalledOnce();
 expect(await guard.check({url:'file:///C:/Windows/win.ini',resourceType:'subFrame'})).toBe(false);
});
it('retains normal public media, explicit local source origins and browser-local media resources',async()=>{
 const resolveHost=vi.fn(async()=>({endpoints:[{address:'1.1.1.1'}]}));
 const session={resolveHost,protocol:{isProtocolHandled:async()=>false}};
 const guard=new SourceNetworkGuard(policy(),session as never,()=> 'http://127.0.0.1:8123');
 expect(await guard.check({url:'http://127.0.0.1:8123/episode',resourceType:'mainFrame'})).toBe(true);
 expect(await guard.check({url:'http://127.0.0.1:8124/private',resourceType:'image'})).toBe(false);
 expect(await guard.check({url:'https://cdn.example.org/clip.mp4',resourceType:'media'})).toBe(true);
 expect(await guard.check({url:'data:image/png;base64,AA==',resourceType:'image'})).toBe(true);
 expect(await guard.check({url:'data:text/html,unsafe',resourceType:'mainFrame'})).toBe(false);
 expect(await guard.check({url:'blob:null/fixture',resourceType:'media'})).toBe(true);
 expect(await guard.check({url:'data:text/html,player',resourceType:'subFrame'})).toBe(true);
 expect(resolveHost).toHaveBeenCalledTimes(1);
});
