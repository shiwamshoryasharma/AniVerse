import { AlertTriangle, Home, RefreshCw } from 'lucide-react';
import { useRouteError } from 'react-router';

/** Shown when a screen throws while rendering: what broke, and two ways out. */
export function RouteCrash() {
  const error = useRouteError();
  const detail = error instanceof Error ? error.message : error ? String(error) : '';
  return (
    <div className="page">
      <div className="state">
        <AlertTriangle size={30} />
        <h3>Something went wrong</h3>
        <p>This screen crashed. Reloading AniVerse usually fixes it — your library, accounts and settings are safe.</p>
        {detail && (
          <p className="code" style={{ maxWidth: 680, whiteSpace: 'pre-wrap', fontSize: 'var(--fs-xs)' }}>
            {detail}
          </p>
        )}
        <div className="row" style={{ gap: 10 }}>
          <button className="btn primary" onClick={() => window.location.reload()}>
            <RefreshCw size={14} /> Reload AniVerse
          </button>
          <button className="btn" onClick={() => (window.location.hash = '#/')}>
            <Home size={14} /> Go home
          </button>
        </div>
      </div>
    </div>
  );
}
