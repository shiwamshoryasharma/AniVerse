import { ArrowLeft, ArrowRight, ExternalLink, House, RotateCw, ShieldCheck, X } from 'lucide-react';
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { errorText } from '../lib/bridge';
import { hostOf } from '../lib/format';
import { Empty } from './common';
import { DownloadMp4Button } from './DownloadMp4Button';
import type { WebSessionProps } from './WebSession';

interface Bounds { x: number; y: number; width: number; height: number }
interface SurfaceEvent { webContentsId: number; url?: string; finished: boolean; blocked?: boolean }
interface NativeBridge {
  core: { invoke<T>(method: string, input: Record<string, unknown>): Promise<T> };
  event: { listen<T>(event: string, callback: (event: { payload: T }) => void): Promise<() => void> };
}
const tauri = (window as Window & { __TAURI__?: NativeBridge }).__TAURI__;
const rpc = <T,>(input: Record<string, unknown>) =>
  tauri ? tauri.core.invoke<T>('desktop_rpc', { method: 'site.surface', input }) : Promise.reject(new Error('The Windows source view is unavailable.'));

function position(host: HTMLElement, suspended: boolean) {
  const box = host.getBoundingClientRect();
  const scroll = host.closest('.main')?.getBoundingClientRect();
  const bottom = Math.min(window.innerHeight, scroll?.bottom ?? window.innerHeight);
  const right = Math.min(window.innerWidth, scroll?.right ?? window.innerWidth);
  const x = Math.max(box.left, 0, scroll?.left ?? 0);
  const y = Math.max(box.top, 0, scroll?.top ?? 0);
  const visible = !suspended && box.bottom > y && box.right > x && bottom > y && right > x;
  const bounds: Bounds = {
    x: Math.floor(x),
    y: Math.floor(y),
    width: Math.max(1, Math.floor(Math.min(box.right, right) - x)),
    height: Math.max(1, Math.floor(Math.min(box.bottom, bottom) - y)),
  };
  return { bounds, visible };
}

