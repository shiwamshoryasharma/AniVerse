import { Clapperboard, FolderOpen, Link2 } from 'lucide-react';
import { useState } from 'react';
import { call, errorText } from '../lib/bridge';
import { detectStreamType } from '../lib/format';
import { useSettings, useUpdateSettings } from '../lib/queries';
import { useToast } from '../lib/useToast';
import { VideoPlayer, type PlayerSource } from '../player/VideoPlayer';

export function PlayerPage() {
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const toast = useToast();
  const [input, setInput] = useState('');
  const [subs, setSubs] = useState('');
  const [current, setCurrent] = useState<{ source: PlayerSource; title: string } | null>(null);

  const playUrl = () => {
    const url = input.trim();
    if (!/^https?:\/\//i.test(url)) {
      toast.push({ level: 'warn', message: 'Enter an http(s) link to an HLS (.m3u8), DASH (.mpd) or MP4/WebM stream.' });
      return;
    }
    const subtitles = /^https?:\/\/.+\.vtt(\?.*)?$/i.test(subs.trim()) ? [{ label: 'Subtitles', lang: 'en', url: subs.trim() }] : [];
    setCurrent({ source: { type: detectStreamType(url), url, subtitles }, title: url.split('/').pop()?.split('?')[0] || url });
  };

  const openFile = async () => {
    try {
      const file = await call('player.openFile');
      if (file) setCurrent({ source: { type: detectStreamType(file.name), url: file.url, subtitles: [] }, title: file.name });
    } catch (err) {
      toast.push({ level: 'error', message: errorText(err) });
    }
  };

  return (
    <div className="page">
      <h1 className="page-title">Player</h1>
      <p className="page-sub">Play a direct HLS, DASH or MP4/WebM stream you have the rights to, or a video file from this computer.</p>
      <div className="card card-pad stack" style={{ marginBottom: 16 }}>
        <div className="row">
          <Link2 size={16} className="faint" />
          <input className="input grow" placeholder="https://example.com/stream/master.m3u8" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && playUrl()} aria-label="Stream URL" />
          <input className="input" style={{ width: 260 }} placeholder="Optional .vtt subtitles URL" value={subs} onChange={(e) => setSubs(e.target.value)} aria-label="Subtitles URL" />
          <button className="btn primary" onClick={playUrl}>
            Play
          </button>
          <button className="btn" onClick={() => void openFile()}>
            <FolderOpen size={15} /> Open file
          </button>
        </div>
        <span className="faint" style={{ fontSize: 'var(--fs-xs)' }}>
          Shortcuts: Space/K play · J/L ±{settings.player.seekStep}s · ←/→ ±5s · ↑/↓ volume · F fullscreen · M mute · S skip {settings.player.skipStep}s · &lt; &gt; speed · 0–9 jump
        </span>
      </div>
      <div className="screen">
        {current ? (
          <VideoPlayer
            key={current.source.url}
            source={current.source}
            title={current.title}
            prefs={settings.player}
            onVolume={(volume) => updateSettings.mutate({ player: { volume } })}
          />
        ) : (
          <div className="state" style={{ height: '100%' }}>
            <Clapperboard size={34} />
            <h3>Nothing playing</h3>
            <p>Paste a stream link above or open a local file.</p>
          </div>
        )}
      </div>
    </div>
  );
}
