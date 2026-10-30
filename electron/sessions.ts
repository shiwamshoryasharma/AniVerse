import type {RustPolicy} from '../app/core/security/rustPolicy';
import {SourceNetworkGuard} from './sourceNetwork';
import { randomUUID } from 'node:crypto';
import { app, session, shell, webContents, type Session, type WebContents } from 'electron';
import { isChallengeTitle, isCloudflareChallenge } from '../app/core/net/cloudflare';
import type { SourceRegistry } from '../app/core/sources/registry';
import type { SiteFetcher, SiteResponse } from '../app/core/sources/types';
import { siteDomain } from '../app/core/sources/web';
import { AppError } from '../app/core/util';
import type { AppNotice, CloudflareEvent, Settings, SourceInfo } from '../app/shared/types';
import type { Adblocker } from './adblock';
import type { CloudflareSolver } from './cloudflare';

/** Identity providers a site may legitimately send the user to for sign-in. */
const SIGN_IN_HOSTS = [
  'accounts.google.com',
  'accounts.youtube.com',
  'consent.youtube.com',
  'consent.google.com',
  'discord.com',
  'github.com',
  'appleid.apple.com',
  'www.facebook.com',
  'x.com',
  'twitter.com',
  'api.twitter.com',
  'challenges.cloudflare.com',
];

const YOUTUBE_DOMAINS = ['youtube.com', 'youtube-nocookie.com', 'youtu.be', 'google.com', 'gstatic.com', 'ytimg.com'];

/** Chromium UA without the Electron/app tokens, so sites see the real engine. */
export function browserUserAgent(): string {
  return app.userAgentFallback.replace(/\s(aniverse|AniVerse|Electron)\/\S+/g, '');
}

export class SessionManager implements SiteFetcher {
  private configured = new Set<string>();
  private networkGuards=new Map<string,SourceNetworkGuard>();
  private guests = new Map<number, string>();
  private challengeTimers = new Map<number, NodeJS.Timeout>();
  private privateLeases=new Map<string,SourceInfo[]>();
  private incognitoLease:string|null=null;
  private issuedSources(){return [...this.privateLeases.values()].flat();}
  private currentIssued(source:SourceInfo):SourceInfo|null {
    try{return {...this.registry.get(source.id),partition:source.partition};}catch{return null;}
  }
  privateLease(){
    const leaseId=randomUUID();
    const sources=this.registry.list().map(source=>({...source,partition:'private-'+leaseId+'-'+source.id}));
    this.privateLeases.set(leaseId,sources);return {leaseId,sources};
  }
  sourceList():SourceInfo[]{
    if(!this.privateSessionActive())return this.registry.list();
    if(!this.incognitoLease||!this.privateLeases.has(this.incognitoLease))this.incognitoLease=this.privateLease().leaseId;
    return this.privateLeases.get(this.incognitoLease)!.map(source=>this.currentIssued(source)).filter((source):source is SourceInfo=>!!source);
  }
  closeGuests(){for(const id of this.guests.keys()){const guest=webContents.fromId(id);if(guest&&!guest.isDestroyed())guest.close({waitForBeforeUnload:false});}}
  async releasePrivate(leaseId:string){
    const sources=this.privateLeases.get(leaseId);if(!sources)return;
    for(const id of this.guests.keys()){const guest=webContents.fromId(id);if(guest&&sources.some(s=>session.fromPartition(s.partition)===guest.session))guest.close({waitForBeforeUnload:false});}
    this.privateLeases.delete(leaseId);if(this.incognitoLease===leaseId)this.incognitoLease=null;
    await Promise.all(sources.map(async source=>{
      if(!this.configured.has(source.partition))return;
      const ses=session.fromPartition(source.partition);this.adblock.detach(ses);this.configured.delete(source.partition);this.networkGuards.delete(source.partition);
      await Promise.all([ses.clearStorageData(),ses.clearCache()]);
    }));
  }
  async clearPrivate(){await Promise.all([...this.privateLeases.keys()].map(id=>this.releasePrivate(id)));}

  constructor(
    private registry: SourceRegistry,
    private adblock: Adblocker,
    private cloudflare: CloudflareSolver,
    private settings: () => Settings,
    private notify: (n: AppNotice) => void,
    private emitCloudflare: (e: CloudflareEvent) => void,
    private security:RustPolicy,
    private privateSessionActive:()=>boolean=()=>false,
  ) {}

