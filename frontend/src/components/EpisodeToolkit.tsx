import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookmarkPlus, Flag, Scissors, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { MediaSnapshot, ProbeResult } from '../../../app/shared/types';
import { canAutoSkip } from '../../../app/shared/workspace';
import type { PlayerControls } from '../player/VideoPlayer';
import { call, errorText } from '../lib/bridge';
import { clock } from '../lib/format';
import { useSettings } from '../lib/queries';
import { useToast } from '../lib/useToast';

interface Point {
  position: number;
  duration: number;
  paused: boolean;
  totalFrames: number | null;
  droppedFrames: number | null;
}
export function EpisodeToolkit({
  media,
  episode,
  sourceId,
  webContentsId,
  native,
  initialTime,
  probe,
}: {
  media: MediaSnapshot;
  episode: number;
  sourceId: string | null;
  webContentsId: number | null;
  native: RefObject<PlayerControls | null>;
  initialTime: number | null;
  probe: ProbeResult | null;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useSettings();
  const [sessionId] = useState(() => crypto.randomUUID());
  const [point, setPoint] = useState<Point | null>(null);
  const [note, setNote] = useState('');
  const [tags, setTags] = useState('');
  const [kind, setKind] = useState<'intro' | 'outro'>('intro');
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(90);
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const seeked = useRef(false);
  const skipped = useRef(new Set<string>());
  const bookmarks = useQuery({ queryKey: ['bookmarks', media.id], queryFn: () => call('toolkit.bookmarks', { mediaId: media.id }) });
  const skips = useQuery({ queryKey: ['skips', media.id], queryFn: () => call('toolkit.skips', { mediaId: media.id }) });
  const latest = useRef({ ranges: skips.data ?? [], recording: settings.privacy.watchInsights });
  useEffect(() => {
    latest.current = { ranges: skips.data ?? [], recording: settings.privacy.watchInsights };
  }, [skips.data, settings.privacy.watchInsights]);
  const seek = async (position: number) => {
    if (webContentsId) {
      if (!(await call('player.control', { webContentsId, action: 'seek', value: position }))) throw new Error('This website player did not accept the seek.');
    } else if (native.current) native.current.seekTo(position);
    else throw new Error('Start playback first.');
  };
  const seekRef = useRef(seek);
  useEffect(() => {
    seekRef.current = seek;
  });
  useEffect(() => {
    let disposed = false,
      pending = false;
    const sample = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const p: Point | null = webContentsId
          ? probe && probe.duration > 0
            ? {
                position: probe.currentTime,
                duration: probe.duration,
                paused: probe.paused,
                totalFrames: probe.video?.totalFrames ?? null,
                droppedFrames: probe.video?.droppedFrames ?? null,
              }
            : null
          : (native.current?.state() ?? null);
        if (disposed) return;
        setPoint(p);
        if (!p || !Number.isFinite(p.duration) || p.duration <= 0) return;
        if (!seeked.current && initialTime !== null) {
          seeked.current = true;
          await seekRef.current(Math.min(initialTime, p.duration - 1));
          return;
        }
        if (latest.current.recording) await call('toolkit.record', { sessionId, mediaId: media.id, episode, sourceId, ...p });
        if (disposed) return;
        for (const r of latest.current.ranges) {
          const id = r.kind + ':' + r.start + ':' + r.end;
          if (r.enabled && !p.paused && canAutoSkip(r, p.duration, sourceId) && p.position >= r.start && p.position < r.end && !skipped.current.has(id)) {
            skipped.current.add(id);
            await seekRef.current(r.end);
          }
        }
      } catch {
        /* Website media may disappear during navigation; the next sample retries. */
      } finally {
        pending = false;
      }
    };
    void sample();
    // Website samples already arrive from Watch's probe loop. Only poll native controls here.
    const timer = webContentsId ? null : window.setInterval(() => void sample(), 3000);
    return () => {
      disposed = true;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [episode, initialTime, media.id, native, probe, sessionId, sourceId, webContentsId]);
  const bookmark = async () => {
    if (busy) return;
    if (!point) {
      toast.push({ level: 'info', message: 'Start a video before saving a scene.' });
      return;
    }
    setBusy(true);
    try {
      const current = webContentsId ? await call('player.probe', { webContentsId }) : null;
      const at = webContentsId ? current && { position: current.currentTime, duration: current.duration } : native.current?.state();
      if (!at || !Number.isFinite(at.duration) || at.duration <= 0) throw new Error('The video is no longer available.');
      await call('toolkit.saveBookmark', {
        media,
        episode,
        position: at.position,
        duration: at.duration,
        sourceId,
        note,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 8),
      });
      await qc.invalidateQueries({ queryKey: ['bookmarks'] });
      setNote('');
      setTags('');
      toast.push({ level: 'success', message: 'Scene saved to your local bookmarks.' });
    } catch (e) {
      toast.push({ level: 'error', message: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const addRef = useRef(bookmark);
  useEffect(() => {
    addRef.current = bookmark;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key.toLowerCase() !== 'b' ||
        e.repeat ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        (e.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]')
      )
        return;
      e.preventDefault();
      void addRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const perform = async (fn: () => Promise<unknown>, key: string) => {
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: [key] });
    } catch (e) {
      toast.push({ level: 'error', message: errorText(e) });
    }
  };
  const episodeBookmarks = (bookmarks.data ?? []).filter((b) => b.episode === episode);
  return (
    <section className="card card-pad episode-toolkit" aria-label="Episode Toolkit">
      <div className="row wrap between">
        <h3>
          <Flag size={18} /> Episode Toolkit
        </h3>
        <span className="faint">{point ? clock(point.position) + ' / ' + clock(point.duration) : 'Waiting for video'} · B to bookmark</span>
      </div>
      <p className="faint">Your scene notes and skip map stay on this device. Website controls depend on the player allowing access.</p>
      <div className="toolkit-timeline" aria-label="Scene timeline">
        {(skips.data ?? []).map((r) => (
          <span
            key={r.kind}
            className={'skip-segment ' + r.kind}
            title={r.kind + ' ' + clock(r.start) + '–' + clock(r.end)}
            style={{
              left: (100 * r.start) / (point?.duration || r.duration || 1) + '%',
              width: (100 * (r.end - r.start)) / (point?.duration || r.duration || 1) + '%',
            }}
          />
        ))}
        {episodeBookmarks.map((b) => (
          <button
            key={b.id}
            className="scene-marker"
            aria-label={'Scene at ' + clock(b.position)}
            title={b.note || clock(b.position)}
            style={{ left: Math.min(99, (100 * b.position) / (point?.duration || b.duration || 1)) + '%' }}
            onClick={() => void perform(() => seek(b.position), 'unused')}
          />
        ))}
      </div>
      <div className="workspace-form">
        <input
          className="input"
          value={note}
          maxLength={1000}
          onChange={(e) => setNote(e.target.value)}
          placeholder="A note about this scene…"
          aria-label="Scene note"
        />
        <input
          className="input"
          value={tags}
          maxLength={240}
          onChange={(e) => setTags(e.target.value)}
          placeholder="Tags, separated by commas"
          aria-label="Scene tags"
        />
        <button className="btn primary" disabled={!point || busy} onClick={() => void bookmark()}>
          <BookmarkPlus size={15} /> Save scene
        </button>
      </div>
      {!!episodeBookmarks.length && (
        <div className="scene-chips">
          {episodeBookmarks.map((b) => (
            <div className="row" key={b.id}>
              <button className="btn ghost sm" onClick={() => void perform(() => seek(b.position), 'unused')}>
                {clock(b.position)} · {b.note || 'Scene'}
              </button>
              <button
                className="icon-btn"
                aria-label="Delete scene"
                onClick={() => void perform(() => call('toolkit.deleteBookmark', { id: b.id }), 'bookmarks')}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <details>
        <summary>
          <Scissors size={15} /> Intro & outro map
        </summary>
        <p className="faint">
          Set ranges for this title. Auto skip only runs on the same source with a similar runtime; check timing when changing editions. Polling can delay a
          skip by up to 3 seconds.
        </p>
        <div className="workspace-form">
          <select className="input" aria-label="Skip kind" value={kind} onChange={(e) => setKind(e.target.value as 'intro' | 'outro')}>
            <option value="intro">Intro</option>
            <option value="outro">Outro</option>
          </select>
          <label>
            Start (s)
            <input className="input" type="number" min="0" value={start} onChange={(e) => setStart(Number(e.target.value))} />
            <button className="btn xs" disabled={!point} onClick={() => setStart(Math.floor(point!.position))}>
              Use current
            </button>
          </label>
          <label>
            End (s)
            <input className="input" type="number" min="1" value={end} onChange={(e) => setEnd(Number(e.target.value))} />
            <button className="btn xs" disabled={!point} onClick={() => setEnd(Math.floor(point!.position))}>
              Use current
            </button>
          </label>
          <label className="row">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            Auto skip
          </label>
          <button
            className="btn"
            disabled={!point || end <= start || end > (point?.duration ?? 0)}
            onClick={() =>
              void perform(() => call('toolkit.saveSkip', { mediaId: media.id, kind, start, end, enabled: auto, sourceId, duration: point!.duration }), 'skips')
            }
          >
            Save range
          </button>
        </div>
        {(skips.data ?? []).map((r) => (
          <div className="row wrap" key={r.kind}>
            <span className="grow">
              {r.kind} · {clock(r.start)}–{clock(r.end)} · {r.enabled ? 'Auto' : 'Manual'}
              {point && !canAutoSkip(r, point.duration, sourceId) ? ' · Different edition: auto skip paused' : ''}
            </span>
            <button className="btn sm" disabled={!point} onClick={() => void perform(() => seek(r.end), 'unused')}>
              Skip now
            </button>
            <button
              className="icon-btn"
              aria-label={'Delete ' + r.kind}
              onClick={() => void perform(() => call('toolkit.deleteSkip', { mediaId: media.id, kind: r.kind }), 'skips')}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </details>
    </section>
  );
}
