import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Download, Info, KeyRound, LogOut, Palette, Play, RefreshCw, RotateCw, Search, Shield, UserRound, Globe, Link2, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { AccentName, AccountInfo, DeepPartial, Provider, Settings, SourceInfo } from '../../../app/shared/types';
import { SourceIcon, Spinner, Switch } from '../components/common';
import { Disclaimer } from '../components/Disclaimer';
import { updateSummary, useInstallUpdate } from '../lib/updates';
import { RadioGroup, Select } from '../components/controls';
import { call, errorText } from '../lib/bridge';
import { cx, timeAgo } from '../lib/format';
import { keys, useAccounts, useAdblockStats, useAppInfo, useSettings, useSources, useUpdateSettings, useUpdateSource, useUpdateState } from '../lib/queries';
import { useToast } from '../lib/useToast';

const SECTIONS = [
  { id: 'general', label: 'Profile & appearance', icon: Palette },
  { id: 'player', label: 'Player', icon: Play },
  { id: 'sources', label: 'Sources', icon: Globe },
  { id: 'accounts', label: 'Accounts & sync', icon: UserRound },
  { id: 'privacy', label: 'Privacy & blocking', icon: Shield },
  { id: 'about', label: 'About', icon: Info },
] as const;

const ACCENTS: [AccentName, string, string][] = [
  ['ember', '#ff7a1a', 'Ember'],
  ['aqua', '#2bd4bd', 'Aqua'],
  ['violet', '#8b6cff', 'Violet'],
  ['sakura', '#ff6fae', 'Sakura'],
  ['crimson', '#ff4d5e', 'Crimson'],
];

export function SettingsPage() {
  const section = useParams().section ?? 'general';
  const navigate = useNavigate();
  return (
    <div className="page">
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">Changes save instantly.</p>
      <div className="settings">
        <nav className="card settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button key={s.id} className={cx(section === s.id && 'active')} onClick={() => navigate(`/settings/${s.id}`, { replace: true })}>
              <s.icon size={16} /> {s.label}
            </button>
          ))}
        </nav>
        <div style={{ minWidth: 0 }}>
          {section === 'general' && <GeneralSection />}
          {section === 'player' && <PlayerSection />}
          {section === 'sources' && <SourcesSection />}
          {section === 'accounts' && <AccountsSection />}
          {section === 'privacy' && <PrivacySection />}
          {section === 'about' && <AboutSection />}
        </div>
      </div>
    </div>
  );
}

function useSave() {
  const update = useUpdateSettings();
  const toast = useToast();
  return (patch: DeepPartial<Settings>) => update.mutate(patch, { onError: (e) => toast.push({ level: 'error', message: e.message }) });
}

function Setting({ title, desc, children }: { title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting">
      <div>
        <h4>{title}</h4>
        {desc && <p>{desc}</p>}
      </div>
      <div className="row">{children}</div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-group">
      <h3>{title}</h3>
      <div className="card">{children}</div>
    </section>
  );
}

