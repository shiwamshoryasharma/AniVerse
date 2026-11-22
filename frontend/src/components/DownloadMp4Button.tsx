import type { EpisodeDownloadContext } from '../../../app/shared/download-filename';
import { isDownloadableVideoUrl } from '../../../app/shared/downloadFormats';
import { Download, LoaderCircle } from 'lucide-react';
import { useId, useState } from 'react';
import { errorText, modernWindows } from '../lib/bridge';
import { useToast } from '../lib/useToast';

export function DownloadMp4Button({ url, sourceId, webContentsId, filenameContext, unavailableReason }: {
  url?: string | null;
  sourceId?: string;
  webContentsId?: number;
  filenameContext?: EpisodeDownloadContext;
  unavailableReason?: string;
}) {
  const toast = useToast();
  const hint = useId();
  const [saving, setSaving] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const bridge = window.aniverse;
  const direct = !!bridge?.saveMp4 && !!url && isDownloadableVideoUrl(url);
  const active = webContentsId !== undefined && !!bridge?.saveSiteMp4;
  const available = direct || active;
  if (!modernWindows || (!available && !unavailableReason)) return null;

  const save = async () => {
    if (!available || saving) return;
    setSaving(true);
    setPercent(null);
    const stop = bridge?.onMp4Progress?.(({ received, total }) => {
      setPercent(total ? Math.min(100, Math.floor(received * 100 / total)) : null);
    });
    try {
      const saved = active && webContentsId !== undefined ? await bridge?.saveSiteMp4?.(webContentsId, filenameContext)
        : direct && url ? await bridge?.saveMp4?.(url, sourceId, filenameContext) : false;
      if (saved) toast.push({ level: 'success', message: 'MP4 saved.' });
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
