import {readFileSync} from 'node:fs';
import {beforeAll,expect,it} from 'vitest';
let engine:{memory:WebAssembly.Memory;abi_version:()=>number;input_ptr:()=>number;evaluate:(length:number)=>number};
beforeAll(async()=>{
 const bytes=readFileSync('dist/electron/security.wasm');
 const module=await WebAssembly.compile(bytes);
 expect(WebAssembly.Module.imports(module)).toEqual([]);
 engine=(await WebAssembly.instantiate(module,{})).exports as typeof engine;
});
const decide=(input:unknown)=>{const bytes=new TextEncoder().encode(JSON.stringify(input));new Uint8Array(engine.memory.buffer,engine.input_ptr(),bytes.length).set(bytes);return engine.evaluate(bytes.length);};
it('loads the real Rust module without host capabilities and admits valid source traffic',()=>{
 expect(engine.abi_version()).toBe(1);
 expect(decide({context:'network',url:'https://player.example.org/video.m3u8'})).toBe(0);
 expect(decide({context:'navigate',url:'https://watch.example.org/episode-1',source:'https://example.org'})).toBe(0);
});
it('denies private-network tricks, privileged schemes and credential-bearing URLs',()=>{
 for(const url of ['http://127.0.0.1','http://2130706433','http://0x7f000001','http://0177.0.0.1','http://10.0.0.1','http://169.254.169.254/latest','http://[::1]','http://[::ffff:127.0.0.1]','http://router.local','http://a.localhost','file:///C:/Windows/win.ini','javascript:alert(1)','https://user:pass@example.org']){
  expect(decide({context:'network',url}),url).not.toBe(0);
 }
});
it('permits only the exact explicitly configured local origin, not another LAN port or host',()=>{
 const source='http://127.0.0.1:8123';
 expect(decide({context:'network',url:source+'/episode-1',source})).toBe(0);
 expect(decide({context:'network',url:'http://127.0.0.1:8124/private',source})).not.toBe(0);
 expect(decide({context:'network',url:'http://192.168.1.1',source})).not.toBe(0);
});
it('protects navigation identity, prevents HTTPS downgrade and rejects invalid/oversized input',()=>{
 expect(decide({context:'navigate',source:'https://example.org',url:'https://example.org.attacker.org'})).not.toBe(0);
 expect(decide({context:'navigate',source:'https://example.org',url:'http://example.org'})).not.toBe(0);
 expect(decide({context:'external',url:'vscode://file/private'})).not.toBe(0);
 expect(decide({context:'asset',url:'app://attacker/renderer.js'})).not.toBe(0);
 expect(decide({context:'asset',url:'app://aniverse/assets/main.js'})).toBe(0);
 expect(engine.evaluate(16385)).not.toBe(0);
 expect(engine.memory.buffer.byteLength).toBeLessThanOrEqual(8388608);
});
it('rejects private/reserved resolved IP addresses',()=>{
 for(const url of ['127.0.0.1','100.64.0.1','198.18.0.1','192.0.2.1','::','fc00::1','fe80::1','ff02::1','2001:db8::1']){
  expect(decide({context:'address',url}),url).not.toBe(0);
 }
 expect(decide({context:'address',url:'1.1.1.1'})).toBe(0);
});

it('enforces the compiled memory maximum and remains usable after malformed bounded input',()=>{
 expect(()=>engine.memory.grow(129)).toThrow();
 new Uint8Array(engine.memory.buffer,engine.input_ptr(),4).set([255,0,255,0]);
 expect(engine.evaluate(4)).not.toBe(0);
 expect(decide({context:'network',url:'https://media.example.org/valid.mp4'})).toBe(0);
});
