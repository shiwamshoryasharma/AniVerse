import { AlertTriangle, RotateCw, SearchX } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { SourceInfo } from '../../../app/shared/types';
import { errorText } from '../lib/bridge';
import { cx } from '../lib/format';

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="lg-av" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--accent-2)" />
          <stop offset="1" stopColor="var(--accent)" />
        </linearGradient>
      </defs>
      <path d="M14 46 30 14h4l16 32h-8l-4-8.5H26L22 46Zm15-15h6l-3-6.6Z" fill="url(#lg-av)" />
      <ellipse cx="32" cy="34" rx="25" ry="8" fill="none" stroke="url(#lg-av)" strokeWidth="2.5" transform="rotate(-18 32 34)" opacity=".85" />
    </svg>
  );
}

export function Spinner({ size }: { size?: 'sm' | 'lg' }) {
  return <span className={cx('spinner', size)} role="progressbar" aria-label="Loading" />;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state">
      <Spinner size="lg" />
      <span className="muted">{label}</span>
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'Something went wrong' }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div className="state">
      <AlertTriangle size={30} />
      <h3>{title}</h3>
      <p>{errorText(error)}</p>
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          <RotateCw size={14} /> Retry
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="state">
      {icon ?? <SearchX size={30} />}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={cx('switch', on && 'on')} onClick={() => onChange(!on)} />;
}

/** Site favicon loaded from the source's own origin, with a lettered fallback. */
export function SourceIcon({ source, size = 14 }: { source: Pick<SourceInfo, 'host' | 'kind' | 'name'>; size?: number }) {
  const [failed, setFailed] = useState(false);
  const host = source.kind === 'youtube' ? 'www.youtube.com' : source.host;
  if (failed) {
    return (
      <span className="favicon-fallback" style={{ width: size, height: size }}>
        {source.name.replace(/^@/, '')[0]?.toUpperCase()}
      </span>
    );
  }
  return <img src={`https://${host}/favicon.ico`} width={size} height={size} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} style={{ borderRadius: 3 }} />;
}

export function Modal({ title, children, onClose, actions }: { title: string; children: ReactNode; onClose: () => void; actions?: ReactNode }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card" role="dialog" aria-modal aria-label={title}>
        <h3>{title}</h3>
        {children}
        {actions && <div className="row" style={{ justifyContent: 'flex-end' }}>{actions}</div>}
      </div>
    </div>
  );
}
