import { ArrowLeft, ArrowRight, ExternalLink, House, Lock, RotateCw, ShieldCheck, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { SourceInfo } from '../../../app/shared/types';
import { call } from '../lib/bridge';
import { cx, hostOf } from '../lib/format';
import { useAdblockStats, useSettings } from '../lib/queries';
import { Empty } from './common';

/** The subset of Electron's <webview> API the renderer uses. */
interface WebviewElement extends HTMLElement {
  loadURL(url: string, options?: { httpReferrer?: string }): Promise<void>;
  getURL(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  getWebContentsId(): number;
}

interface Props {
  source: SourceInfo;
  src: string;
  /** Sent as the HTTP referrer of the first request (YouTube embeds require an app identity). */
  referrer?: string;
  toolbar?: boolean;
  extra?: ReactNode;
  onNavigate?: (url: string) => void;
  onWebContents?: (id: number | null) => void;
  /** Imperative controls for callers that hide the built-in toolbar. */
  controls?: RefObject<WebSessionControls | null>;
}

export interface WebSessionControls {
  reload(): void;
  currentUrl(): string;
}

/**
 * A configured website rendered in its own isolated, persistent session
 * (`persist:src-<id>`). The main process enforces the partition, strips node
 * access, blocks ads/popups and cross-site redirects, and runs Cloudflare checks.
 */
export function WebSession({ source, src, referrer, toolbar = true, extra, onNavigate, onWebContents, controls }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<WebviewElement | null>(null);
  const ready = useRef(false);
  const pending = useRef<string | null>(null);
  /** Last URL handed to the webview, so re-renders never reload it (or drop its referrer). */
  const requested = useRef(src);
  const callbacks = useRef({ onNavigate, onWebContents });
  useLayoutEffect(() => {
    callbacks.current = { onNavigate, onWebContents };
  });
  const [url, setUrl] = useState(src);
  const [loading, setLoading] = useState(true);
  const [nav, setNav] = useState({ back: false, forward: false });
  const [failure, setFailure] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const stats = useAdblockStats().data;
  const settings = useSettings();
  const blocked = (stats?.blocked[source.id] ?? 0) + (stats?.popupsBlocked[source.id] ?? 0);
  const shieldOn = settings.privacy.adblock && source.adblock;

  // One webview per source partition; it survives src changes.
  useEffect(() => {
    const el = document.createElement('webview') as WebviewElement;
    el.setAttribute('partition', source.partition);
    el.setAttribute('allowpopups', '');
    el.setAttribute('webpreferences', 'contextIsolation=yes, sandbox=yes, javascript=yes');
    if (referrer) el.setAttribute('httpreferrer', referrer);
    el.setAttribute('src', src);
    requested.current = src;
    ready.current = false;

    const refreshNav = () => {
      try {
        setNav({ back: el.canGoBack(), forward: el.canGoForward() });
      } catch {
        // not attached yet
      }
    };
    const onNav = (e: Event & { url?: string; isMainFrame?: boolean }) => {
      if (e.isMainFrame === false || !e.url) return;
      setUrl(e.url);
      setFailure(null);
      refreshNav();
      callbacks.current.onNavigate?.(e.url);
    };
    const listeners: [string, (e: never) => void][] = [
      ['did-start-loading', () => setLoading(true)],
      ['did-stop-loading', () => (setLoading(false), refreshNav())],
      ['did-navigate', onNav],
      ['did-navigate-in-page', onNav],
      [
        'did-fail-load',
        (e: Event & { errorCode: number; errorDescription: string; isMainFrame: boolean; validatedURL: string }) => {
          // -3 = aborted (redirects, user navigation); ignore subframe failures from blocked ads.
          if (!e.isMainFrame || e.errorCode === -3) return;
          setFailure(`${e.errorDescription || 'Load failed'} (${e.errorCode}) — ${hostOf(e.validatedURL)}`);
        },
      ],
      [
        'dom-ready',
        () => {
          if (!ready.current) {
            ready.current = true;
            callbacks.current.onWebContents?.(el.getWebContentsId());
            if (pending.current) {
              void el.loadURL(pending.current, referrer ? { httpReferrer: referrer } : undefined).catch(() => undefined);
              pending.current = null;
            }
          }
        },
      ],
      ['enter-html-full-screen', () => setFullscreen(true)],
      ['leave-html-full-screen', () => setFullscreen(false)],
    ];
    for (const [name, fn] of listeners) el.addEventListener(name, fn as EventListener);
    host.current!.appendChild(el);
    view.current = el;
    return () => {
      for (const [name, fn] of listeners) el.removeEventListener(name, fn as EventListener);
      el.remove();
      view.current = null;
      callbacks.current.onWebContents?.(null);
    };
    // The partition defines the webview; src changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.partition, referrer]);

  useEffect(() => {
    if (src === requested.current) return;
    requested.current = src;
    const el = view.current;
    if (el && ready.current) void el.loadURL(src, referrer ? { httpReferrer: referrer } : undefined).catch(() => undefined);
    else pending.current = src;
  }, [src, referrer]);

  const act = (fn: (el: WebviewElement) => void) => {
    if (view.current && ready.current) fn(view.current);
  };

  useEffect(() => {
    if (!controls) return;
    controls.current = { reload: () => act((el) => el.reload()), currentUrl: () => url };
  });

  return (
    <div className={cx('websession', fullscreen && 'fs')} style={fullscreen ? { position: 'fixed', inset: 0, zIndex: 200 } : undefined}>
      {toolbar && !fullscreen && (
        <div className="websession-bar">
          <button className="icon-btn xs" aria-label="Back" disabled={!nav.back} onClick={() => act((el) => el.goBack())}>
            <ArrowLeft size={15} />
          </button>
          <button className="icon-btn xs" aria-label="Forward" disabled={!nav.forward} onClick={() => act((el) => el.goForward())}>
            <ArrowRight size={15} />
          </button>
          <button className="icon-btn xs" aria-label={loading ? 'Stop' : 'Reload'} onClick={() => act((el) => (loading ? el.stop() : el.reload()))}>
            {loading ? <X size={15} /> : <RotateCw size={14} />}
          </button>
          <button className="icon-btn xs" aria-label="Site home" onClick={() => act((el) => void el.loadURL(source.url))}>
            <House size={14} />
          </button>
          <div className="websession-url" title={url}>
            <Lock size={12} />
            <span>
              <b style={{ color: 'var(--text)' }}>{hostOf(url)}</b>
              {(() => {
                try {
                  const u = new URL(url);
                  return u.pathname + u.search;
                } catch {
                  return '';
                }
              })()}
            </span>
          </div>
          <span className={cx('shield', !shieldOn && 'off')} title={shieldOn ? 'Ads, trackers, popups and redirects blocked on this site' : 'Ad blocking is off for this site'}>
            <ShieldCheck size={12} /> {shieldOn ? blocked : 'off'}
          </span>
          {extra}
          <button className="icon-btn xs" aria-label="Open in system browser" title="Open in system browser" onClick={() => void call('app.openExternal', { url })}>
            <ExternalLink size={14} />
          </button>
        </div>
      )}
      <div className="websession-host" ref={host}>
        {loading && <div className="websession-loading" />}
        {failure && (
          <div className="websession-error">
            <Empty title="This page didn’t load">
              {failure}
              <br />
              <button className="btn sm" style={{ marginTop: 12 }} onClick={() => (setFailure(null), act((el) => el.reload()))}>
                Try again
              </button>
            </Empty>
          </div>
        )}
      </div>
    </div>
  );
}