/** Text input that commits on blur/Enter instead of on every keystroke (remounts when the saved value changes). */
function TextSetting({ value, onCommit, placeholder, type = 'text', width }: { value: string; onCommit: (v: string) => void; placeholder?: string; type?: string; width?: number }) {
  return (
    <input
      key={value}
      className="input"
      type={type}
      style={width ? { width } : undefined}
      defaultValue={value}
      placeholder={placeholder}
      spellCheck={false}
      onBlur={(e) => e.target.value !== value && onCommit(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

function GeneralSection() {
  const s = useSettings();
  const save = useSave();
  const navigate = useNavigate();
  return (
    <>
      <Group title="Profile">
        <Setting title="Display name" desc="Your single AniVerse profile. Website logins stay isolated per site.">
          <TextSetting value={s.profile.name} onCommit={(name) => save({ profile: { name } })} width={220} />
        </Setting>
        <Setting title="Photo, banner and bio" desc="Upload a profile picture and a banner, and write a short bio.">
          <button className="btn sm" onClick={() => navigate('/profile')}>
            Edit profile
          </button>
        </Setting>
      </Group>
      <Group title="Appearance">
        <Setting title="Accent colour">
          {ACCENTS.map(([name, color, label]) => (
            <button key={name} className={cx('accent-swatch', s.appearance.accent === name && 'on')} style={{ background: color }} title={label} aria-label={label} onClick={() => save({ appearance: { accent: name } })} />
          ))}
        </Setting>
        <Setting title="Density" desc="Compact fits more on screen; comfortable uses larger type and spacing.">
          <RadioGroup
            name="Density"
            value={s.appearance.density}
            onChange={(density) => save({ appearance: { density } })}
            options={[
              { value: 'compact', label: 'Compact' },
              { value: 'comfortable', label: 'Comfortable' },
            ]}
          />
        </Setting>
        <Setting title="Title language" desc="Used across the app and as the first search term on websites.">
          <RadioGroup
            name="Title language"
            value={s.appearance.titleLanguage}
            onChange={(titleLanguage) => save({ appearance: { titleLanguage } })}
            options={[
              { value: 'english', label: 'English' },
              { value: 'romaji', label: 'Romaji' },
              { value: 'native', label: 'Native' },
            ]}
          />
        </Setting>
        <Setting title="Reduce motion" desc="Turns off carousel transitions and hover animations.">
          <Switch label="Reduce motion" on={s.appearance.reduceMotion} onChange={(v) => save({ appearance: { reduceMotion: v } })} />
        </Setting>
        <Setting title="Show adult titles" desc="Include 18+ entries from AniList in browse and search.">
          <Switch label="Show adult titles" on={s.appearance.showAdult} onChange={(v) => save({ appearance: { showAdult: v } })} />
        </Setting>
      </Group>
    </>
  );
}

const numberOptions = (values: number[], label: (v: number) => string) => values.map((v) => ({ value: v, label: label(v) }));

function PlayerSection() {
  const s = useSettings().player;
  const save = useSave();
  return (
    <Group title="Playback">
      <Setting title="Autoplay" desc="Start playing as soon as a stream loads.">
        <Switch label="Autoplay" on={s.autoplay} onChange={(v) => save({ player: { autoplay: v } })} />
      </Setting>
      <Setting title="Auto next" desc="Continue with the next episode when one ends.">
        <Switch label="Auto next" on={s.autoNext} onChange={(v) => save({ player: { autoNext: v } })} />
      </Setting>
      <Setting title="Resume where you left off">
        <Switch label="Resume" on={s.resume} onChange={(v) => save({ player: { resume: v } })} />
      </Setting>
      <Setting title="Theater mode by default">
        <Switch label="Theater" on={s.theater} onChange={(v) => save({ player: { theater: v } })} />
      </Setting>
      <Setting title="Player only on websites" desc="After opening an episode on a website, show just its player instead of the whole page (toggle any time from the watch toolbar).">
        <Switch label="Player only" on={s.siteFocus} onChange={(v) => save({ player: { siteFocus: v } })} />
      </Setting>
      <Setting title="Preferred quality" desc="For HLS/DASH streams with several renditions.">
        <Select<Settings['player']['preferredQuality']>
          ariaLabel="Preferred quality"
          width={160}
          value={s.preferredQuality}
          onChange={(preferredQuality) => save({ player: { preferredQuality } })}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: '1080', label: '1080p' },
            { value: '720', label: '720p' },
            { value: '480', label: '480p' },
          ]}
        />
      </Setting>
      <Setting title="Default speed">
        <Select<number> ariaLabel="Default speed" width={160} value={s.speed} onChange={(speed) => save({ player: { speed } })} options={numberOptions([0.75, 1, 1.25, 1.5, 1.75, 2], (v) => (v === 1 ? 'Normal' : `${v}×`))} />
      </Setting>
      <Setting title="Seek step" desc="J / L and the rewind/forward buttons.">
        <Select<number> ariaLabel="Seek step" width={160} value={s.seekStep} onChange={(seekStep) => save({ player: { seekStep } })} options={numberOptions([5, 10, 15, 30], (v) => `${v} seconds`)} />
      </Setting>
      <Setting title="Skip opening length" desc="The Skip button jumps forward this far (S key).">
        <Select<number> ariaLabel="Skip opening length" width={160} value={s.skipStep} onChange={(skipStep) => save({ player: { skipStep } })} options={numberOptions([60, 75, 85, 90, 120], (v) => `${v} seconds`)} />
      </Setting>
      <Setting title="Count an episode as watched at" desc="Progress past this point marks the episode watched and syncs your list.">
        <Select<number>
          ariaLabel="Completion threshold"
          width={160}
          value={s.completeThreshold}
          onChange={(completeThreshold) => save({ player: { completeThreshold } })}
          options={numberOptions([0.7, 0.8, 0.85, 0.9, 0.95], (v) => `${Math.round(v * 100)}%`)}
        />
      </Setting>
    </Group>
  );
}

function SourcesSection() {
  const { data: sources } = useSources();
  const update = useUpdateSource();
  const toast = useToast();
  const info = useAppInfo().data;
  const qc = useQueryClient();
  const sorted = sources ?? [];

  const patch = (s: SourceInfo, p: Parameters<typeof update.mutate>[0]['patch']) =>
    update.mutate({ id: s.id, patch: p }, { onError: (e) => toast.push({ level: 'error', message: e.message }) });

  const move = (index: number, dir: -1 | 1) => {
    const a = sorted[index];
    const b = sorted[index + dir];
    if (!a || !b) return;
    patch(a, { order: b.order });
    patch(b, { order: a.order });
  };

  const discover = async (s: SourceInfo) => {
    try {
      const res = await call('sources.discover', { id: s.id });
      qc.setQueryData(keys.sources, (old: SourceInfo[] | undefined) => old?.map((x) => (x.id === res.id ? res : x)));
      toast.push({ level: res.searchTemplate ? 'success' : 'warn', message: res.searchTemplate ? `Found search for ${s.name}.` : `${s.name} has no discoverable search — set a search URL manually.` });
    } catch (err) {
      toast.push({ level: 'error', message: errorText(err) });
    }
  };

  return (
    <>
      <Group title="Configuration file">
        <Setting title="streaming-sites.txt" desc={<span className="code">{info?.configPath ?? '…'}</span>}>
          <button className="btn sm" onClick={() => void call('sources.openConfig').catch((e) => toast.push({ level: 'error', message: errorText(e) }))}>
            Open file
          </button>
          <button className="btn sm" onClick={() => void call('sources.reload').then((l) => qc.setQueryData(keys.sources, l))}>
            <RefreshCw size={13} /> Reload
          </button>
        </Setting>
      </Group>
      <Group title={`Sources (${sorted.length})`}>
        {sorted.map((s, i) => (
          <div key={s.id} className="source-row" style={{ alignItems: 'start' }}>
            <SourceIcon source={s} size={18} />
            <div style={{ minWidth: 0 }}>
              <div className="row">
                <strong className="ellipsis">{s.name}</strong>
                <span className={cx('chip', s.kind === 'youtube' ? 'err' : 'accent')}>{s.kind === 'youtube' ? 'Official channel' : 'Website'}</span>
              </div>
              <div className="meta ellipsis">
                {s.url} · line {s.line} · {s.partition.replace('persist:', 'session ')}
              </div>
              {s.kind === 'web' && <SearchTemplateEditor source={s} onSave={(t) => patch(s, { searchTemplate: t })} onDiscover={() => discover(s)} />}
              <div className="row wrap" style={{ marginTop: 8, gap: 16 }}>
                <label className="row" style={{ gap: 6, fontSize: 'var(--fs-sm)' }}>
                  <Switch label="Block ads" on={s.adblock} onChange={(v) => patch(s, { adblock: v })} /> Block ads & popups
                </label>
                <label className="row" style={{ gap: 6, fontSize: 'var(--fs-sm)' }}>
                  <Switch label="Auto Cloudflare" on={s.autoCloudflare} onChange={(v) => patch(s, { autoCloudflare: v })} /> Automatic Cloudflare check
                </label>
              </div>
            </div>
            <div className="row">
              <button className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp size={14} />
              </button>
              <button className="icon-btn" aria-label="Move down" disabled={i === sorted.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown size={14} />
              </button>
              <Switch label="Enabled" on={s.enabled} onChange={(v) => patch(s, { enabled: v })} />
            </div>
          </div>
        ))}
      </Group>
    </>
  );
}

function SearchTemplateEditor({ source, onSave, onDiscover }: { source: SourceInfo; onSave: (t: string | null) => void; onDiscover: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="row" style={{ marginTop: 8 }}>
      <Search size={13} className="faint" />
      <TextSetting value={source.searchTemplateSource === 'user' ? (source.searchTemplate ?? '') : ''} placeholder={source.searchTemplate ?? 'https://site/search?keyword={query}'} onCommit={(v) => onSave(v.trim() || null)} width={360} />
      <span className="faint" style={{ fontSize: 'var(--fs-xs)' }}>
        {source.searchTemplateSource === 'user' ? 'custom' : source.searchTemplateSource ? `auto (${source.searchTemplateSource})` : source.searchCheckedAt ? 'not found' : 'not checked yet'}
      </span>
      <button
        className="btn xs"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onDiscover();
          setBusy(false);
        }}
      >
        {busy ? <Spinner size="sm" /> : 'Detect'}
      </button>
    </div>
  );
}

