import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import {
  CalendarDays,
  Copy,
  Minus,
  Square,
  X,
  PanelsTopLeft,
  Clapperboard,
  Compass,
  Globe,
  History,
  Home,
  Library,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Search,
  Settings as SettingsIcon,
  Shuffle,
  UserRound,
  RefreshCw,
  ShieldCheck,
  Link2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { call, isAniVerse2, modernWindows, platform, onEvent } from '../lib/bridge';
import { cx, formatLabel, titleOf } from '../lib/format';
import { useAccounts, useAdblockStats, useBridgeEvents, useSearch, useSettings } from '../lib/queries';
import { useToast } from '../lib/useToast';
import { Logo, Spinner } from './common';
import { ContextMenuProvider } from './ContextMenu';
import { useInterfaceLayout } from '../lib/interfaceLayout';
import { seasonalVisuals } from '../../../app/shared/seasonal';
import { useMidnightTheme } from '../lib/desktopTheme';
import { DesktopSeasonalVisuals } from '../lib/seasonal';
import { IncognitoButton } from './Privacy';
import { ReleaseAnnouncements } from './Changelog';
import { UpdateBadge } from './Updates';
import { DesktopSearch } from './DesktopSearch';

const NAV = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/browse', label: 'Browse', icon: Compass },
  { to: '/schedule', label: 'Schedule', icon: CalendarDays },
  { to: '/library', label: 'Library', icon: Library },
  { to: '/history', label: 'History', icon: History },
  { to: '/sources', label: 'Sources', icon: Globe },
  { to: '/workspace', label: 'Workspace', icon: PanelsTopLeft },
  { to: '/player', label: 'Player', icon: Clapperboard },
];

function readRailPref(): boolean {
  try {
    return localStorage.getItem('aniverse.rail') === 'open';
  } catch {
    return false;
  }
}

export function Shell() {
  const qc = useQueryClient();
  useBridgeEvents(qc);
  const settings = useSettings();
  const [open, setOpen] = useState(() => !modernWindows && readRailPref());
  const midnight = useMidnightTheme();
  const layout = useInterfaceLayout(settings.appearance.style);
  const canToggleRail = layout === 'classic' || (modernWindows && (layout === 'studio' || layout === 'atlas'));
  const RailToggleIcon = layout === 'atlas'
    ? (open ? PanelRightClose : PanelRightOpen)
    : (open ? PanelLeftClose : PanelLeftOpen);
  const navigate = useNavigate();
  const toast = useToast();
  const location = useLocation();
  const main = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.desktopTheme = midnight ? 'midnight' : 'standard';
    root.dataset.style = settings.appearance.style;
    root.dataset.layout = layout;
    root.dataset.accent = settings.appearance.accent;
    root.dataset.density = settings.appearance.density;
    root.dataset.font = settings.appearance.fontFamily;
    root.dataset.motion = settings.appearance.reduceMotion ? 'reduce' : 'full';
  }, [settings.appearance, layout, midnight]);

  useEffect(()=>{
    const icon=document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const refresh = () => {
      const on = !midnight && seasonalVisuals(new Date(), settings.appearance.accent);
      const root = document.documentElement;
      if (root.dataset.seasonal === String(on)) return;
      root.dataset.seasonal = String(on);
      if (icon) icon.href = isAniVerse2 ? './aniverse2-mark.png' : on ? './festival-icon.svg' : './favicon.svg';
    };
    refresh();
    if (midnight || settings.appearance.accent !== 'festival') return;
    const timer = window.setInterval(refresh, 1000);
    return () => window.clearInterval(timer);
  }, [settings.appearance.accent, midnight]);

  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
  }, [location.pathname]);

  const toggleRail = () => {
    setOpen((v) => {
      if (modernWindows) return !v;
      try {
        localStorage.setItem('aniverse.rail', v ? 'closed' : 'open');
      } catch {
        // storage unavailable
      }
      return !v;
    });
  };

  const random = async () => {
    try {
      const page = Math.ceil(Math.random() * 40);
      const res = await call('meta.browse', { sort: 'POPULARITY_DESC', page, perPage: 50 });
      const pick = res.items[Math.floor(Math.random() * res.items.length)];
      if (pick) navigate(`/anime/${pick.id}`);
    } catch (err) {
      toast.push({ level: 'error', message: `Random pick failed: ${(err as Error).message}` });
    }
  };

  return (
    <DesktopSeasonalVisuals.Provider value={!midnight}>
    <div className={cx('app', canToggleRail && open && 'rail-open', 'layout-' + layout)}>
      <header className={cx('topbar', platform === 'win32' && !isAniVerse2 && 'win', isAniVerse2 && 'tauri-topbar')}>
        <div className="brand">
          {canToggleRail && <button className="icon-btn" aria-label={open ? 'Collapse sidebar' : 'Expand sidebar'}
            aria-expanded={open} aria-controls="main-navigation" onClick={toggleRail}>
            <RailToggleIcon size={18} />
          </button>}
          <Logo />
          <span className="word" data-tauri-drag-region={isAniVerse2 ? "" : undefined}>
            Ani<b>Verse{isAniVerse2 ? '2' : ''}</b>
          </span>
        </div>
        {modernWindows ? <DesktopSearch /> : <SearchBox />}
        <div className="spacer" data-tauri-drag-region={isAniVerse2 ? "" : undefined} />
        <IncognitoButton />
        <ReleaseAnnouncements />
        <UpdateBadge />
        <RefreshButton />
        <AdblockBadge />
        <ProfileMenu />
        {isAniVerse2 && <WindowControls />}
      </header>

      <nav id="main-navigation" className="rail" aria-label="Main">
        {layout === 'studio' && <div className="studio-nav-heading"><span>YOUR WORKSPACE</span><h2>Anime studio</h2><p>Discover, plan and continue.</p></div>}
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => cx('rail-item', isActive && 'active')} title={item.label}>
            <item.icon size={19} />
            <span className="rail-label">{item.label}</span>
          </NavLink>
        ))}
        <button className="rail-item" title="Random anime" onClick={random}>
          <Shuffle size={19} />
          <span className="rail-label">Random</span>
        </button>
        <div className="grow" />
        <div className="sep" />
        <NavLink to="/settings" className={({ isActive }) => cx('rail-item', isActive && 'active')} title="Settings">
          <SettingsIcon size={19} />
          <span className="rail-label">Settings</span>
        </NavLink>
      </nav>

      <main className="main" ref={main}>
        <ContextMenuProvider>
          <Outlet />
        </ContextMenuProvider>
      </main>
    </div>
    </DesktopSeasonalVisuals.Provider>
  );
}

