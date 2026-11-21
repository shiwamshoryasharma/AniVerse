import { Download, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { errorText, isAniVerse2 } from '../lib/bridge';
import { useToast } from '../lib/useToast';

export function DownloadMp4Button({ url, sourceId }: { url: string; sourceId?: string }) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const bridge = window.aniverse;
  if (!isAniVerse2 || !bridge?.saveMp4 || !/^https:\/\/[^?#]+\.mp4(?:[?#]|$)/i.test(url)) return null;

  const save = async () => {
    setSaving(true);
    setPercent(null);
    const stop = bridge.onMp4Progress?.(({ received, total }) => {
      setPercent(total ? Math.min(100, Math.floor(received * 100 / total)) : null);
    });
    try {
      if (await bridge.saveMp4?.(url, sourceId)) toast.push({ level: 'success', message: 'MP4 saved.' });
    } catch (error) {
      toast.push({ level: 'error', message: errorText(error) });
    } finally {
      stop?.();
      setSaving(false);
    }
  };

  return (
    <button className="btn" type="button" disabled={saving} onClick={() => void save()}>
      {saving ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}
      {saving ? (percent === null ? 'Saving MP4…' : `Saving MP4 ${percent}%`) : 'Download MP4'}
    </button>
  );
}