const PROVIDER_LABEL: Record<Provider, string> = { anilist: 'AniList', mal: 'MyAnimeList' };

function AccountsSection() {
  const s = useSettings().accounts;
  const save = useSave();
  const { data: accounts, refetch } = useAccounts();
  const toast = useToast();
  // What each row is doing right now: waiting for the browser sign-in, or syncing.
  const [busy, setBusy] = useState<Partial<Record<Provider | 'all', 'connect' | 'sync'>>>({});
  const qc = useQueryClient();
  const mark = (key: Provider | 'all', state: 'connect' | 'sync' | null) => setBusy((b) => ({ ...b, [key]: state ?? undefined }));

  const connect = async (provider: Provider) => {
    mark(provider, 'connect');
    try {
      const acc = await call('accounts.connect', { provider });
      toast.push({ level: 'success', message: `Connected ${PROVIDER_LABEL[provider]} as ${acc.userName}. Syncing your list…` });
    } catch (err) {
      const message = errorText(err);
      if (!/cancelled|restarted/i.test(message)) toast.push({ level: 'error', message });
    } finally {
      mark(provider, null);
      void refetch();
    }
  };
  const disconnect = async (provider: Provider) => {
    await call('accounts.disconnect', { provider }).catch((e) => toast.push({ level: 'error', message: errorText(e) }));
    void refetch();
  };
  const syncNow = async (provider: Provider | null) => {
    mark(provider ?? 'all', 'sync');
    try {
      const r = await call('accounts.sync', { provider });
      const parts = [r.pulled && `${r.pulled} updated here`, r.pushed && `${r.pushed} sent`, r.resolved && `${r.resolved} conflict(s) settled (newest edit kept)`].filter(Boolean);
      toast.push({ level: r.errors.length ? 'warn' : 'success', message: r.errors[0] ?? (parts.length ? `Synced: ${parts.join(', ')}.` : 'Everything is already in sync.') });
      void qc.invalidateQueries({ queryKey: ['library'] });
    } catch (err) {
      toast.push({ level: 'error', message: errorText(err) });
    } finally {
      mark(provider ?? 'all', null);
      void refetch();
    }
  };
  const acc = (p: Provider) => accounts?.find((a) => a.provider === p);

  return (
    <>
      <Group title="Connected services">
        {(['anilist', 'mal'] as const).map((p) => (
          <AccountRow
            key={p}
            account={acc(p)}
            name={PROVIDER_LABEL[p]}
            state={busy[p] ?? null}
            onConnect={() => void connect(p)}
            onCancel={() => void call('accounts.cancel', { provider: p })}
            onSync={() => void syncNow(p)}
            onDisconnect={() => void disconnect(p)}
          />
        ))}
      </Group>
      <Group title="Sync">
        <Setting title="Sync automatically" desc="Send watched episodes, list status, scores and favourites as they change (queued while offline, retried later).">
          <Switch label="Auto sync" on={s.autoSync} onChange={(v) => save({ accounts: { autoSync: v } })} />
        </Setting>
        <Setting
          title="Two-way sync"
          desc="Also bring in changes made on AniList or MyAnimeList (on connect, at start-up and every 30 minutes). When a title was edited in both places, the newest edit wins; removals are kept."
        >
          <Switch label="Two-way sync" on={s.twoWay} onChange={(v) => save({ accounts: { twoWay: v } })} />
        </Setting>
        <Setting title="Sync all now" desc={s.twoWay ? 'Fetches your lists, settles differences, then sends pending changes.' : 'Sends pending changes to your connected services.'}>
          <button className="btn sm" disabled={!!busy.all || !accounts?.some((a) => a.connected && !a.needsReconnect)} onClick={() => void syncNow(null)}>
            {busy.all ? <Spinner size="sm" /> : <RefreshCw size={13} />} Sync all now
          </button>
        </Setting>
      </Group>
      <Group title="YouTube (official channels)">
        <Setting title="YouTube Data API key" desc="Optional. Enables full-channel episode search and YouTube comments. Without it, only a channel's latest uploads are listed.">
          <TextSetting value={s.youtubeApiKey} type="password" placeholder="AIza…" onCommit={(v) => save({ accounts: { youtubeApiKey: v.trim() } })} width={300} />
        </Setting>
      </Group>
    </>
  );
}