function WindowControls() {
  const toast = useToast();
  const [maximized, setMaximized] = useState(false);
  const controls = window.aniverse?.windowControls;
  useEffect(() => {
    if (!controls) return;
    const sync = () => void controls.isMaximized().then(setMaximized, () => undefined);
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, [controls]);
  if (!controls) return null;

  const run = (action: 'minimize' | 'toggleMaximize' | 'close') => {
    void controls[action]().catch((error) => toast.push({ level: 'error', message: String(error) }));
  };
  const resizeLabel = maximized ? 'Restore window' : 'Maximize window';
  return (
    <div className="tauri-window-controls" aria-label="Window controls" role="group">
      <button type="button" aria-label="Minimize window" title="Minimize" onClick={() => run('minimize')}><Minus size={14} /></button>
      <button type="button" aria-label={resizeLabel} title={resizeLabel} onClick={() => run('toggleMaximize')}>
        {maximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button type="button" aria-label="Close window" title="Close" onClick={() => run('close')}><X size={15} /></button>
    </div>
  );
}

function SearchBox() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [focus, setFocus] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const lang = useSettings().appearance.titleLanguage;
  const { data, isFetching } = useSearch(debounced);
  useEffect(()=>onEvent('privacy.changed',()=>{setQ('');setDebounced('');setFocus(false);}),[]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 320);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const results = q.trim().length >= 2 && q.trim()===debounced.trim() ? (data ?? []) : [];
  const go = (path: string) => {
    setFocus(false);
    input.current?.blur();
    navigate(path);
  };
  const submit = () => {
    if (results[active] && active >= 0) go(`/anime/${results[active].id}`);
    else if (q.trim()) go(`/browse?search=${encodeURIComponent(q.trim())}`);
  };

  return (
    <div className="search">
      <Search size={16} />
      <input
        ref={input}
        className="input"
        placeholder="Search titles · English / 日本語…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onFocus={() => setFocus(true)}
        onBlur={() => setTimeout(() => setFocus(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, results.length - 1));
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, -1));
          else if (e.key === 'Enter') submit();
          else if (e.key === 'Escape') input.current?.blur();
        }}
        aria-label="Search anime"
      />
      <kbd>{isFetching ? <Spinner size="sm" /> : 'Ctrl K'}</kbd>
      {focus && q.trim().length >= 2 && (
        <div className="suggest">
          <div className="suggest-hint">English, romaji and Japanese titles · closest matches · playback tries your enabled sources</div>
          {results.length === 0 && !isFetching && <div className="faint" style={{ padding: 10 }}>No matches for “{q}”.</div>}
          {results.map((m, i) => (
            <div key={m.id} className={cx('suggest-item', i === active && 'active')} onMouseDown={() => go(`/anime/${m.id}`)} onMouseEnter={() => setActive(i)}>
              <img src={m.cover} alt="" />
              <div className="grow">
                <div className="ellipsis" style={{ fontWeight: 650 }}>
                  {titleOf(m, lang)}
                </div>
                <div className="faint" style={{ fontSize: 'var(--fs-xs)' }}>
                  {[m.title.romaji!==titleOf(m,lang)?m.title.romaji:m.title.english!==titleOf(m,lang)?m.title.english:m.title.native,formatLabel(m.format), m.seasonYear, m.episodes ? `${m.episodes} eps` : null].filter(Boolean).join(' · ')}
                </div>
              </div>
              {m.score && <span className="chip">{(m.score / 10).toFixed(1)}</span>}
            </div>
          ))}
          <div className="suggest-foot" onMouseDown={() => go(`/browse?search=${encodeURIComponent(q.trim())}`)}>
            View all results
          </div>
        </div>
      )}
    </div>
  );
}

