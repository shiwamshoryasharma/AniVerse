import { randomUUID } from 'node:crypto';
import type { BrowserWindow, WebContents, DisplayMediaRequestHandlerHandlerRequest, Streams } from 'electron';
export type CapturePurpose = 'mirror' | 'upscale';
interface Grant { ticket:string; purpose:CapturePurpose; guest:WebContents; consumed:boolean; expires:number; timer:NodeJS.Timeout; release:()=>void }
/** Shared broker for source-view capture. Never returns a desktop, camera or microphone source. */
export class PlayerCapture {
  private grants=new Map<string,Grant>();
  private pending:string|null=null;
  constructor(private host:()=>BrowserWindow|null,private guest:(id:number)=>WebContents,
    private ended:(event:{ticket:string;purpose:CapturePurpose})=>void) {}
  prepare(webContentsId:number,purpose:CapturePurpose) {
    const target=this.guest(webContentsId);
    for(const grant of this.grants.values())if(grant.purpose===purpose||!grant.consumed)this.stop(grant.ticket);
    const ticket=randomUUID(),release=()=>this.stop(ticket);
    const timer=setTimeout(()=>{if(!this.grants.get(ticket)?.consumed)this.stop(ticket);},15000);
    timer.unref();
    this.grants.set(ticket,{ticket,purpose,guest:target,consumed:false,expires:Date.now()+15000,timer,release});
    this.pending=ticket;
    target.once('destroyed',release);target.once('did-navigate',release);
    return {ticket};
  }
  canCapture(wc:WebContents|null) {
    const grant=this.pending&&this.grants.get(this.pending);
    return !!grant&&!grant.consumed&&grant.expires>=Date.now()&&wc===this.host()?.webContents;
  }
  handle(request:DisplayMediaRequestHandlerHandlerRequest,callback:(streams:Streams|null)=>void) {
    const grant=this.pending&&this.grants.get(this.pending),host=this.host();
    if(!grant||grant.consumed||grant.expires<Date.now()||!host||request.frame!==host.webContents.mainFrame||
      !request.userGesture||!request.videoRequested||grant.guest.isDestroyed()||(grant.purpose==='upscale'&&request.audioRequested)){callback(null);return;}
    try{
      if(this.guest(grant.guest.id)!==grant.guest){callback(null);return;}
      grant.consumed=true;this.pending=null;clearTimeout(grant.timer);
      callback({video:grant.guest.mainFrame,...(request.audioRequested?{audio:grant.guest.mainFrame}:{}),enableLocalEcho:grant.purpose!=='mirror'});
    }catch{callback(null);}
  }
  active(ticket:string,purpose:CapturePurpose) {const grant=this.grants.get(ticket);return !!grant&&grant.consumed&&grant.purpose===purpose;}
  stop(ticket:string) {
    const grant=this.grants.get(ticket);if(!grant)return;
    this.grants.delete(ticket);if(this.pending===ticket)this.pending=null;clearTimeout(grant.timer);
    grant.guest.removeListener('destroyed',grant.release);grant.guest.removeListener('did-navigate',grant.release);
    this.ended({ticket,purpose:grant.purpose});
  }
  stopAll(){for(const ticket of [...this.grants.keys()])this.stop(ticket);}
}
