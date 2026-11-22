import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { isAniVerse2 } from '../lib/bridge';
import { useSettingsReady } from '../lib/queries';
import { refreshVisibleQueries } from '../lib/refreshManager';

/** Re-fetches active queries once; ordinary startup and polling keep their own loading feedback. */
export function RefreshButton() {
  const qc = useQueryClient();
  const ready = useSettingsReady();
  const fetching = useIsFetching({ predicate: () => !isAniVerse2 });
  const [spin, setSpin] = useState(false);
  return (
    <button
      className="icon-btn bordered"
      aria-label="Refresh"
      aria-busy={spin}
      disabled={isAniVerse2 && (!ready || spin)}
      title={isAniVerse2 && !ready ? 'Loading local settings…' : 'Refresh (F5)'}
      onClick={() => {
        if (isAniVerse2 && (!ready || document.hidden)) return;
        setSpin(true);
        const task = isAniVerse2 ? refreshVisibleQueries(qc) : qc.invalidateQueries();
        void task.finally(() => setSpin(false));
      }}
    >
      <RefreshCw size={15} className={spin || (!isAniVerse2 && fetching > 0) ? 'spin' : undefined} />
    </button>
  );
}