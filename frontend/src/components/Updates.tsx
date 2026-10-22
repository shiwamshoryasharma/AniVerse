import { ArrowDownCircle, RotateCw } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useUpdateState } from '../lib/queries';
import { updateSummary, useInstallUpdate } from '../lib/updates';

/** Top-bar pill while an update is on its way or ready to install. */
export function UpdateBadge() {
  const { data: u } = useUpdateState();
  const navigate = useNavigate();
  const install = useInstallUpdate();
  if (!u || !['available', 'downloading', 'downloaded'].includes(u.status)) return null;
  const ready = u.status === 'downloaded';
  const label = ready ? 'Restart to update' : u.status === 'downloading' ? `Updating ${Math.floor(u.progress?.percent ?? 0)}%` : `Update ${u.version}`;
  return (
    <button className={`update-pill${ready ? ' ready' : ''}`} title={updateSummary(u)} onClick={() => (ready ? void install() : navigate('/settings/about'))}>
      {ready ? <RotateCw size={14} /> : <ArrowDownCircle size={14} />} {label}
    </button>
  );
}
