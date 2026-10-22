import { useQueryClient } from '@tanstack/react-query';
import { Camera, ImagePlus, Pencil, Trash2 } from 'lucide-react';
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate } from 'react-router';
import { Empty, Modal, Spinner } from '../components/common';
import { Range } from '../components/controls';
import { call, errorText } from '../lib/bridge';
import { timeAgo } from '../lib/format';
import { keys, useAccounts, useContinue, useEntries, useFavourites, useHistory, useSettings, useUpdateSettings } from '../lib/queries';
import { useToast } from '../lib/useToast';

type Kind = 'avatar' | 'banner';

const OUTPUT: Record<Kind, { w: number; h: number }> = { avatar: { w: 480, h: 480 }, banner: { w: 1800, h: 540 } };
const FRAME: Record<Kind, { w: number; h: number }> = { avatar: { w: 300, h: 300 }, banner: { w: 480, h: 144 } };

export function ProfilePage() {
  const settings = useSettings();
  const profile = settings.profile;
  const update = useUpdateSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { data: accounts } = useAccounts();
  const { data: history } = useHistory();
  const { data: favourites } = useFavourites();
  const { data: entries } = useEntries(null);
  const { data: cont } = useContinue();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pickKind, setPickKind] = useState<Kind>('avatar');
  const [crop, setCrop] = useState<{ kind: Kind; src: string } | null>(null);
  const [editing, setEditing] = useState(false);

  const watchedEpisodes = (history ?? []).filter((h) => h.duration > 0 && h.position / h.duration >= settings.player.completeThreshold).length;
  const hours = (history ?? []).reduce((sum, h) => sum + Math.min(h.position, h.duration || h.position), 0) / 3600;
  const completed = (entries ?? []).filter((e) => e.status === 'COMPLETED').length;
  const watching = (entries ?? []).filter((e) => e.status === 'CURRENT' || e.status === 'REPEATING').length;
  const connected = (accounts ?? []).filter((a) => a.connected);

  const choose = (kind: Kind) => {
    setPickKind(kind);
    fileInput.current?.click();
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.push({ level: 'warn', message: 'Choose an image file (PNG, JPEG, WebP, GIF or AVIF).' });
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      toast.push({ level: 'warn', message: 'That image is larger than 25 MB.' });
      return;
    }
    setCrop({ kind: pickKind, src: URL.createObjectURL(file) });
  };

  const save = async (kind: Kind, dataUrl: string | null) => {
    try {
      const next = dataUrl ? await call('profile.setImage', { kind, dataUrl }) : await call('profile.clearImage', { kind });
      qc.setQueryData(keys.settings, next);
      toast.push({ level: 'success', message: dataUrl ? `${kind === 'avatar' ? 'Profile photo' : 'Banner'} updated.` : `${kind === 'avatar' ? 'Profile photo' : 'Banner'} removed.` });
    } catch (err) {
      toast.push({ level: 'error', message: errorText(err) });
    }
  };

  return (
    <div className="page">
      <section className="profile-hero" style={profile.banner ? { backgroundImage: `url("${profile.banner}")` } : undefined}>
        <div className="edit-banner">
          <button className="btn sm" onClick={() => choose('banner')}>
            <ImagePlus size={14} /> {profile.banner ? 'Change banner' : 'Add banner'}
          </button>
          {profile.banner && (
            <button className="btn sm" onClick={() => void save('banner', null)} aria-label="Remove banner">
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </section>

      <div className="profile-head">
        <div className="profile-avatar">
          <span className="avatar">{profile.avatar ? <img src={profile.avatar} alt="" /> : profile.name[0]?.toUpperCase()}</span>
          <button className="cam" onClick={() => choose('avatar')} aria-label="Change profile photo" title="Change profile photo">
            <Camera size={16} />
          </button>
        </div>
        <div className="grow" style={{ paddingBottom: 10 }}>
          {editing ? (
            <ProfileEditor
              name={profile.name}
              bio={profile.bio}
              onCancel={() => setEditing(false)}
              onSave={(name, bio) =>
                update.mutate(
                  { profile: { name, bio } },
                  {
                    onSuccess: () => setEditing(false),
                    onError: (e) => toast.push({ level: 'error', message: e.message }),
                  },
                )
              }
            />
          ) : (
            <>
              <h1 className="profile-name selectable">{profile.name}</h1>
              <p className="muted selectable" style={{ margin: '4px 0 0', maxWidth: 640, whiteSpace: 'pre-line' }}>
                {profile.bio || 'Add a short bio — what you watch, your favourite studio, anything.'}
              </p>
              <div className="row wrap" style={{ marginTop: 10 }}>
                {connected.length ? (
                  connected.map((a) => (
                    <span key={a.provider} className="chip ok">
                      {a.provider === 'mal' ? 'MyAnimeList' : 'AniList'} · {a.userName}
                    </span>
                  ))
                ) : (
                  <button className="chip" onClick={() => navigate('/settings/accounts')}>
                    Connect AniList / MyAnimeList
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        {!editing && (
          <button className="btn" style={{ marginBottom: 12 }} onClick={() => setEditing(true)}>
            <Pencil size={14} /> Edit profile
          </button>
        )}
        {profile.avatar && !editing && (
          <button className="btn ghost" style={{ marginBottom: 12 }} onClick={() => void save('avatar', null)}>
            <Trash2 size={14} /> Remove photo
          </button>
        )}
      </div>

      <section className="section">
        <div className="stat-grid">
          <Stat value={watchedEpisodes} label="Episodes watched" />
          <Stat value={hours < 10 ? hours.toFixed(1) : Math.round(hours)} label="Hours watched" />
          <Stat value={watching} label="Watching" />
          <Stat value={completed} label="Completed" />
          <Stat value={favourites?.length ?? 0} label="Favourites" />
          <Stat value={(entries ?? []).length} label="Titles in library" />
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Continue watching</h2>
        </div>
        {cont?.length ? (
          <div className="card">
            {cont.slice(0, 6).map((c) => (
              <div key={c.media.id} className="list-row" role="link" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => navigate(`/watch/${c.media.id}/${c.episode}${c.sourceId ? `?source=${c.sourceId}` : ''}`)}>
                {c.media.cover ? <img src={c.media.cover} alt="" /> : <div className="skeleton" style={{ width: 46, height: 64 }} />}
                <div style={{ minWidth: 0 }}>
                  <div className="ellipsis" style={{ fontWeight: 650 }}>
                    {c.media.title}
                  </div>
                  <div className="faint" style={{ fontSize: 'var(--fs-sm)' }}>
                    Episode {c.episode} · {timeAgo(c.updatedAt)}
                  </div>
                </div>
                <span className="chip accent">Resume</span>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="Nothing in progress">Start an episode and it shows up here.</Empty>
        )}
      </section>

      {!!favourites?.length && (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Favourites</h2>
          </div>
          <div className="grid dense">
            {favourites.slice(0, 18).map((f) => (
              <div key={f.media.id} className="mcard" role="link" tabIndex={0} onClick={() => navigate(`/anime/${f.media.id}`)}>
                <div className="mcard-poster">{f.media.cover && <img src={f.media.cover} alt="" loading="lazy" />}</div>
                <div className="mcard-title">
                  <span className="clamp-2">{f.media.title}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
        className="sr-only"
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {crop && (
        <CropDialog
          kind={crop.kind}
          src={crop.src}
          onCancel={() => {
            URL.revokeObjectURL(crop.src);
            setCrop(null);
          }}
          onDone={async (dataUrl) => {
            await save(crop.kind, dataUrl);
            URL.revokeObjectURL(crop.src);
            setCrop(null);
          }}
        />
      )}
    </div>
  );
}

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="card stat">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

function ProfileEditor({ name, bio, onSave, onCancel }: { name: string; bio: string; onSave: (name: string, bio: string) => void; onCancel: () => void }) {
  const [n, setN] = useState(name);
  const [b, setB] = useState(bio);
  return (
    <div className="stack" style={{ gap: 8, maxWidth: 560 }}>
      <input className="input" value={n} maxLength={40} onChange={(e) => setN(e.target.value)} aria-label="Display name" placeholder="Display name" style={{ fontSize: 18, fontWeight: 700, height: 40 }} />
      <textarea className="textarea" value={b} maxLength={280} onChange={(e) => setB(e.target.value)} aria-label="Bio" placeholder="A short bio" />
      <div className="row">
        <button className="btn primary sm" disabled={!n.trim()} onClick={() => onSave(n.trim(), b.trim())}>
          Save
        </button>
        <button className="btn ghost sm" onClick={onCancel}>
          Cancel
        </button>
        <span className="faint" style={{ marginLeft: 'auto', fontSize: 'var(--fs-xs)' }}>
          {b.length}/280
        </span>
      </div>
    </div>
  );
}

/** Drag to position, slide to zoom; renders the crop on a canvas at a fixed output size. */
function CropDialog({ kind, src, onCancel, onDone }: { kind: Kind; src: string; onCancel: () => void; onDone: (dataUrl: string) => Promise<void> }) {
  const frame = FRAME[kind];
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const img = useRef<HTMLImageElement>(null);

  // Scale so the image always covers the frame at zoom 1.
  const base = natural ? Math.max(frame.w / natural.w, frame.h / natural.h) : 1;
  const scale = base * zoom;
  const limit = (o: { x: number; y: number }) => {
    if (!natural) return o;
    const maxX = Math.max(0, (natural.w * scale - frame.w) / 2);
    const maxY = Math.max(0, (natural.h * scale - frame.h) / 2);
    return { x: Math.max(-maxX, Math.min(maxX, o.x)), y: Math.max(-maxY, Math.min(maxY, o.y)) };
  };
  const shown = limit(offset);

  const onDown = (e: ReactPointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: shown.x, oy: shown.y };
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!drag.current) return;
    setOffset(limit({ x: drag.current.ox + e.clientX - drag.current.x, y: drag.current.oy + e.clientY - drag.current.y }));
  };

  const apply = async () => {
    if (!natural || !img.current) return;
    setBusy(true);
    const out = OUTPUT[kind];
    const canvas = document.createElement('canvas');
    canvas.width = out.w;
    canvas.height = out.h;
    const ctx = canvas.getContext('2d')!;
    // Source rectangle (in image pixels) currently visible in the frame.
    const sw = frame.w / scale;
    const sh = frame.h / scale;
    const sx = natural.w / 2 - shown.x / scale - sw / 2;
    const sy = natural.h / 2 - shown.y / scale - sh / 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img.current, sx, sy, sw, sh, 0, 0, out.w, out.h);
    await onDone(canvas.toDataURL('image/webp', 0.9));
    setBusy(false);
  };

  return (
    <Modal
      title={kind === 'avatar' ? 'Position your photo' : 'Position your banner'}
      onClose={onCancel}
      actions={
        <>
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={!natural || busy} onClick={() => void apply()}>
            {busy ? <Spinner size="sm" /> : null} Save
          </button>
        </>
      }
    >
      <div
        className={kind === 'avatar' ? 'crop-frame round' : 'crop-frame'}
        style={{ width: frame.w, height: frame.h, maxWidth: '100%' }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => (drag.current = null)}
        onWheel={(e) => setZoom((z) => Math.max(1, Math.min(4, z - e.deltaY * 0.0015)))}
      >
        <img
          ref={img}
          src={src}
          alt=""
          draggable={false}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          style={natural ? { width: natural.w * scale, height: natural.h * scale, transform: `translate(calc(-50% + ${shown.x}px), calc(-50% + ${shown.y}px))` } : { opacity: 0 }}
        />
      </div>
      <div className="row">
        <span className="faint" style={{ fontSize: 'var(--fs-sm)' }}>
          Zoom
        </span>
        <div className="grow">
          <Range value={zoom} min={1} max={4} step={0.01} onChange={setZoom} ariaLabel="Zoom" width="100%" />
        </div>
      </div>
      <span className="faint" style={{ fontSize: 'var(--fs-xs)' }}>
        Drag to reposition. The image is processed on this computer and saved in your AniVerse profile folder.
      </span>
    </Modal>
  );
}
