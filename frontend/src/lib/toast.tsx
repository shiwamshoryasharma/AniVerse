import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, Info, ShieldAlert, TriangleAlert, X } from 'lucide-react';
import { call, onEvent } from './bridge';
import type { CloudflareEvent } from '../../../app/shared/types';
import { ToastContext, type Toast } from './useToast';

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [verifications, setVerifications] = useState<Record<string, CloudflareEvent>>({});
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-4), { ...t, id }]);
      if (!t.sticky) setTimeout(() => dismiss(id), t.level === 'error' ? 8000 : 4500);
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const offs = [
      onEvent('app.notice', (n) =>
        push({
          level: n.level,
          message: n.message,
          action: n.url ? { label: 'Open in browser', run: () => void call('app.openExternal', { url: n.url! }) } : undefined,
        }),
      ),
      onEvent('cloudflare.status', (e) => {
        setVerifications((v) => {
          const next = { ...v };
          if (e.state === 'checking' || e.state === 'needs-user') next[e.sourceId] = e;
          else delete next[e.sourceId];
          return next;
        });
        if (e.state === 'failed') push({ level: 'error', message: e.message });
      }),
      onEvent('sync.status', (e) => {
        if (e.state === 'error') push({ level: 'warn', message: `${e.provider === 'mal' ? 'MyAnimeList' : 'AniList'}: ${e.message}` });
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [push]);

  const api = useMemo(() => ({ push, dismiss }), [push, dismiss]);
  const banners = Object.values(verifications);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {banners.length > 0 && (
        <div className="cf-banners" role="status">
          {banners.map((b) => (
            <div key={b.sourceId} className={`cf-banner ${b.state}`}>
              <ShieldAlert size={16} />
              <span>{b.message}</span>
              {b.state === 'checking' && <span className="spinner sm" />}
            </div>
          ))}
        </div>
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`}>
            {t.level === 'success' ? <CheckCircle2 size={16} /> : t.level === 'info' ? <Info size={16} /> : <TriangleAlert size={16} />}
            <span className="toast-msg">{t.message}</span>
            {t.action && (
              <button
                className="btn ghost xs"
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button className="icon-btn xs" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
