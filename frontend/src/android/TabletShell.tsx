import { CalendarDays, Compass, Download, FilePlay, Globe, History, Home, Library, Menu, RefreshCw, Search, Settings as SettingsIcon, ShieldCheck, Smartphone, WifiOff, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Logo, Modal } from '../components/common';
import { ContextMenuProvider } from '../components/ContextMenu';
import { IncognitoButton } from '../components/Privacy';
import { onEvent } from '../lib/bridge';
import { useBridgeEvents, useSearch, useSettings } from '../lib/queries';
import { useToast } from '../lib/useToast';
import { titleOf } from '../lib/format';
import { tablet } from './bridge';
import { AndroidUpdateNotice } from './AndroidUpdates';

const NAV = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/browse', label: 'Browse', icon: Compass },
  { to: '/library', label: 'Library', icon: Library },
  { to: '/sources', label: 'Sources', icon: Globe },
];
const MORE = [
  { to: '/local', label: 'Local watch', detail: 'Your saved videos, ready offline', icon: FilePlay },
  { to: '/downloads', label: 'Downloads', detail: 'Manage your download queue', icon: Download },
  { to: '/history', label: 'History', detail: 'Pick up where you left off', icon: History },
  { to: '/schedule', label: 'Schedule', detail: 'Upcoming episodes in your timezone', icon: CalendarDays },
  { to: '/settings', label: 'Settings', detail: 'Appearance, navigation and accounts', icon: SettingsIcon },
];

export function TabletShell() {
  const settings = useSettings(), qc = useQueryClient(), toast = useToast(), location = useLocation();
  const [refreshing, setRefreshing] = useState(false);
  const [navigation, setNavigation] = useState(tablet.navigation);
  const [surface, setSurface] = useState(tablet.surface);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const navigationBar = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const morePanel = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLElement>(null);
  const [notice, setNotice] = useState(!tablet.accepted());
  const [online, setOnline] = useState(navigator.onLine);
  useBridgeEvents(qc);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await qc.cancelQueries();
      await tablet.refresh();
      await qc.invalidateQueries();
    } catch (error) {
      toast.push({ level: 'error', message: (error as Error).message });
    } finally {
      setRefreshing(false);
    }
  };
  const closeMore = () => {
    setMoreOpen(false);
    moreButton.current?.focus();
  };
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.style = settings.appearance.style;
    root.dataset.accent = settings.appearance.accent;
    root.dataset.density = 'comfortable';
    root.dataset.font = settings.appearance.fontFamily;
    root.dataset.motion = settings.appearance.reduceMotion ? 'reduce' : 'full';
  }, [settings.appearance]);
  useEffect(() => { main.current?.scrollTo({ top: 0 }); }, [location.pathname]);
  useLayoutEffect(() => { document.documentElement.dataset.tabletSurface = surface; }, [surface]);
  useEffect(() => {
    const refreshOnline = () => setOnline(navigator.onLine);
    const refreshNavigation = () => setNavigation(tablet.navigation());
    const refreshSurface = () => setSurface(tablet.surface());
    window.addEventListener('online', refreshOnline);
    window.addEventListener('offline', refreshOnline);
    window.addEventListener('tablet-navigation-changed', refreshNavigation);
    window.addEventListener('tablet-surface-changed', refreshSurface);
    return () => {
      window.removeEventListener('online', refreshOnline);
      window.removeEventListener('offline', refreshOnline);
      window.removeEventListener('tablet-navigation-changed', refreshNavigation);
      window.removeEventListener('tablet-surface-changed', refreshSurface);
    };
  }, []);
  useEffect(() => {
    if (!moreOpen) return;
    const panel = morePanel.current;
    panel?.querySelector<HTMLAnchorElement>('a')?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMoreOpen(false);
        moreButton.current?.focus();
      }
      if (event.key === 'Tab') {
        const controls = [...(panel?.querySelectorAll<HTMLElement>('a, button') ?? [])];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [moreOpen]);
  useEffect(() => onEvent('app.notice', value => toast.push(value)), [toast]);

  const moreActive = MORE.some(item => location.pathname === item.to || location.pathname.startsWith(item.to + '/'));
  useLayoutEffect(() => {
    const nav = navigationBar.current;
    if (!nav) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const active = nav.querySelector<HTMLElement>('.tablet-nav-item.active');
        const target = navigation === 'rail' ? active?.querySelector<HTMLElement>('.tablet-nav-icon') : active;
        if (!target) { setIndicator(value => ({ ...value, width: 0 })); return; }
        const parent = nav.getBoundingClientRect(), bounds = target.getBoundingClientRect();
        setIndicator({ x: bounds.left - parent.left + nav.scrollLeft, y: bounds.top - parent.top + nav.scrollTop, width: bounds.width, height: bounds.height });
      });
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(nav);
    nav.addEventListener('scroll', measure);
    return () => { cancelAnimationFrame(frame); resize.disconnect(); nav.removeEventListener('scroll', measure); };
  }, [location.pathname, navigation, moreActive]);

  return <><div className="app tablet-app" data-navigation={navigation}>
    <header className="tablet-topbar">
      <NavLink to="/" className="tablet-brand" aria-label="AniVerse home"><Logo/><span>Ani<b>Verse</b></span></NavLink>
      <TabletSearch/>
      <div className="grow"/>
      {!online && <span className="chip tablet-offline" role="status"><WifiOff size={15}/> Offline</span>}
      <button className="icon-btn" aria-label="Refresh" title="Refresh data and saved sources" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={20} className={refreshing ? 'spin' : undefined}/></button>
      {tablet.info().fixture && <span className="chip">Fixture build</span>}
      <IncognitoButton/>
      <NavLink className="tablet-security" to="/settings/security" aria-label="Security status" title="Security and privacy"><ShieldCheck size={20}/></NavLink>
      <NavLink to="/settings" className="tablet-avatar" aria-label="Profile and settings">{settings.profile.name.slice(0, 1).toUpperCase() || 'V'}</NavLink>
    </header>
    <nav ref={navigationBar} className="tablet-nav" aria-label="Main"><span aria-hidden="true" className="tablet-nav-indicator" style={{ width: indicator.width, height: indicator.height, opacity: indicator.width ? 1 : 0, transform: "translate3d("+indicator.x+"px, "+indicator.y+"px, 0)" }}/>
      {NAV.map(item => <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => 'tablet-nav-item' + (isActive ? ' active' : '')}><span className="tablet-nav-icon"><item.icon size={24}/></span><span>{item.label}</span></NavLink>)}
      <div className="tablet-nav-spacer"/>
      <button ref={moreButton} type="button" className={'tablet-nav-item tablet-more-button' + (moreActive ? ' active' : '')} aria-label="More" aria-haspopup="dialog" aria-expanded={moreOpen} aria-controls={moreOpen ? 'tablet-more-panel' : undefined} onClick={() => setMoreOpen(true)}><span className="tablet-nav-icon"><Menu size={24}/></span><span>More</span></button>
    </nav>
    <main className="main tablet-main" ref={main}><AndroidUpdateNotice/><ContextMenuProvider><div className={'tablet-route'+(location.pathname.startsWith('/watch/')?' tablet-watch-route':'')} key={location.pathname}><Outlet/></div></ContextMenuProvider></main>
    {moreOpen && <Modal title="More" onClose={closeMore}><div id="tablet-more-panel" ref={morePanel} className="tablet-more-panel"><nav aria-label="More destinations">{MORE.map(item => <NavLink key={item.to} to={item.to} onClick={() => setMoreOpen(false)} className={({ isActive }) => 'tablet-more-link' + (isActive ? ' active' : '')}><item.icon size={23}/><span><b>{item.label}</b><small>{item.detail}</small></span></NavLink>)}</nav><button className="btn tablet-more-close" onClick={closeMore}><X size={18}/> Close menu</button></div></Modal>}
    {notice && <Modal title="Welcome to AniVerse for tablets" onClose={() => undefined} actions={<button className="btn primary" onClick={() => void tablet.acceptNotice().then(() => setNotice(false)).catch(error => toast.push({ level: 'error', message: error.message }))}>I understand · Start browsing</button>}>
      <div className="tablet-notice-art"><Logo/><span>Your stories.<br/><b>Your tablet.</b></span></div>
      <p><b>Your websites and your local library.</b> Add the websites you choose. Each source gets its own browser profile and keeps its original player. No streaming-source list is included.</p>
      <p>Use websites and local files you are entitled to access. Imported files and completed downloads stay in app-private storage until you remove them.</p>
      <p>Designed for Android 15+ tablets in landscape, with a smallest screen width of 600 dp. Galaxy Tab S10+ is the primary target; compatibility with every device or future Android version is not guaranteed.</p>
      <p>Keep Android and System WebView updated. This personal project has no promised update schedule. License, privacy and browser notices are available in Settings.</p>
    </Modal>}
  </div><div className="tablet-rotate"><Smartphone size={48}/><h1>Turn your tablet sideways</h1><p>AniVerse is designed for landscape. Rotate the tablet or widen this window to continue.</p></div></>;
}

