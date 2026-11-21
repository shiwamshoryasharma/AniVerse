import { Download, LoaderCircle } from 'lucide-react';
import { useId, useState } from 'react';
import { errorText, isAniVerse2 } from '../lib/bridge';
import { useToast } from '../lib/useToast';

export function DownloadMp4Button({ url, sourceId, unavailableReason }: {
  url?: string | null;
  sourceId?: string;
  unavailableReason?: string;
}) {
  const toast = useToast();
  const hint = useId();
  const [saving, setSaving] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const bridge = window.aniverse;
  const available = !!bridge?.saveMp4 && !!url && /^https:\/\/[^?#]+\.mp4(?:[?#]|$)/i.test(url);
  if (!isAniVerse2 || (!available && !unavailableReason)) return null;

  const save = async () => {
    if (!available || !url || saving) return;
    setSaving(true);
    setPercent(null);
    const stop = bridge?.onMp4Progress?.(({ received, total }) => {
      setPercent(total ? Math.min(100, Math.floor(received * 100 / total)) : null);
    });
    try {
      if (await bridge?.saveMp4?.(url, sourceId)) toast.push({ level: 'success', message: 'MP4 saved.' });
    } catch (error) {
      toast.push({ level: 'error', message: errorText(error) });
    } finally {
      stop?.();
      setSaving(false);
    }
  };

  return (
    <>
      <button className="btn" type="button" disabled={saving} aria-disabled={!available || undefined}
        aria-describedby={!available ? hint : undefined} onClick={() => void save()}>
        {saving ? <LoaderCircle size={15} className="spin" aria-hidden /> : <Download size={15} aria-hidden />}
        {saving ? (percent === null ? 'Saving MP4…' : `Saving MP4 ${percent}%`) : 'Download MP4'}
      </button>
      {!available && <small className="watch-media-hint" id={hint}>{unavailableReason}</small>}
    </>
  );
}
