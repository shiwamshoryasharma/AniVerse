import type {OnBeforeRequestListenerDetails,Session} from 'electron';
import {isIP} from 'node:net';
import type {RustPolicy} from '../app/core/security/rustPolicy';
/** Source-page traffic only. Official APIs, file grants and sender LAN servers use separate owned paths. */
export class SourceNetworkGuard {
  private cache=new Map<string,{expires:number;allowed:boolean}>();
  private pending=new Map<string,Promise<boolean>>();
  constructor(private policy:RustPolicy,private session:Session,private source:()=>string){}
  async check(details:Pick<OnBeforeRequestListenerDetails,'url'|'resourceType'>):Promise<boolean>{
    const raw=details.url;
    // Blob/data are browser-local resources, never an OS/file privilege.
    if(raw==='about:blank'||raw==='about:srcdoc')return true;
    // MSE and sandboxed player frames can legitimately have opaque blob:null URLs.
    // Chromium owns access to these local objects; their underlying HTTP fetches still pass this guard.
    if(raw.startsWith('blob:')||raw.startsWith('data:'))return details.resourceType!=='mainFrame';
    if(!this.policy.decide({context:'network',url:raw,source:this.source()}).allowed)return false;
    const target=new URL(raw),host=target.hostname.replace(/^\[|\]$/g,'');
    // A local origin is an exception only when explicitly configured by the user.
    if(!this.policy.decide({context:'network',url:raw}).allowed)return true;
    if(isIP(host))return this.policy.decide({context:'address',url:host}).allowed;
    // Registered custom protocols are app-owned (e.g. isolated test fixtures), not DNS traffic.
    if(await this.session.protocol.isProtocolHandled(target.protocol.slice(0,-1)))return true;
    const cached=this.cache.get(host);if(cached&&cached.expires>Date.now())return cached.allowed;
    const current=this.pending.get(host);if(current)return current;
    if(this.pending.size>=32)return false;
    const lookup=this.session.resolveHost(host).then(result=>result.endpoints.length>0&&
      result.endpoints.every(endpoint=>this.policy.decide({context:'address',url:endpoint.address}).allowed)).catch(()=>false);
    let timer:NodeJS.Timeout;
    const deadline=new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),2500);timer.unref();});
    const outcome=Promise.race([lookup,deadline]).then(allowed=>{
      clearTimeout(timer);if(this.cache.size>=512)this.cache.clear();
      this.cache.set(host,{allowed,expires:Date.now()+(allowed?30000:2000)});return allowed;
    });
    this.pending.set(host,outcome);
    // A timeout must not release the outstanding resolver slot and permit unbounded DNS work.
    void lookup.finally(()=>{void outcome.finally(()=>this.pending.delete(host));});
    return outcome;
  }
}
