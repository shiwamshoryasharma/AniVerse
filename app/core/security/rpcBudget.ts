/** Bounds work after Electron's structured clone. This does not make a compromised renderer harmless. */
export function boundedInput(input:unknown):boolean {
  const stack=[input],seen=new Set<object>();let nodes=0,bytes=0;
  while(stack.length){
    const value=stack.pop();if(++nodes>2048)return false;
    if(typeof value==='string')bytes+=Buffer.byteLength(value);
    else if(value&&typeof value==='object'){
      if(seen.has(value))return false;seen.add(value);
      if(ArrayBuffer.isView(value))bytes+=value.byteLength;
      else if(value instanceof ArrayBuffer)bytes+=value.byteLength;
      else {for(const key in value){if(!Object.hasOwn(value,key))continue;if(stack.length+nodes>=2048)return false;bytes+=key.length*3;stack.push((value as Record<string,unknown>)[key]);}}
    }
    if(bytes>8*1024*1024)return false;
  }
  return true;
}
export class RpcBudget {
  private senders=new Map<number,{start:number;calls:number;active:number}>();
  begin(id:number,now=Date.now()):boolean {
    let state=this.senders.get(id);
    if(!state){if(this.senders.size>=128)return false;state={start:now,calls:0,active:0};this.senders.set(id,state);}
    if(now-state.start>=10000){state.start=now;state.calls=0;}
    if(++state.calls>600||state.active>=128)return false;
    state.active++;return true;
  }
  end(id:number){const state=this.senders.get(id);if(state)state.active=Math.max(0,state.active-1);}
  forget(id:number){this.senders.delete(id);}
}