function AccountRow({
  account,
  name,
  state,
  onConnect,
  onCancel,
  onSync,
  onDisconnect,
}: {
  account?: AccountInfo;
  name: string;
  state: 'connect' | 'sync' | null;
  onConnect: () => void;
  onCancel: () => void;
  onSync: () => void;
  onDisconnect: () => void;
}) {
  if (!account) return null;
  const waiting = state === 'connect' || account.signingIn;
  const title = account.connected ? `${account.userName} · ${name}` : name;
  const detail = waiting
    ? `Finish signing in to ${name} in your browser, then allow AniVerse to open. This page updates by itself.`
    : account.needsReconnect
      ? `Your ${name} session expired or was revoked. Reconnect to resume syncing — ${account.pending ? `${account.pending} change(s) are waiting` : 'nothing is lost'}.`
      : account.connected
        ? [account.lastSyncAt ? `Last sync ${timeAgo(account.lastSyncAt)}` : 'Not synced yet', account.pending ? `${account.pending} pending` : null, account.lastError ? account.lastError : null].filter(Boolean).join(' · ')
        : account.clientIdConfigured
          ? `Sign in on ${name}’s own page in your browser. AniVerse never sees your password.`
          : `${name} sign-in isn’t available in this build (no client ID configured).`;
  return (
    <div className="setting">
      <div className="row">
        <span className="avatar lg">{account.avatar ? <img src={account.avatar} alt="" /> : <KeyRound size={22} />}</span>
        <div>
          <h4>
            {title}
            {account.connected && (
              <span className={cx('chip', account.needsReconnect ? 'err' : 'ok')} style={{ marginLeft: 8 }}>
                {account.needsReconnect ? 'Reconnect needed' : 'Connected'}
              </span>
            )}
          </h4>
          <p>{detail}</p>
        </div>
      </div>
      <div className="row">
        {waiting ? (
          <>
            <span className="row faint" style={{ gap: 6, fontSize: 'var(--fs-sm)' }}>
              <Spinner size="sm" /> Waiting for {name}…
            </span>
            <button className="btn sm" onClick={onCancel}>
              <X size={13} /> Cancel
            </button>
          </>
        ) : account.connected ? (
          <>
            {account.needsReconnect ? (
              <button className="btn primary sm" onClick={onConnect}>
                <Link2 size={13} /> Reconnect
              </button>
            ) : (
              <button className="btn sm" disabled={state === 'sync'} onClick={onSync}>
                {state === 'sync' ? <Spinner size="sm" /> : <RefreshCw size={13} />} Sync now
              </button>
            )}
            <button className="btn sm" onClick={onDisconnect}>
              <LogOut size={13} /> Disconnect
            </button>
          </>
        ) : (
          <button className="btn primary sm" disabled={!account.clientIdConfigured} onClick={onConnect}>
            <Link2 size={13} /> Connect
          </button>
        )}
      </div>
    </div>
  );
}

