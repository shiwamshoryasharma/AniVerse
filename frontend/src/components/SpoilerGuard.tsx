import { Eye, Shield } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useSettings } from '../lib/queries';

export function SpoilerGuard({ label, children }: { label: string; children: ReactNode }) {
  const settings = useSettings();
  const [revealed, setRevealed] = useState(false);
  if (!settings.appearance.spoilerShield || revealed) return children;
  return (
    <div className="spoiler-guard">
      <Shield size={18} />
      <span>{label} hidden by Spoiler Shield</span>
      <button className="btn sm" onClick={() => setRevealed(true)}>
        <Eye size={14} /> Reveal
      </button>
    </div>
  );
}
