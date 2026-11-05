import { CalendarDays, Compass, Download, FilePlay, Globe, History, Home, Library, Menu, RefreshCw, Search, Settings as SettingsIcon, ShieldCheck, WifiOff, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type TouchEvent as ReactTouchEvent } from 'react';
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
import { tabletSafeBounds } from './chromeBounds';

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
  const refreshingRef = useRef(false);
  const pullStart = useRef<{ x:number; y:number } | null>(null);
  const pullDistance = useRef(0);
  const [pull, setPull] = useState(0);
  const [navigation, setNavigation] = useState(tablet.navigation);
  const [railVisible, setRailVisible] = useState(tablet.railVisible);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const effectiveNavigation = windowWidth < 600 ? 'tabs' : navigation;
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
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await qc.cancelQueries();
      await tablet.refresh();
      await qc.invalidateQueries();
    } catch (error) {
      toast.push({ level: 'error', message: (error as Error).message });
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };
  const cancelPull = () => {
    pullStart.current = null;
    pullDistance.current = 0;
    setPull(0);
  };
  const startPull = (event: ReactTouchEvent<HTMLElement>) => {
    cancelPull();
    const scroller = main.current;
    if (!scroller || scroller.scrollTop > 0 || refreshingRef.current || event.touches.length !== 1) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest('a,button,input,textarea,select,label,summary,[role="button"],[role="combobox"],[role="slider"],[contenteditable="true"],.tablet-watch,.tablet-player-slot,video,iframe,.hero-thumbs,.mcard')) return;
    // Nested scroll lists and horizontal carousels keep ownership of their gesture.
    for (let node:Element|null = target; node && node !== scroller; node = node.parentElement) {
      const style = getComputedStyle(node);
      if ((node.scrollWidth > node.clientWidth + 2 && /auto|scroll/.test(style.overflowX)) ||
          (node.scrollHeight > node.clientHeight + 2 && /auto|scroll/.test(style.overflowY))) return;
    }
    const touch = event.touches[0];
    pullStart.current = { x:touch.clientX, y:touch.clientY };
  };
  const movePull = (event: TouchEvent) => {
    const start = pullStart.current;
    if (!start) return;
    if (event.touches.length !== 1 || (main.current?.scrollTop ?? 1) > 0) { cancelPull(); return; }
    const touch = event.touches[0], dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    if (dy < 0 || (Math.abs(dx) > 14 && Math.abs(dx) > dy * .7)) { cancelPull(); return; }
    if (dy > 8 && event.cancelable) event.preventDefault();
    const distance = Math.min(84, Math.max(0, dy - 8) * .45);
    pullDistance.current = distance;
    setPull(distance);
  };
  const finishPull = () => {
    const ready = pullDistance.current >= 56;
    cancelPull();
    if (ready) void refresh();
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
    const refreshWidth = () => setWindowWidth(window.innerWidth);
    const refreshNavigation = () => setNavigation(tablet.navigation());
    const refreshSurface = () => setSurface(tablet.surface());
    const refreshRail = () => setRailVisible(tablet.railVisible());
    window.addEventListener('online', refreshOnline);
    window.addEventListener('resize', refreshWidth);
    window.addEventListener('offline', refreshOnline);
    window.addEventListener('tablet-navigation-changed', refreshNavigation);
    window.addEventListener('tablet-surface-changed', refreshSurface);
    window.addEventListener('tablet-rail-visibility-changed', refreshRail);
    return () => {
      window.removeEventListener('online', refreshOnline);
      window.removeEventListener('resize', refreshWidth);
      window.removeEventListener('offline', refreshOnline);
      window.removeEventListener('tablet-navigation-changed', refreshNavigation);
      window.removeEventListener('tablet-surface-changed', refreshSurface);
      window.removeEventListener('tablet-rail-visibility-changed', refreshRail);
    };
  }, []);
  useLayoutEffect(() => { window.dispatchEvent(new Event('tablet-chrome-changed')); }, [effectiveNavigation, railVisible]);
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
  useEffect(() => {
    const scroller = main.current;
    if (!scroller) return;
    // React delegates touchmove passively. Claim only an eligible downward pull,
    // before Chromium takes over the gesture; normal page/carousel scroll is untouched.
    scroller.addEventListener('touchmove', movePull, { passive:false });
    return () => scroller.removeEventListener('touchmove', movePull);
  }, []);
  useEffect(() => {
    const scroller = main.current;
    if (!scroller) return;
    let timer = 0;
    let press:{ card:HTMLElement; x:number; y:number; pointer:number }|null = null;
    let held:{ card:HTMLElement; until:number }|null = null;
    const cancel = () => { clearTimeout(timer); timer = 0; press = null; };
    const cardFor = (target:EventTarget|null) => target instanceof Element ? target.closest<HTMLElement>('.mcard') : null;
    const suppress = (event:Event) => {
      if (!held || Date.now() > held.until || cardFor(event.target) !== held.card) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const context = (event:MouseEvent) => {
      const card = cardFor(event.target);
      if (!card) return;
      if (event.isTrusted && held?.card === card && Date.now() < held.until) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      // Some WebViews send native contextmenu before our timer; use it once.
      if (press?.card === card) {
        cancel();
        held = { card, until:Date.now() + 700 };
      }
    };
    const down = (event:PointerEvent) => {
      cancel();
      if (event.pointerType !== 'touch' || !event.isPrimary || event.button !== 0) return;
      const card = cardFor(event.target);
      if (!card || (event.target instanceof Element && event.target.closest('button,input,textarea,select,[contenteditable="true"]'))) return;
      press = { card, x:event.clientX, y:event.clientY, pointer:event.pointerId };
      timer = window.setTimeout(() => {
        const value = press;
        if (!value || !value.card.isConnected || document.hidden) { cancel(); return; }
        held = { card:value.card, until:Date.now() + 700 };
        press = null;
        timer = 0;
        value.card.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles:true, cancelable:true, view:window,
          clientX:value.x, clientY:value.y, button:2, buttons:2,
        }));
      }, 500);
    };
    const move = (event:PointerEvent) => {
      if (press && (event.pointerId !== press.pointer || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10)) cancel();
    };
    const end = () => {
      cancel();
      if (held && Date.now() < held.until) held.until = Date.now() + 700;
    };
    scroller.addEventListener('pointerdown', down, true);
    scroller.addEventListener('pointermove', move, true);
    scroller.addEventListener('pointerup', end, true);
    scroller.addEventListener('pointercancel', cancel, true);
    scroller.addEventListener('contextmenu', context, true);
    scroller.addEventListener('mousedown', suppress, true);
    scroller.addEventListener('click', suppress, true);
    window.addEventListener('scroll', cancel, true);
    return () => {
      cancel();
      scroller.removeEventListener('pointerdown', down, true);
      scroller.removeEventListener('pointermove', move, true);
      scroller.removeEventListener('pointerup', end, true);
      scroller.removeEventListener('pointercancel', cancel, true);
      scroller.removeEventListener('contextmenu', context, true);
      scroller.removeEventListener('mousedown', suppress, true);
      scroller.removeEventListener('click', suppress, true);
      window.removeEventListener('scroll', cancel, true);
    };
  }, [location.pathname]);
  useEffect(() => onEvent('app.notice', value => toast.push(value)), [toast]);

  useLayoutEffect(() => {
    const scroller = main.current;
    if (!scroller) return;
    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = tabletSafeBounds(scroller.getBoundingClientRect()), root = document.documentElement;
        const top = Math.ceil(r.top + 8), bottom = Math.floor(r.bottom - 8);
        root.style.setProperty('--tablet-menu-height', Math.max(48, bottom - top) + 'px');
        const menu = document.querySelector<HTMLElement>('.ctx-menu');
        if (!menu) return;
        const width = menu.getBoundingClientRect().width, height = Math.min(menu.scrollHeight + 2, bottom - top);
        const desiredX = parseFloat(menu.style.left) || r.left, desiredY = parseFloat(menu.style.top) || top;
        root.style.setProperty('--tablet-menu-left', Math.max(r.left + 8, Math.min(desiredX, r.right - width - 8)) + 'px');
        root.style.setProperty('--tablet-menu-top', Math.max(top, Math.min(desiredY, bottom - height)) + 'px');
      });
    };
    const resize = new ResizeObserver(sync);
    resize.observe(scroller);
    const layers = new MutationObserver(sync);
    layers.observe(document.body, { childList:true, subtree:true });
    const internalMenuScroll = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.ctx-menu')) event.stopImmediatePropagation();
    };
    window.addEventListener('scroll', internalMenuScroll, true);
    window.addEventListener('resize', sync);
    window.addEventListener('tablet-chrome-changed', sync);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      layers.disconnect();
      window.removeEventListener('scroll', internalMenuScroll, true);
      window.removeEventListener('resize', sync);
      window.removeEventListener('tablet-chrome-changed', sync);
    };
  }, []);

  useEffect(() => {
    const scroller=main.current;
    if(!scroller||location.pathname!=='/')return;
    let hero:Element|null=null,frame=0,last=-1;
    const cards=new MutationObserver(()=>schedule());
    const sync=()=>{
      frame=0;
      const next=scroller.querySelector('.hero:not(.skeleton)');
      if(next!==hero){cards.disconnect();hero=next;last=-1;if(hero)cards.observe(hero,{subtree:true,attributes:true,attributeFilter:['class']});}
      if(!hero)return;
      const dots=[...hero.querySelectorAll<HTMLElement>('.hero-dots button')];
      dots.forEach((dot,index)=>{dot.dataset.slideCaption=(index+1)+' / '+dots.length;});
      const selected=dots.findIndex(dot=>dot.classList.contains('active'));
      if(selected===last)return;last=selected;
      const track=hero.querySelector<HTMLElement>('.hero-thumbs'),active=track?.querySelector<HTMLElement>('.hero-thumb.active');
      if(track&&active)track.scrollTo({left:Math.max(0,track.scrollLeft+active.getBoundingClientRect().left-track.getBoundingClientRect().left-(track.clientWidth-active.getBoundingClientRect().width)/2),behavior:settings.appearance.reduceMotion||matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth'});
    };
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(sync);};
    const mounts=new MutationObserver(schedule);mounts.observe(scroller,{childList:true,subtree:true});schedule();
    return()=>{cancelAnimationFrame(frame);cards.disconnect();mounts.disconnect();};
  },[location.pathname,settings.appearance.reduceMotion]);

  const moreActive = MORE.some(item => location.pathname === item.to || location.pathname.startsWith(item.to + '/'));
  useLayoutEffect(() => {
    const nav = navigationBar.current;
    if (!nav) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const active = nav.querySelector<HTMLElement>('.tablet-nav-item.active');
        const target = effectiveNavigation === 'rail' ? active?.querySelector<HTMLElement>('.tablet-nav-icon') : active;
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
  }, [location.pathname, effectiveNavigation, moreActive, railVisible]);

  return <><div className="app tablet-app" data-navigation={effectiveNavigation} data-navigation-preference={navigation} data-rail-visible={effectiveNavigation==='rail'&&railVisible?'true':'false'}>
    <header className="tablet-topbar">
      <div className="tablet-leading-chrome"><NavLink to="/" className="tablet-brand" aria-label="AniVerse home" title="AniVerse"><Logo/></NavLink>{effectiveNavigation==='rail'&&<button type="button" className="icon-btn tablet-rail-toggle" aria-label={railVisible?'Hide navigation':'Show navigation'} title={railVisible?'Hide navigation':'Show navigation'} aria-expanded={railVisible} aria-controls="tablet-main-navigation" onClick={()=>void tablet.setRailVisible(!railVisible).catch(error=>toast.push({level:'error',message:error.message}))}>{railVisible?<X size={21}/>:<Menu size={21}/>}</button>}</div>
      <div className="tablet-profile-pill">
        {!online && <span className="tablet-offline" role="status" aria-label="Offline"><WifiOff size={18}/></span>}
        <IncognitoButton/>
        <NavLink to="/settings" className="tablet-avatar" aria-label="Profile and settings">{settings.profile.name.slice(0, 1).toUpperCase() || 'V'}</NavLink>
      </div>
    </header>
    <div className="tablet-search-dock"><TabletSearch refreshing={refreshing} onRefresh={() => void refresh()}/></div>
    <nav id="tablet-main-navigation" ref={navigationBar} className="tablet-nav" aria-label="Main" hidden={effectiveNavigation==='rail'&&!railVisible}><span aria-hidden="true" className="tablet-nav-indicator" style={{ width: indicator.width, height: indicator.height, opacity: indicator.width ? 1 : 0, transform: "translate3d("+indicator.x+"px, "+indicator.y+"px, 0)" }}/>
      {NAV.map(item => <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => 'tablet-nav-item' + (isActive ? ' active' : '')}><span className="tablet-nav-icon"><item.icon size={24}/></span><span>{item.label}</span></NavLink>)}
      <div className="tablet-nav-spacer"/>
      <button ref={moreButton} type="button" className={'tablet-nav-item tablet-more-button' + (moreActive ? ' active' : '')} aria-label="More" aria-haspopup="dialog" aria-expanded={moreOpen} aria-controls={moreOpen ? 'tablet-more-panel' : undefined} onClick={() => setMoreOpen(true)}><span className="tablet-nav-icon"><Menu size={24}/></span><span>More</span></button>
    </nav>
    <main className="main tablet-main" ref={main} aria-busy={refreshing} onTouchStart={startPull} onTouchEnd={finishPull} onTouchCancel={cancelPull}>
      {(pull > 0 || refreshing) && <div className="tablet-pull-indicator" role="status" style={{ transform:"translate(-50%, "+Math.min(20,pull*.25)+"px)" }}><RefreshCw size={20} className={refreshing?'spin':undefined} style={refreshing?undefined:{transform:"rotate("+Math.round(pull/56*180)+"deg)"}}/><span>{refreshing?'Refreshing…':pull>=56?'Release to refresh':'Pull to refresh'}</span></div>}
      <AndroidUpdateNotice/><ContextMenuProvider><div className={'tablet-route'+(location.pathname.startsWith('/watch/')?' tablet-watch-route':'')} key={location.pathname}><Outlet/></div></ContextMenuProvider></main>
    {moreOpen && <Modal title="More" onClose={closeMore}><div id="tablet-more-panel" ref={morePanel} className="tablet-more-panel"><nav aria-label="More destinations">{MORE.map(item => <NavLink key={item.to} to={item.to} onClick={() => setMoreOpen(false)} className={({ isActive }) => 'tablet-more-link' + (isActive ? ' active' : '')}><item.icon size={23}/><span><b>{item.label}</b><small>{item.detail}</small></span></NavLink>)}</nav><NavLink to="/settings/security" className="tablet-more-link" onClick={() => setMoreOpen(false)}><ShieldCheck size={23}/><span><b>Security & privacy</b><small>Device and browser protection</small></span></NavLink><button className="btn tablet-more-close" onClick={closeMore}><X size={18}/> Close menu</button></div></Modal>}
    {notice && <Modal title="Welcome to AniVerse for tablets" onClose={() => undefined} actions={<button className="btn primary" onClick={() => void tablet.acceptNotice().then(() => setNotice(false)).catch(error => toast.push({ level: 'error', message: error.message }))}>I understand · Start browsing</button>}>
      <div className="tablet-notice-art"><Logo/><span>Your stories.<br/><b>Your space.</b></span></div>
      <p><b>Your websites and your local library.</b> Add the websites you choose. Each source gets its own browser profile and keeps its original player. No streaming-source list is included.</p>
      <p>Use websites and local files you are entitled to access. Imported files and completed downloads stay in app-private storage until you remove them.</p>
      <p>Designed for Android 15+ tablets and resizable Android windows. The layout adapts to the space available, including portrait and desktop windows. Compatibility with every device or future Android version is not guaranteed.</p>
      <p>Keep Android and System WebView updated. This personal project has no promised update schedule. License, privacy and browser notices are available in Settings.</p>
    </Modal>}
  </div></>;
}