function PrivacySection() {
  const s = useSettings().privacy;
  const save = useSave();
  const stats = useAdblockStats().data;
  const toast = useToast();
  const blocked = stats ? Object.values(stats.blocked).reduce((a, b) => a + b, 0) : 0;
  const popups = stats ? Object.values(stats.popupsBlocked).reduce((a, b) => a + b, 0) : 0;
  return (
    <>
      <Group title="Blocking">
        <Setting
          title="Block ads, trackers and promotions"
          desc={
            stats
              ? `${stats.ready ? `${blocked.toLocaleString()} requests blocked this session` : 'Downloading filter lists…'}${stats.listsUpdatedAt ? ` · lists updated ${timeAgo(Math.floor(stats.listsUpdatedAt / 1000))}` : ''}. Uses EasyList, EasyPrivacy, annoyance lists and config/filters.txt.`
              : undefined
          }
        >
          <Switch label="Block ads" on={s.adblock} onChange={(v) => save({ privacy: { adblock: v } })} />
        </Setting>
        <Setting title="Block popups and cross-site redirects" desc={`${popups.toLocaleString()} blocked this session. Same-site links still open inside the site's session.`}>
          <Switch label="Block popups" on={s.blockPopups} onChange={(v) => save({ privacy: { blockPopups: v } })} />
        </Setting>
      </Group>
      <Group title="Cloudflare">
        <Setting
          title="Automatic Cloudflare verification"
          desc="When a site shows a Cloudflare check, AniVerse runs it in a real browser window inside that site's own session. Most checks pass on their own; if one needs you, the window is shown so you can complete it."
        >
          <Switch label="Auto Cloudflare" on={s.autoCloudflare} onChange={(v) => save({ privacy: { autoCloudflare: v } })} />
        </Setting>
      </Group>
      <Group title="Data">
        <Setting title="Clear metadata cache" desc="Forces fresh data from AniList. Your library, history and logins are kept.">
          <button className="btn sm" onClick={() => void call('app.cacheClear').then(() => toast.push({ level: 'success', message: 'Cache cleared.' }))}>
            Clear cache
          </button>
        </Setting>
      </Group>
    </>
  );
}

