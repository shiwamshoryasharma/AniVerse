import type { EpisodeDownloadContext } from '../../../app/shared/download-filename';
import { Download, LoaderCircle } from 'lucide-react';
import { useId, useState } from 'react';
import { errorText, isAniVerse2 } from '../lib/bridge';
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
  const [maxHeight, setMaxHeight] = useState<number>();
  const [progress, setProgress] = useState<{ received: number; total: number | null } | null>(null);
  const bridge = window.aniverse;
  const direct = !!bridge?.saveMp4 && !!url && /^https:\/\/[^?#]+\.mp4(?:[?#]|$)/i.test(url);
  const active = webContentsId !== undefined && !!bridge?.saveSiteMp4;
  const available = direct || active;
  if (!isAniVerse2 || (!available && !unavailableReason)) return null;

  const progressLabel = progress?.total
    ? Math.min(100, Math.floor(progress.received * 100 / progress.total)) + '%'
    : progress?.received ? (progress.received / (1024 * 1024)).toFixed(1) + ' MiB' : '';
  const format = active ? 'video' : 'MP4';

  const save = async () => {
    if (!available || saving) return;
    setSaving(true);
    setProgress(null);
    const stop = bridge?.onMp4Progress?.(setProgress);
    try {
      const saved = active && webContentsId !== undefined ? await bridge?.saveSiteMp4?.(webContentsId, filenameContext, maxHeight)
        : direct && url ? await bridge?.saveMp4?.(url, sourceId, filenameContext) : false;
      if (saved) toast.push({ level: 'success', message: active ? 'Video saved.' : 'MP4 saved.' });
    } catch (error) {
      toast.push({ level: 'error', message: errorText(error) });
    } finally {
      stop?.();
      setSaving(false);
    }
  };

  return (
    <>
      {active && <select className="input watch-download-quality" aria-label="Streaming download quality"
        value={maxHeight ?? ''} disabled={saving}
        onChange={(event) => setMaxHeight(event.target.value ? Number(event.target.value) : undefined)}>
        <option value="">Current quality</option>
        {[360, 480, 720, 1080, 1440, 2160].map((height) => <option key={height} value={height}>Up to {height}p</option>)}
      </select>}
      <button className="btn" type="button" disabled={saving} aria-disabled={!available || undefined}
        aria-describedby={!available ? hint : undefined} onClick={() => void save()}>
        {saving ? <LoaderCircle size={15} className="spin" aria-hidden /> : <Download size={15} aria-hidden />}
        {saving ? (progressLabel ? `Saving ${format} ${progressLabel}` : `Saving ${format}…`) : `Download ${format}`}
      </button>
      {!available && <small className="watch-media-hint" id={hint}>{unavailableReason}</small>}
    </>
  );
}
