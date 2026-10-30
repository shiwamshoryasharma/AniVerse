import {createHash} from 'node:crypto';
export type SecurityContext='network'|'navigate'|'external'|'asset'|'address';
export interface PolicyRequest {context:SecurityContext;url:string;source?:string;allowed_origins?:string[]}
interface Engine {memory:WebAssembly.Memory;abi_version:()=>number;input_ptr:()=>number;evaluate:(length:number)=>number}
const reasons=['allowed','invalid-input','scheme','credentials','local-network','origin','path','engine-unavailable'] as const;
export class RustPolicy {
  private engine:Engine;
  private healthy=true;
  readonly sha256:string;
  constructor(bytes:Uint8Array,expectedHash?:string){
    this.sha256=createHash('sha256').update(bytes).digest('hex');
    if(expectedHash&&this.sha256!==expectedHash)throw Error('Embedded security module integrity check failed.');
    const module=new WebAssembly.Module(bytes as BufferSource);
    if(WebAssembly.Module.imports(module).length)throw Error('Security module must not import host capabilities.');
    this.engine=new WebAssembly.Instance(module,{}).exports as unknown as Engine;
    if(this.engine.abi_version()!==1||this.engine.memory.buffer.byteLength>8388608)throw Error('Unsupported security module.');
  }
  decide(request:PolicyRequest):{allowed:boolean;reason:typeof reasons[number]}{
    if(!this.healthy)return {allowed:false,reason:'engine-unavailable'};
    try{
      const bytes=Buffer.from(JSON.stringify(request),'utf8');
      if(bytes.length>16384)return {allowed:false,reason:'invalid-input'};
      new Uint8Array(this.engine.memory.buffer,this.engine.input_ptr(),bytes.length).set(bytes);
      const result=this.engine.evaluate(bytes.length);
      return {allowed:result===0,reason:reasons[result]??'invalid-input'};
    }catch{this.healthy=false;return {allowed:false,reason:'engine-unavailable'};}
  }
  snapshot(){return {engine:'rust-wasm' as const,ready:this.healthy,abi:1,sha256:this.sha256};}
}