function TabletSearch({ refreshing, onRefresh }: { refreshing:boolean; onRefresh:()=>void }) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(''), [query, setQuery] = useState(''), [open, setOpen] = useState(false);
  const navigate = useNavigate(), settings = useSettings();
  // Closed suggestions do not need a background search request.
  const { data, isFetching, error, refetch } = useSearch(open ? query : '');
  useEffect(() => { const timer = setTimeout(() => setQuery(text.trim()), 250); return () => clearTimeout(timer); }, [text]);
  const go = (route: string) => { input.current?.blur(); setOpen(false); setText(''); navigate(route); };
  return <form className="tablet-search" role="search" onSubmit={event => { event.preventDefault(); if (text.trim()) go('/browse?search=' + encodeURIComponent(text.trim())); }} onKeyDown={event => { if (event.key === 'Escape') { setOpen(false); event.currentTarget.querySelector('input')?.focus(); } }}>
    <Search size={21}/><input ref={input} aria-label="Search anime" placeholder="Search anime" value={text} onFocus={() => setOpen(true)} onChange={event => { setText(event.target.value); setOpen(true); }} enterKeyHint="search" autoComplete="off"/>
    {text && <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => setText('')}><X size={18}/></button>}
    <button type="button" className="icon-btn tablet-search-refresh" aria-label="Refresh" title="Refresh data and saved sources" disabled={refreshing} onClick={onRefresh}><RefreshCw size={19} className={refreshing?'spin':undefined}/></button>
    {open && text.trim().length >= 2 && <><button type="button" className="tablet-search-dismiss" aria-label="Close search suggestions" onClick={() => setOpen(false)}/><div className="tablet-search-results card">
      {query !== text.trim() || isFetching ? <p className="tablet-search-state" role="status">Searching…</p> : error ? <div className="tablet-search-state" role="alert"><p>Search could not load.</p><button type="button" className="btn" onClick={() => void refetch()}>Retry search</button></div> : data?.length ? data.slice(0, 6).map(media => <button type="button" key={media.id} onClick={() => go('/anime/' + media.id)}>{media.cover && <img src={media.cover} alt=""/>}<span>{titleOf(media, settings.appearance.titleLanguage)}<small>{media.format} · {media.seasonYear ?? 'Year unknown'}</small></span></button>) : <p className="tablet-search-state" role="status">No matching anime. Try another title.</p>}
      <button type="submit" className="tablet-search-all">See all results for “{text}”</button>
    </div></>}
  </form>;
}

