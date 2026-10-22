import { app, session, shell, type Session, type WebContents } from 'electron';
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
  private guests = new Map<number, string>();
  private challengeTimers = new Map<number, NodeJS.Timeout>();

  constructor(
    private registry: SourceRegistry,
    private adblock: Adblocker,
    private cloudflare: CloudflareSolver,
    private settings: () => Settings,
    private notify: (n: AppNotice) => void,
    private emitCloudflare: (e: CloudflareEvent) => void,
  ) {}

  /** Creates/configures the isolated session for a source (idempotent). */
  ensure(source: SourceInfo): Session {
    const ses = session.fromPartition(source.partition);
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
    if (enabled) this.adblock.attach(ses, source.id);
    else this.adblock.detach(ses);
  }

  /** Re-applies per-source settings after config or settings changes. */
  refresh() {
    for (const source of this.registry.list()) {
      if (this.configured.has(source.partition)) this.applyAdblock(source, session.fromPartition(source.partition));
    }
    this.adblock.setEnabled(this.settings().privacy.adblock);
  }

  sourceForPartition(partition: string): SourceInfo | null {
    return this.registry.byPartition(partition);
  }

  sourceForSession(ses: Session): SourceInfo | null {
    return this.registry.list().find((s) => this.configured.has(s.partition) && session.fromPartition(s.partition) === ses) ?? null;
  }

  // ---------------------------------------------------------------- webviews

  /** Validates a webview before it attaches (called from will-attach-webview). */
  allowAttach(partition: string, src: string): SourceInfo | null {
    const source = this.sourceForPartition(partition);
    if (!source || !source.enabled) return null;
    if (!this.isAllowedUrl(source, src)) return null;
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

    guest.on('will-navigate', (event, url) => {
      const current = this.registry.list().find((s) => s.id === source.id) ?? source;
      if (this.isAllowedUrl(current, url) || this.isSignInUrl(url)) return;
      event.preventDefault();
      if (this.settings().privacy.blockPopups) {
        this.adblock.countPopup(source.id);
        this.notify({ level: 'info', message: `Blocked a redirect from ${source.name} to ${safeHost(url)}.`, sourceId: source.id, url });
      }
    });

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