/** Re-fetches everything on screen (AniList data, library, sources). */
function RefreshButton() {
  const qc = useQueryClient();
  const fetching = useIsFetching();
  const [spin, setSpin] = useState(false);
  return (
    <button
      className="icon-btn bordered"
      aria-label="Refresh"
      title="Refresh (F5)"
      onClick={() => {
        setSpin(true);
        void qc.invalidateQueries().finally(() => setSpin(false));
      }}
    >
      <RefreshCw size={15} className={spin || fetching > 0 ? 'spin' : undefined} />
    </button>
  );
}

function AdblockBadge() {
  const { data } = useAdblockStats();
  const navigate = useNavigate();
  if (!data) return null;
  const total = Object.values(data.blocked).reduce((a, b) => a + b, 0) + Object.values(data.popupsBlocked).reduce((a, b) => a + b, 0) + Object.values(data.securityBlocked??{}).reduce((a,b)=>a+b,0);
  return (
    <button
      className={cx('shield', !data.enabled && 'off')}
      style={{ border: 0, cursor: 'pointer', height: 30 }}
      title={data.enabled ? (data.ready ? 'Ads, popups and unsafe source requests blocked this session' : 'Loading filter lists…') : 'Ad blocking is off'}
      onClick={() => navigate('/settings/privacy')}
    >
      <ShieldCheck size={14} /> {data.enabled ? (data.ready ? total.toLocaleString() : '…') : 'Off'}
    </button>
  );
}

function ProfileMenu() {
  const [open, setOpen] = useState(false);
  const settings = useSettings();
  const { data: accounts } = useAccounts();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const connected = accounts?.filter((a) => a.connected) ?? [];
  const avatar = settings.profile.avatar ?? connected.find((a) => a.avatar)?.avatar;
  const name = settings.profile.name;

  const syncNow = async () => {
    setSyncing(true);
    try {
      const r = await call('accounts.sync', { provider: null });
      toast.push({ level: r.errors.length ? 'warn' : 'success', message: r.errors[0] ?? `Synced: ${r.pulled} pulled, ${r.pushed} pushed.` });
      void qc.invalidateQueries({ queryKey: ['library'] });
    } catch (err) {
      toast.push({ level: 'error', message: (err as Error).message });
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);

  return (
    <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
      <button className="profile-chip" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        <span className="avatar">{avatar ? <img src={avatar} alt="" /> : name[0]?.toUpperCase()}</span>
        <span style={{ fontWeight: 600 }}>{name}</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="head row" style={{ gap: 10 }}>
            <span className="avatar">{avatar ? <img src={avatar} alt="" /> : name[0]?.toUpperCase()}</span>
            <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700 }}>{name}</div>
            <div className="faint" style={{ fontSize: 'var(--fs-xs)' }}>
              {connected.length ? connected.map((a) => `${a.provider === 'mal' ? 'MAL' : 'AniList'}: ${a.userName}`).join(' · ') : 'No list service connected'}
            </div>
            </div>
          </div>
          <button onClick={() => (setOpen(false), navigate('/profile'))}>
            <UserRound size={15} /> My profile
          </button>
          <button onClick={() => (setOpen(false), navigate('/library'))}>
            <Library size={15} /> Library
          </button>
          <button onClick={() => (setOpen(false), navigate('/settings/accounts'))}>
            <Link2 size={15} /> Accounts & sync
          </button>
          <button disabled={!connected.length || syncing} onClick={syncNow}>
            <RefreshCw size={15} className={syncing ? 'spin' : undefined} /> {syncing ? 'Syncing…' : 'Sync now'}
          </button>
          <button onClick={() => (setOpen(false), navigate('/settings'))}>
            <SettingsIcon size={15} /> Settings
          </button>
        </div>
      )}
    </div>
  );
}