function UpdatesGroup() {
  const s = useSettings();
  const save = useSave();
  const toast = useToast();
  const install = useInstallUpdate();
  const { data: u } = useUpdateState();
  const [busy, setBusy] = useState(false);
  if (!u) return null;
  const run = (method: 'update.check' | 'update.download') => {
    setBusy(true);
    call(method)
      .catch((err) => toast.push({ level: 'error', message: errorText(err) }))
      .finally(() => setBusy(false));
  };
  const off = u.status === 'disabled';
  const working = busy || u.status === 'checking' || u.status === 'downloading';
  return (
    <Group title="Updates">
      <Setting title={`AniVerse ${u.current}`} desc={updateSummary(u)}>
        {u.status === 'downloaded' ? (
          <button className="btn primary sm" onClick={() => void install()}>
            <RotateCw size={14} /> Restart to update
          </button>
        ) : u.status === 'available' ? (
          <button className="btn primary sm" disabled={working} onClick={() => run('update.download')}>
            <Download size={14} /> Download {u.version}
          </button>
        ) : (
          <button className="btn sm" disabled={off || working} onClick={() => run('update.check')}>
            <RefreshCw size={14} className={working ? 'spin' : undefined} /> Check for updates
          </button>
        )}
        {u.version && u.releaseUrl && (
          <button className="btn ghost sm" onClick={() => void call('app.openExternal', { url: u.releaseUrl! })}>
            What’s new
          </button>
        )}
      </Setting>
      {u.status === 'downloading' && (
        <div className="card-pad">
          <div className="update-progress" role="progressbar" aria-valuenow={Math.floor(u.progress?.percent ?? 0)} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${u.progress?.percent ?? 0}%` }} />
          </div>
        </div>
      )}
      <Setting title="Check for updates automatically" desc="At start-up and every 6 hours, from AniVerse’s GitHub releases.">
        <Switch on={s.updates.autoCheck} disabled={off} label="Check for updates automatically" onChange={(autoCheck) => save({ updates: { autoCheck } })} />
      </Setting>
      <Setting
        title="Download updates automatically"
        desc="Downloads in the background (only the parts that changed, when possible) and installs when you restart or quit. Updates must carry AniVerse’s code signature, or they are not installed."
      >
        <Switch on={s.updates.autoDownload} disabled={off} label="Download updates automatically" onChange={(autoDownload) => save({ updates: { autoDownload } })} />
      </Setting>
    </Group>
  );
}

function AboutSection() {
  const info = useAppInfo().data;
  return (
    <>
      <Disclaimer />
      <UpdatesGroup />
      <Group title="AniVerse">
        <div className="card-pad help">
          <p style={{ marginTop: 0 }}>
            Version {info?.version} · Electron {info?.electron} · Chromium {info?.chrome} · {info?.platform}
          </p>
          <p>
            Data folder: <span className="code">{info?.dataPath}</span>
          </p>
          <p style={{ marginBottom: 0 }}>
            Anime information, schedules and discussions come from AniList’s public API. Official channels play through YouTube’s embed, and the built-in player plays links or files you provide.
          </p>
        </div>
      </Group>
    </>
  );
}