function TabletSearch() {
  const [text, setText] = useState(''), [query, setQuery] = useState(''), [open, setOpen] = useState(false);
  const navigate = useNavigate(), settings = useSettings();
  // Closed suggestions do not need a background search request.
  const { data, isFetching, error, refetch } = useSearch(open ? query : '');
  useEffect(() => { const timer = setTimeout(() => setQuery(text.trim()), 250); return () => clearTimeout(timer); }, [text]);
  const go = (route: string) => { setOpen(false); setText(''); navigate(route); };
  return <form className="tablet-search" role="search" onSubmit={event => { event.preventDefault(); if (text.trim()) go('/browse?search=' + encodeURIComponent(text.trim())); }} onKeyDown={event => { if (event.key === 'Escape') { setOpen(false); event.currentTarget.querySelector('input')?.focus(); } }}>
    <Search size={21}/><input aria-label="Search anime" placeholder="Search anime" value={text} onFocus={() => setOpen(true)} onChange={event => { setText(event.target.value); setOpen(true); }} enterKeyHint="search" autoComplete="off"/>
    {text && <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => setText('')}><X size={18}/></button>}
    {open && text.trim().length >= 2 && <><button type="button" className="tablet-search-dismiss" aria-label="Close search suggestions" onClick={() => setOpen(false)}/><div className="tablet-search-results card">
      {query !== text.trim() || isFetching ? <p className="tablet-search-state" role="status">Searching…</p> : error ? <div className="tablet-search-state" role="alert"><p>Search could not load.</p><button type="button" className="btn" onClick={() => void refetch()}>Retry search</button></div> : data?.length ? data.slice(0, 6).map(media => <button type="button" key={media.id} onClick={() => go('/anime/' + media.id)}>{media.cover && <img src={media.cover} alt=""/>}<span>{titleOf(media, settings.appearance.titleLanguage)}<small>{media.format} · {media.seasonYear ?? 'Year unknown'}</small></span></button>) : <p className="tablet-search-state" role="status">No matching anime. Try another title.</p>}
      <button type="submit" className="tablet-search-all">See all results for “{text}”</button>
    </div></>}
  </form>;
}