export function TauriWebSession({ source, src, mediaId, toolbar = true, extra, onNavigate, onWebContents, controls, onDirectMp4, onSurfaceError, suspended = false }: WebSessionProps) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onNavigate, onWebContents, onDirectMp4, onSurfaceError });
  useLayoutEffect(() => { callbacks.current = { onNavigate, onWebContents, onDirectMp4, onSurfaceError }; });
  const [attachAttempt, setAttachAttempt] = useState(0);
  const [guest, setGuest] = useState<number | null>(null);
  const [url, setUrl] = useState(src);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [mp4, setMp4] = useState<string | null>(null);
  const [backSteps, setBackSteps] = useState(0);
  const requested = useRef<string | null>(null);
  const base = useRef(src);

  useEffect(() => {
    const element = host.current;
    if (!element || !tauri) return;
    let closed = false;
    let id: number | null = null;
    let detachEvent: (() => void) | undefined;
    requested.current = null;
    const setup = async () => {
      detachEvent = await tauri.event.listen<SurfaceEvent>('aniverse:site/surface', ({ payload: event }) => {
        if (closed || id === null || event.webContentsId !== id) return;
        if (event.blocked) {
          setLoading(false);
          if (toolbar) setFailure('The source redirected outside its configured site.');
          return;
        }
        setLoading(!event.finished);
        if (!event.finished) { setMp4(null); callbacks.current.onDirectMp4?.(null); }
        if (!event.finished || !event.url || event.url === 'about:blank') return;
        setUrl(event.url);
        setFailure(null);
        setBackSteps((count) => count + 1);
        callbacks.current.onNavigate?.(event.url);
        // A top-level same-origin public MP4 may be saved explicitly without inspecting the video or its requests.
        void rpc<string | null>({ action: 'directMp4', webContentsId: id }).then((file) => {
          if (!closed) { setMp4(file); callbacks.current.onDirectMp4?.(file); }
        }, () => { if (!closed) { setMp4(null); callbacks.current.onDirectMp4?.(null); } });
      });
      if (closed) { detachEvent(); return; }
      const response = await rpc<{ webContentsId: number }>({
        action: 'attach', sourceId: source.id, partition: source.partition, mediaId, bounds: position(element, true).bounds,
      });
      id = response.webContentsId;
      if (closed) { await rpc({ action: 'detach', webContentsId: id }); return; }
      setGuest(id);
      callbacks.current.onWebContents?.(id);
    };
    void setup().catch((error) => {
      if (closed) return;
      const message = errorText(error);
      setFailure(message);
      callbacks.current.onSurfaceError?.(message);
    });
    return () => {
      closed = true;
      detachEvent?.();
      if (id !== null) void rpc({ action: 'detach', webContentsId: id }).catch(() => undefined);
      callbacks.current.onWebContents?.(null);
    };
  }, [source.id, source.partition, mediaId, toolbar, attachAttempt]);

  useEffect(() => {
    if (guest === null || src === requested.current || src === 'about:blank') return;
    requested.current = src;
    setLoading(true);
    void rpc({ action: 'navigate', webContentsId: guest, url: src }).catch((error) => {
      setLoading(false);
      setFailure(errorText(error));
    });
  }, [guest, src]);

  useEffect(() => {
    const element = host.current;
    if (guest === null || !element) return;
    let last = '';
    let raf = 0;
    const measure = () => {
      raf = 0;
      const region = position(element, suspended || !!failure || document.hidden);
      const key = JSON.stringify(region);
      if (key === last) return;
      last = key;
      void rpc({ action: 'place', webContentsId: guest, ...region }).catch(() => undefined);
    };
    const queue = () => { if (!raf) raf = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(queue);
    resize.observe(element);
    document.addEventListener('scroll', queue, true);
    document.addEventListener('visibilitychange', queue);
    window.addEventListener('resize', queue);
    queue();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      resize.disconnect();
      document.removeEventListener('scroll', queue, true);
      document.removeEventListener('visibilitychange', queue);
      window.removeEventListener('resize', queue);
    };
  }, [guest, suspended, failure]);

  const act = (action: string, target?: string) => {
    if (guest === null) {
      if (action === 'reload') {
        setFailure(null);
        callbacks.current.onSurfaceError?.(null);
        setAttachAttempt((attempt) => attempt + 1);
      }
      return;
    }
    if (action === 'navigate' || action === 'reload') setFailure(null);
    void rpc({ action, webContentsId: guest, url: target }).catch((error) => setFailure(errorText(error)));
  };
  useImperativeHandle(controls, () => ({ reload: () => act('reload'), currentUrl: () => url || base.current }));

  return (
    <div className="websession">
      {toolbar && (
        <div className="websession-bar">
          <button className="icon-btn xs" aria-label="Back" disabled={backSteps < 2} onClick={() => act('back')}><ArrowLeft size={15}/></button>
          <button className="icon-btn xs" aria-label="Forward" disabled={backSteps < 2} onClick={() => act('forward')}><ArrowRight size={15}/></button>
          <button className="icon-btn xs" aria-label={loading ? 'Stop' : 'Reload'} onClick={() => act(loading ? 'stop' : 'reload')}>{loading ? <X size={15}/> : <RotateCw size={14}/>}</button>
          <button className="icon-btn xs" aria-label="Site home" onClick={() => act('navigate', source.url)}><House size={14}/></button>
          <div className="websession-url" title={url}><ShieldCheck size={12}/><span>{hostOf(url)}</span></div>
          {mp4 && <DownloadMp4Button url={mp4} sourceId={source.id}/>}
          {extra}
          <button className="icon-btn xs" aria-label="Open in system browser" onClick={() => act('external')}><ExternalLink size={14}/></button>
        </div>
      )}
      <div className="websession-host" ref={host}>
        {loading && <div className="websession-loading"/>}
        {failure && <div className="websession-error">
          <Empty title="This page didn’t load">{failure}<br/><button className="btn sm" onClick={() => act('reload')}>Try again</button></Empty>
        </div>}
      </div>
    </div>
  );
}