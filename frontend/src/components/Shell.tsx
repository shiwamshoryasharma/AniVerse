import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import {
  CalendarDays,
  PanelsTopLeft,
  Clapperboard,
  Compass,
  Globe,
  History,
  Home,
  Library,
  PanelLeftClose,
  PanelLeftOpen,
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
import { call, platform } from '../lib/bridge';
import { cx, formatLabel, titleOf } from '../lib/format';
import { useAccounts, useAdblockStats, useBridgeEvents, useSearch, useSettings } from '../lib/queries';
import { useToast } from '../lib/useToast';
import { Logo, Spinner } from './common';
import { ContextMenuProvider } from './ContextMenu';
import { UpdateBadge } from './Updates';

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
  const [open, setOpen] = useState(readRailPref);
  const navigate = useNavigate();
  const toast = useToast();
  const location = useLocation();
  const main = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.accent = settings.appearance.accent;
    root.dataset.density = settings.appearance.density;
    root.dataset.font = settings.appearance.fontFamily;
    root.dataset.motion = settings.appearance.reduceMotion ? 'reduce' : 'full';
  }, [settings.appearance]);

  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
  }, [location.pathname]);

  const toggleRail = () => {
    setOpen((v) => {
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
    <div className={cx('app', open && 'rail-open')}>
      <header className={cx('topbar', platform === 'win32' && 'win')}>
        <div className="brand">
          <button className="icon-btn" aria-label={open ? 'Collapse sidebar' : 'Expand sidebar'} onClick={toggleRail}>
            {open ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
          <Logo />
          <span className="word">
            Ani<b>Verse</b>
          </span>
        </div>
        <SearchBox />
        <div className="spacer" />
        <UpdateBadge />
        <RefreshButton />
        <AdblockBadge />
        <ProfileMenu />
      </header>

      <nav className="rail" aria-label="Main">
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

  const results = q.trim().length >= 2 ? (data ?? []) : [];
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
        placeholder="Search anime…"
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
          {results.length === 0 && !isFetching && <div className="faint" style={{ padding: 10 }}>No matches for “{q}”.</div>}
          {results.map((m, i) => (
            <div key={m.id} className={cx('suggest-item', i === active && 'active')} onMouseDown={() => go(`/anime/${m.id}`)} onMouseEnter={() => setActive(i)}>
              <img src={m.cover} alt="" />
              <div className="grow">
                <div className="ellipsis" style={{ fontWeight: 650 }}>
                  {titleOf(m, lang)}
                </div>
                <div className="faint" style={{ fontSize: 'var(--fs-xs)' }}>
                  {[formatLabel(m.format), m.seasonYear, m.episodes ? `${m.episodes} eps` : null].filter(Boolean).join(' · ')}
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
  const total = Object.values(data.blocked).reduce((a, b) => a + b, 0) + Object.values(data.popupsBlocked).reduce((a, b) => a + b, 0);
  return (
    <button
      className={cx('shield', !data.enabled && 'off')}
      style={{ border: 0, cursor: 'pointer', height: 30 }}
      title={data.enabled ? (data.ready ? 'Ads, trackers and popups blocked this session' : 'Loading filter lists…') : 'Ad blocking is off'}
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
