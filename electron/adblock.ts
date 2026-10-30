import {boundedInput} from '../app/core/security/rpcBudget';
import { ElectronBlocker } from '@ghostery/adblocker-electron';
import { ipcMain, net, type Session, type IpcMainInvokeEvent, type OnBeforeRequestListenerDetails } from 'electron';
import { readFile, stat, writeFile, rename } from 'node:fs/promises';
import type { AdblockStats } from '../app/shared/types';
import { errorMessage } from '../app/core/util';

const LIST_MAX_AGE_MS = 24 * 3600 * 1000;
const PRELOAD_PATH = require.resolve('@ghostery/adblocker-electron-preload');

/** One filter engine, independently attached to owned source partitions. */
export class Adblocker {
  private blocker: ElectronBlocker | null = null;
  private loading: Promise<void> | null = null;
  private attached = new Map<Session, { sourceId: string; preloadId: string | null; ads:boolean; guard?: (details:OnBeforeRequestListenerDetails)=>Promise<boolean> }>();
  private stats: AdblockStats = { enabled: true, ready: false, updating: false, error: null, listsUpdatedAt: null, blocked: {}, popupsBlocked: {},securityBlocked:{} };
  private dirty = false;

  constructor(private cachePath: string, private filtersPath: string, private emit: (stats: AdblockStats) => void) {
    setInterval(() => {
      if (!this.dirty) return;
      this.dirty = false; this.emit(this.snapshot());
    }, 2000).unref();
    setInterval(() => { if (this.stats.enabled) void this.load(); }, 3600_000).unref();

    ipcMain.removeHandler('@ghostery/adblocker/inject-cosmetic-filters');
    ipcMain.removeHandler('@ghostery/adblocker/is-mutation-observer-enabled');
    ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (event, url: unknown, msg: unknown) => this.cosmetics(event,url,msg));
    ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', event =>
      this.stats.enabled && this.attached.get(event.sender.session)?.ads ? this.blocker?.onIsMutationObserverEnabled(event) ?? false : false);
  }
  snapshot(): AdblockStats {
    return { ...this.stats, blocked: { ...this.stats.blocked }, popupsBlocked: { ...this.stats.popupsBlocked },securityBlocked:{...this.stats.securityBlocked} };
  }
  setEnabled(enabled: boolean) { this.stats.enabled=enabled;this.dirty=true; }
  countPopup(sourceId: string) {
    this.stats.popupsBlocked[sourceId]=(this.stats.popupsBlocked[sourceId]??0)+1;this.dirty=true;
  }
  private async cosmetics(event:IpcMainInvokeEvent,url:unknown,msg:unknown) {
    if(!this.stats.enabled||!this.blocker||!this.attached.get(event.sender.session)?.ads||typeof url!=='string')return;
    if(url.length>4096||!boundedInput(msg))return;
    const frame=event.senderFrame;
    if(!frame||frame.detached||url!==frame.url||!/^https?:\/\//i.test(url))return;
    // Ghostery's Electron helper injects into WebContents (the top document).
    // Route its trusted styles/scriptlets to the requesting player iframe instead.
    const sender={
      insertCSS:(css:string)=>frame.executeJavaScript('(()=>{const s=document.createElement("style");s.textContent='+JSON.stringify(css)+';(document.head||document.documentElement).append(s);})()').catch(()=>undefined),
      executeJavaScript:(code:string)=>frame.executeJavaScript(code).catch(()=>undefined),
    };
    const input=msg===undefined?undefined:msg&&typeof msg==='object'?msg:undefined;
    return this.blocker.onInjectCosmeticFilters({...event,sender,frameId:event.frameId,processId:event.processId} as unknown as IpcMainInvokeEvent,url,input as Parameters<ElectronBlocker['onInjectCosmeticFilters']>[2]);
  }
  /** Automatic checks keep last-known-good rules when the network is unavailable. */
  load(): Promise<void> { return this.refresh(false).catch(err=>{console.warn('[adblock]',errorMessage(err));}); }
  async update():Promise<AdblockStats> { if(this.loading)await this.loading;await this.refresh(true);return this.snapshot(); }
  private refresh(force:boolean):Promise<void> {
    if(this.loading)return this.loading;
    this.loading=this.init(force).finally(()=>{this.loading=null;});
    return this.loading;
  }
  private async init(force:boolean) {
    const stamp=await stat(this.cachePath).then(s=>s.mtimeMs).catch(()=>null);
    if(!force&&this.blocker&&stamp&&Date.now()-stamp<LIST_MAX_AGE_MS)return;
    this.stats.updating=true;this.stats.error=null;this.dirty=true;
    let cached:ElectronBlocker|null=null;
    try {
      if(!this.blocker)cached=await readFile(this.cachePath).then(bytes=>ElectronBlocker.deserialize(bytes)).catch(()=>null);
      let base:ElectronBlocker;
      if(!force&&cached&&stamp&&Date.now()-stamp<LIST_MAX_AGE_MS)base=cached;
      else {
        try {
          base=await ElectronBlocker.fromPrebuiltFull(url=>net.fetch(url,{signal:AbortSignal.timeout(20000)}));
          // Cache the base engine before local overrides, so removed overrides stay removed.
          await writeFile(this.cachePath+'.tmp',base.serialize());
          await rename(this.cachePath+'.tmp',this.cachePath);
        } catch(err) {
          this.stats.error='Filter update failed. Existing rules are still active.';
          if(force||(!this.blocker&&!cached))throw err;
          if(this.blocker)return;
          base=cached!;
        }
      }
      const custom=await readFile(this.filtersPath,'utf8').catch(()=>'');
      const added=custom.split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('!')&&!line.startsWith('['));
      if(added.length)base.updateFromDiff({added});
      this.blocker=base;this.stats.ready=true;
      this.stats.listsUpdatedAt=await stat(this.cachePath).then(s=>s.mtimeMs).catch(()=>stamp);
      for(const [ses,info] of this.attached)this.hook(ses,info.sourceId);
    } catch(err) {
      this.stats.error='Filter update failed. '+(this.blocker?'Existing rules are still active.':'Try updating again when connected.');
      throw err;
    } finally { this.stats.updating=false;this.dirty=true;this.emit(this.snapshot()); }
  }
  attach(ses:Session,sourceId:string,ads=true,guard?:(details:OnBeforeRequestListenerDetails)=>Promise<boolean>) {
    const existing=this.attached.get(ses);
    this.attached.set(ses,{sourceId,preloadId:existing?.preloadId??null,ads,guard:guard??existing?.guard});
    this.hook(ses,sourceId);
    if(ads&&!this.blocker)void this.load();
  }
  detach(ses:Session) {
    const info=this.attached.get(ses);if(!info)return;
    ses.webRequest.onBeforeRequest(null);ses.webRequest.onHeadersReceived(null);
    if(info.preloadId)ses.unregisterPreloadScript(info.preloadId);
    this.attached.delete(ses);
  }
  private hook(ses:Session,sourceId:string) {
    const info=this.attached.get(ses)!;
    if(this.blocker&&info.ads&&!info.preloadId)info.preloadId=ses.registerPreloadScript({type:'frame',filePath:PRELOAD_PATH});
    if(!info.ads&&info.preloadId){ses.unregisterPreloadScript(info.preloadId);info.preloadId=null;}
    ses.webRequest.onBeforeRequest({urls:['<all_urls>']},async(details,callback)=>{
      if(info.guard&&!await info.guard(details).catch(()=>false)){
        this.stats.securityBlocked[sourceId]=(this.stats.securityBlocked[sourceId]??0)+1;this.dirty=true;return callback({cancel:true});
      }
      if(!info.ads||!this.stats.enabled||!this.blocker)return callback({});
      this.blocker.onBeforeRequest(details,response=>{
        if(response.cancel||response.redirectURL){this.stats.blocked[sourceId]=(this.stats.blocked[sourceId]??0)+1;this.dirty=true;}
        callback(response);
      });
    });
    ses.webRequest.onHeadersReceived({urls:['<all_urls>']},(details,callback)=>{
      if(!info.ads||!this.stats.enabled||!this.blocker)return callback({});
      this.blocker.onHeadersReceived(details,callback);
    });
  }
}
