import { X, Cast, Pause, Play, RotateCcw, RotateCw, ScreenShareOff, Tv } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CastDevice, CastState } from '../../../app/shared/types';
import { ChromeCastPicker } from '../components/ChromeCastPicker';
import { WirelessDisplay } from '../components/WirelessDisplay';
import { Switch } from '../components/common';
import { Range } from '../components/controls';
import { call, errorText } from '../lib/bridge';
import { isCasting } from './useCastState';
import { clock, cx } from '../lib/format';

/** Device picker shown from the player's Cast button. */
export function CastMenu({ state, onPick, onStop, onClose, canUpscale }: { canUpscale: boolean; state: CastState; onPick: (d: CastDevice, upscale4k: boolean) => void; onStop: () => void; onClose: () => void }) {
  const [upscale4k, setUpscale4k] = useState(false);
  const [capability, setCapability] = useState<{ available: boolean; version: string | null; message: string } | null>(null);
  useEffect(() => { void call('cast.capabilities').then(setCapability).catch(() => undefined); }, []);
  const [devices, setDevices] = useState<CastDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    call('cast.devices')
      .then(setDevices)
      .catch((e) => {
        setDevices([]);
        setError(errorText(e));
      });
  const scan = () => {
    setDevices(null);
    setError(null);
    void load();
  };
  useEffect(() => {
    void load();
    // Scan once when the picker opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="player-menu cast-menu">
      <div className="row between"><h5>Cast to TV</h5><button className="icon-btn" aria-label="Close TV chooser" onClick={onClose}><X size={16}/></button></div>
      {state.status === 'error' && state.error && <p className="err" role="alert">{state.error}</p>}
      <ChromeCastPicker onPick={(device) => onPick(device, upscale4k)} />
      <h5 className="cast-protocol-heading">Direct Google Cast</h5>
      <div className="cast-4k-choice"><label className="row"><Switch label="Process 4K on this device" on={upscale4k} onChange={(on) => setUpscale4k(on && canUpscale && !!capability?.available)} />4K · process on this device</label><p>{canUpscale ? (capability?.message ?? 'Checking embedded encoder…') : '4K sender processing is available for opened local videos.'}</p><p>Requires a 4K HEVC-capable Google Cast TV/receiver, Vulkan GPU and sufficient LAN bandwidth. No system FFmpeg needed.</p></div>
      {isCasting(state) && (
        <button className="on" onClick={onStop}>
          <span className="row" style={{ gap: 8 }}>
            <ScreenShareOff size={14} /> Stop casting to {state.device?.name}
          </span>
        </button>
      )}
      {devices === null ? (
        <div className="row faint" style={{ padding: '8px 10px', gap: 8 }}>
          <span className="spinner sm" /> Looking for Cast devices…
        </div>
      ) : devices.length === 0 ? (
        <div className="faint" style={{ padding: '6px 10px 8px', fontSize: 'var(--fs-sm)', maxWidth: 240 }}>
          {error ?? 'No direct receiver found. Try “Find TVs with Chrome” above.'}
        </div>
      ) : (
        devices.map((d) => (
          <button key={d.id} className={cx(state.device?.id === d.id && 'on')} onClick={() => onPick(d, upscale4k)}>
            <span className="row" style={{ gap: 8, minWidth: 0 }}>
              <Tv size={14} />
              <span className="ellipsis">{d.name}</span>
            </span>
            <span className="faint" style={{ fontSize: 'var(--fs-xs)' }}>
              {d.model}
            </span>
          </button>
        ))
      )}
      <button onClick={scan}>
        <span className="row" style={{ gap: 8 }}>
          <RotateCw size={13} /> Scan again
        </span>
      </button>
      <details className="cast-windows-option"><summary>Windows wireless display · Miracast</summary><WirelessDisplay /></details>
    </div>
  );
}

/** Remote control shown over the player while the TV plays the media. */
export function CastOverlay({ state, poster, onStop }: { state: CastState; poster?: string; onStop: () => void }) {
  const control = (action: 'play' | 'pause' | 'seek' | 'volume', value?: number) => void call('cast.control', { action, value }).catch(() => undefined);
  const playing = state.status === 'playing' || state.status === 'buffering';
  const pct = state.duration ? Math.min(100, (state.currentTime / state.duration) * 100) : 0;
  return (
    <div className="cast-overlay" style={poster ? { backgroundImage: `linear-gradient(rgba(7,8,11,.82), rgba(7,8,11,.92)), url("${poster}")` } : undefined}>
      <div className="cast-badge">
        <Cast size={16} /> {state.transport === 'chrome' ? 'Casting with Chrome to' : 'Casting to'} <b>{state.device?.name}</b>
      </div>
      {state.processing && <div className="cast-badge">Anime4K {state.processing.width} × {state.processing.height} · computed on sender · {state.processing.encoder}{state.transport === 'chrome' ? ' · TV output negotiated by Chrome' : ''}</div>}
      <div className="cast-title ellipsis">{state.title}</div>
      <div className="faint" style={{ fontSize: 'var(--fs-sm)' }}>
        {state.status === 'connecting' ? 'Connecting…' : state.status === 'buffering' ? 'Buffering on the TV…' : state.status === 'ended' ? 'Finished' : state.status === 'paused' ? 'Paused' : 'Playing on the TV'}
      </div>
      <div className="row" style={{ gap: 14, marginTop: 6 }}>
        <button className="icon-btn bordered" aria-label="Back 10 seconds" onClick={() => control('seek', state.currentTime - 10)}>
          <RotateCcw size={16} />
        </button>
        <button className="player-bigplay" style={{ width: 58, height: 58 }} aria-label={playing ? 'Pause on TV' : 'Play on TV'} onClick={() => control(playing ? 'pause' : 'play')}>
          {playing ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
        </button>
        <button className="icon-btn bordered" aria-label="Forward 10 seconds" onClick={() => control('seek', state.currentTime + 10)}>
          <RotateCw size={16} />
        </button>
      </div>
      <div
        className="seek"
        style={{ width: 'min(560px, 80%)' }}
        role="slider"
        aria-label="Seek on TV"
        aria-valuenow={Math.round(state.currentTime)}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          if (state.duration) control('seek', ((e.clientX - r.left) / r.width) * state.duration);
        }}
      >
        <div className="seek-track">
          <div className="seek-played" style={{ width: `${pct}%` }} />
          <div className="seek-thumb" style={{ left: `${pct}%`, transform: 'scale(1)' }} />
        </div>
      </div>
      <div className="row" style={{ gap: 16 }}>
        <span className="player-time">
          {clock(state.currentTime)} / {clock(state.duration)}
        </span>
        <span className="row" style={{ gap: 6 }}>
          <span className="faint" style={{ fontSize: 'var(--fs-xs)' }}>
            TV volume
          </span>
          <Range value={state.volume} onChange={(v) => control('volume', v)} ariaLabel="TV volume" width={110} />
        </span>
        <button className="btn sm" onClick={onStop}>
          <ScreenShareOff size={14} /> Stop casting
        </button>
      </div>
    </div>
  );
}
