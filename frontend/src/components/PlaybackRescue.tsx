import { useState } from 'react';
import type { PlaybackHealth } from '../../../app/shared/playback';
import type { ProbeResult } from '../../../app/shared/types';
import { call, errorText } from '../lib/bridge';
import { clock } from '../lib/format';
import { useToast } from '../lib/useToast';

const labels: Record<PlaybackHealth['state'], string> = {
  playing: 'Playing', paused: 'Paused', buffering: 'Buffering', stalled: 'Video stalled', stuttering: 'Frames are dropping', ended: 'Episode ended',
};

/** Diagnose the original player without cloning video or separating its audio/subtitle clock. */
export function PlaybackRescue({ probe, health, webContentsId, busy }: { probe: ProbeResult | null; health: PlaybackHealth | null; webContentsId: number; busy: boolean }) {
  const [recovering, setRecovering] = useState(false);
  const toast = useToast();

  const recover = async () => {
    setRecovering(true);
    try {
      const recovered = await call('player.control', { webContentsId, action: 'resync' });
      if (!recovered) throw new Error('No controllable video is ready. Start the episode or choose another server.');
      toast.push({ level: 'info', message: 'Playback recovery requested at the current position.' });
    } catch (error) { toast.push({ level: 'error', message: errorText(error) }); }
    finally { setRecovering(false); }
  };
  return (
    <section className="card playback-rescue" aria-label="Playback Rescue">
      <div><b>Playback Rescue</b><span role="status">{busy ? 'Switching player…' : health ? labels[health.state] : 'Waiting for video'}</span></div>
      {probe?.video && <p className="faint">
        {probe.video.width} × {probe.video.height} · {probe.video.bufferedAhead.toFixed(1)}s buffered
        {health?.fps !== null && health?.fps !== undefined ? ' · ' + health.fps.toFixed(1) + ' fps' : ''}
        {health?.dropPercent !== null && health?.dropPercent !== undefined ? ' · ' + health.dropPercent.toFixed(1) + '% dropped' : ''}
      </p>}
      <div className="row">
        <button className="btn sm" onClick={() => void recover()} disabled={busy || recovering || !probe || probe.ended}>
          {recovering ? 'Recovering…' : 'Recover' + (probe ? ' at ' + clock(probe.currentTime) : '')}
        </button>
        <a className="btn ghost sm" href="#/settings/graphics">GPU & clarity</a>
      </div>
      <p className="faint">Keeps the source player, audio and subtitles on one timeline. These counters detect video stalls; they cannot measure lip-sync. If recovery fails, try another SUB/DUB server.</p>
    </section>
  );
}
