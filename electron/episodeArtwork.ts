import {randomBytes} from 'node:crypto';
import type {WebContents} from 'electron';
import type {RustPolicy} from '../app/core/security/rustPolicy';

interface Grant {owner:WebContents;url:string;referer:string;expires:number}
/** Read-only image grants. Fetch in the source session; never expose its cookies or persist private artwork. */
export class EpisodeArtwork {
  private grants=new Map<string,Grant>();
  private owners=new Set<number>();
  private running=0;
  private waiting:(()=>void)[]=[];
  constructor(private security:RustPolicy){}
  grant(owner:WebContents,url:string):string|null {
    if(owner.isDestroyed())return null;
    const sourceURL=owner.getURL();
    if(!/^https?:\/\//i.test(sourceURL)||!this.security.decide({context:'network',url,source:sourceURL}).allowed||!/^https?:/i.test(url))return null;
    for(const [token,value] of this.grants){
      if(value.expires<Date.now()||value.owner.isDestroyed())this.grants.delete(token);
      else if(value.owner===owner&&value.url===url)return 'media://episode/'+token;
    }
    if(this.grants.size>=1024)this.grants.delete(this.grants.keys().next().value!);
    const token=randomBytes(24).toString('hex');
    const source=new URL(sourceURL),target=new URL(url);
    const referer=source.protocol==='https:'&&target.protocol==='http:'?'':source.origin+'/';
    this.grants.set(token,{owner,url,referer,expires:Date.now()+3600000});
    if(!this.owners.has(owner.id)){
      this.owners.add(owner.id);
      owner.once('destroyed',()=>{this.owners.delete(owner.id);for(const [key,value]of this.grants)if(value.owner===owner)this.grants.delete(key);});
    }
    return 'media://episode/'+token;
  }
  private async acquire(){
    if(this.running<6){this.running++;return true;}
    if(this.waiting.length>=128)return false;
    await new Promise<void>(resolve=>this.waiting.push(resolve));return true;
  }
  private release(){const next=this.waiting.shift();if(next)next();else this.running--;}
  async serve(token:string):Promise<Response>{
    if(!this.grants.has(token))return new Response(null,{status:404});
    if(!await this.acquire())return new Response(null,{status:429});
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),8000);timer.unref();
    let owner:WebContents|undefined;
    const cancelled=()=>abort.abort();
    try{
      const grant=this.grants.get(token);
      if(!grant||grant.expires<Date.now()||grant.owner.isDestroyed())return new Response(null,{status:404});
      owner=grant.owner;owner.once('destroyed',cancelled);
      // This session retains mandatory SourceNetworkGuard/ad blocking and source cookies.
      const response=await owner.session.fetch(grant.url,{headers:grant.referer?{Referer:grant.referer}:{},cache:'no-store',signal:abort.signal});
      const type=response.headers.get('content-type')?.split(';')[0].toLowerCase()??'';
      if(!response.ok||!/^image\/(?:png|jpeg|webp|gif|avif)$/.test(type)||Number(response.headers.get('content-length'))>2097152){await response.body?.cancel();return new Response(null,{status:404});}
      const reader=response.body?.getReader();if(!reader)return new Response(null,{status:404});
      const chunks:Uint8Array[]=[];let bytes=0;
      for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>2097152){await reader.cancel();return new Response(null,{status:413});}chunks.push(part.value);}
      return new Response(Buffer.concat(chunks),{headers:{'Content-Type':type,'Content-Length':String(bytes),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Access-Control-Allow-Origin':'app://aniverse'}});
    }catch{return new Response(null,{status:404});}
    finally{clearTimeout(timer);owner?.removeListener('destroyed',cancelled);this.release();}
  }
}