  /** Creates/configures the isolated session for a source (idempotent). */
  ensure(source: SourceInfo): Session {
    if(this.privateSessionActive()&&source.partition.startsWith('persist:'))source=this.sourceList().find(s=>s.id===source.id)??source;
    const ses = session.fromPartition(source.partition,{cache:source.partition.startsWith('persist:')});
    if (!this.configured.has(source.partition)) {
      this.configured.add(source.partition);
      ses.setUserAgent(browserUserAgent());
      ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'fullscreen' || permission === 'clipboard-sanitized-write'));
      ses.setPermissionCheckHandler((_wc, permission) => permission === 'fullscreen' || permission === 'clipboard-sanitized-write');
      ses.setDevicePermissionHandler(() => false);
      ses.on('will-download', (event, item) => {
        // Drive-by downloads from ad networks are a common malware vector; AniVerse never downloads media.
        event.preventDefault();
        this.notify({ level: 'warn', message: `Blocked a download from ${source.name}: ${item.getFilename()}`, sourceId: source.id });
      });
    }
    this.applyAdblock(source, ses);
    return ses;
  }

  private applyAdblock(source: SourceInfo, ses: Session) {
    const enabled = this.settings().privacy.adblock && source.adblock;
    let guard=this.networkGuards.get(source.partition);
    if(!guard){guard=new SourceNetworkGuard(this.security,ses,()=>this.registry.get(source.id).url);this.networkGuards.set(source.partition,guard);}
    this.adblock.attach(ses,source.id,enabled,details=>guard.check(details));
  }

  /** Re-applies per-source settings after config or settings changes. */
  refresh() {
    for (const source of [...this.registry.list(),...this.issuedSources()]) {
      if (this.configured.has(source.partition)) this.applyAdblock(source, session.fromPartition(source.partition));
    }
    this.adblock.setEnabled(this.settings().privacy.adblock);
  }

  sourceForPartition(partition: string): SourceInfo | null {
    const issued=this.issuedSources().find(s=>s.partition===partition);
    return issued?this.currentIssued(issued):this.registry.byPartition(partition);
  }

  sourceForSession(ses: Session): SourceInfo | null {
    return [...this.registry.list(),...this.issuedSources()].find((s) => this.configured.has(s.partition) && session.fromPartition(s.partition) === ses) ?? null;
  }

  // ---------------------------------------------------------------- webviews

  /** Validates a webview before it attaches (called from will-attach-webview). */
  allowAttach(partition: string, src: string): SourceInfo | null {
    if(this.privateSessionActive()&&partition.startsWith('persist:'))return null;
    const source = this.sourceForPartition(partition);
    if (!source || !source.enabled) return null;
    if (!this.isAllowedUrl(source, src)|| (src!=='about:blank'&&!this.security.decide({context:'navigate',url:src,source:source.url}).allowed)) return null;
    this.ensure(source);
    return source;
  }

  /** Applies navigation, popup and Cloudflare policies to a source webview. */
  manageGuest(guest: WebContents, source: SourceInfo) {
    this.guests.set(guest.id, source.id);
    guest.once('destroyed', () => {
      this.guests.delete(guest.id);
      clearTimeout(this.challengeTimers.get(guest.id));
      this.challengeTimers.delete(guest.id);
    });

    guest.setWindowOpenHandler(({ url, disposition }) => {
      const current = this.registry.list().find((s) => s.id === source.id) ?? source;
      if (this.settings().privacy.blockPopups) {
        this.adblock.countPopup(source.id);
        return { action: 'deny' };
      }
      if(!this.security.decide({context:'external',url,source:current.url}).allowed){this.adblock.countPopup(source.id);return {action:'deny'};}
      if (this.isAllowedUrl(current, url) && disposition !== 'background-tab' && !this.isSignInUrl(url)) {
        // Same-site "open in new tab" links stay inside the source session.
        setImmediate(() => !guest.isDestroyed() && guest.loadURL(url));
      } else if (this.settings().privacy.blockPopups || !/^https?:/i.test(url)) {
        this.adblock.countPopup(source.id);
      } else {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    const guardNavigation = (event: Electron.Event, url: string) => {
      const current = this.registry.list().find((s) => s.id === source.id) ?? source;
      if(url==='about:blank'||this.security.decide({context:'navigate',url,source:current.url,allowed_origins:SIGN_IN_HOSTS.map(host=>'https://'+host)}).allowed)return;
      event.preventDefault();
      if (this.settings().privacy.blockPopups) {
        this.adblock.countPopup(source.id);
        this.notify({ level: 'info', message: `Blocked a redirect from ${source.name} to ${safeHost(url)}.`, sourceId: source.id, url });
      }
    };
    guest.on('will-navigate', guardNavigation);
    guest.on('will-redirect', (event, url, _inPlace, isMainFrame) => { if(isMainFrame)guardNavigation(event,url); });

    guest.on('page-title-updated', (_e, title) => this.onTitle(guest, source, title));
  }

  private onTitle(guest: WebContents, source: SourceInfo, title: string) {
    const existing = this.challengeTimers.get(guest.id);
    if (isChallengeTitle(title)) {
      if (existing) return;
      this.emitCloudflare({ sourceId: source.id, state: 'checking', message: `Cloudflare is checking ${source.name}…` });
      this.challengeTimers.set(
        guest.id,
        setTimeout(() => {
          if (!guest.isDestroyed() && isChallengeTitle(guest.getTitle())) {
            this.emitCloudflare({ sourceId: source.id, state: 'needs-user', message: `Complete the Cloudflare check shown in the ${source.name} page.` });
          }
        }, 7000),
      );
    } else if (existing) {
      clearTimeout(existing);
      this.challengeTimers.delete(guest.id);
      this.emitCloudflare({ sourceId: source.id, state: 'cleared', message: `${source.name} verified.` });
    }
  }

  isGuestOf(guest: WebContents): string | null {
    return this.guests.get(guest.id) ?? null;
  }

  private isAllowedUrl(source: SourceInfo, url: string): boolean {
    let host: string;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return u.protocol === 'about:';
      host = u.hostname.toLowerCase();
    } catch {
      return false;
    }
    const domain = siteDomain(host);
    if (source.kind === 'youtube') return YOUTUBE_DOMAINS.includes(domain);
    return domain === siteDomain(source.host);
  }

  private isSignInUrl(url: string): boolean {
    try {
      return SIGN_IN_HOSTS.includes(new URL(url).hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- SiteFetcher

  async get(sourceId: string, url: string, opts: { accept?: string; timeoutMs?: number } = {}): Promise<SiteResponse> {
    const source = this.registry.get(sourceId);
    const ses = this.ensure(source);
    let res = await this.fetchOnce(ses, url, opts);
    if (isCloudflareChallenge(res.status, res.headers, res.text)) {
      if (!this.settings().privacy.autoCloudflare || !source.autoCloudflare) {
        throw new AppError('cloudflare', `${source.name} is behind a Cloudflare check. Open it from Sources to verify, or enable automatic verification.`);
      }
      await this.cloudflare.solve(source.id, source.name, ses, url);
      res = await this.fetchOnce(ses, url, opts);
      if (isCloudflareChallenge(res.status, res.headers, res.text)) {
        throw new AppError('cloudflare', `${source.name} still shows a Cloudflare check after verification.`);
      }
    }
    if (res.status >= 400) throw new AppError(res.status === 404 ? 'not-found' : 'network', `${source.name} responded ${res.status}.`);
    return res;
  }

  private async fetchOnce(ses: Session, url: string, opts: { accept?: string; timeoutMs?: number }): Promise<SiteResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
    try {
      const res = await ses.fetch(url, {
        headers: { Accept: opts.accept ?? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'User-Agent': browserUserAgent() },
        signal: controller.signal,
        redirect: 'follow',
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return { status: res.status, url: res.url || url, text: await res.text(), headers };
    } catch (err) {
      throw new AppError('network', `Could not reach ${safeHost(url)}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async sessionInfo(sourceId: string): Promise<{ cookies: number; signedIn: boolean }> {
    const ses = this.ensure(this.registry.get(sourceId));
    const cookies = await ses.cookies.get({});
    // Heuristic: an HTTP-only, long-lived cookie whose name looks like an auth token.
    // Anonymous session cookies (PHPSESSID, ci_session…) and Cloudflare's do not count.
    const authName = /(remember|auth|token|jwt|logged|login|user_?id|uid|sid_|account)/i;
    const signedIn = cookies.some((c) => c.httpOnly && authName.test(c.name) && !/^(__cf|cf_)/.test(c.name) && (c.expirationDate ?? 0) * 1000 - Date.now() > 86400000);
    return { cookies: cookies.length, signedIn };
  }

  async clear(sourceId: string) {
    const ses = this.ensure(this.registry.get(sourceId));
    await ses.clearStorageData();
    await ses.clearCache();
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'another site';
  }
}
