import { CalendarDays, Compass, Download, FilePlay, Globe, History, Home, Library, RefreshCw, Search, Settings as SettingsIcon, ShieldCheck, Smartphone, WifiOff, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
const NAV=[{to:'/',label:'Home',icon:Home},{to:'/browse',label:'Browse',icon:Compass},{to:'/schedule',label:'Schedule',icon:CalendarDays},{to:'/library',label:'Library',icon:Library},{to:'/history',label:'History',icon:History},{to:'/sources',label:'Sources',icon:Globe},{to:'/local',label:'Local watch',icon:FilePlay},{to:'/downloads',label:'Downloads',icon:Download}];
export function TabletShell(){
  const settings=useSettings(),qc=useQueryClient(),toast=useToast(),location=useLocation();const [refreshing,setRefreshing]=useState(false);useBridgeEvents(qc);
  const refresh=async()=>{if(refreshing)return;setRefreshing(true);try{await qc.cancelQueries();await tablet.refresh();await qc.invalidateQueries();}catch(error){toast.push({level:'error',message:(error as Error).message});}finally{setRefreshing(false);}};
  const main=useRef<HTMLElement>(null);const [notice,setNotice]=useState(!tablet.accepted());const [online,setOnline]=useState(navigator.onLine);
  useEffect(()=>{const root=document.documentElement;root.dataset.style=settings.appearance.style;root.dataset.accent=settings.appearance.accent;root.dataset.density='comfortable';root.dataset.font=settings.appearance.fontFamily;root.dataset.motion=settings.appearance.reduceMotion?'reduce':'full';},[settings.appearance]);
  useEffect(()=>{main.current?.scrollTo({top:0});},[location.pathname]);
  useEffect(()=>{const refresh=()=>setOnline(navigator.onLine);window.addEventListener('online',refresh);window.addEventListener('offline',refresh);return()=>{window.removeEventListener('online',refresh);window.removeEventListener('offline',refresh);};},[]);
  useEffect(()=>onEvent('app.notice',value=>toast.push(value)),[toast]);
  return <><div className="app tablet-app">
    <header className="tablet-topbar"><NavLink to="/" className="tablet-brand" aria-label="AniVerse home"><Logo/><span>Ani<b>Verse</b><small>TABLET EDITION</small></span></NavLink><TabletSearch/><div className="grow"/>{!online&&<span className="chip tablet-offline"><WifiOff size={15}/> Offline</span>}<button className="icon-btn bordered" aria-label="Refresh" title="Refresh data and saved sources" disabled={refreshing} onClick={()=>void refresh()}><RefreshCw size={20} className={refreshing?'spin':undefined}/></button>{tablet.info().fixture&&<span className="chip">Fixture build</span>}<IncognitoButton/><NavLink className="tablet-security" to="/settings/security" aria-label="Security status"><ShieldCheck size={19}/><span>Sandbox</span></NavLink><NavLink to="/settings" className="tablet-avatar" aria-label="Profile and settings">{settings.profile.name.slice(0,1).toUpperCase()||'V'}</NavLink></header>
    <nav className="tablet-nav" aria-label="Main">{NAV.map(item=><NavLink key={item.to} to={item.to} end={item.to==='/'} className={({isActive})=>'tablet-nav-item'+(isActive?' active':'')}><item.icon size={23}/><span>{item.label}</span></NavLink>)}<div className="grow"/><NavLink to="/settings" className={({isActive})=>'tablet-nav-item'+(isActive?' active':'')}><SettingsIcon size={23}/><span>Settings</span></NavLink></nav>
    <main className="main tablet-main" ref={main}><ContextMenuProvider><Outlet/></ContextMenuProvider></main>
    {notice&&<Modal title="Welcome to AniVerse for tablets" onClose={()=>undefined} actions={<button className="btn primary" onClick={()=>void tablet.acceptNotice().then(()=>setNotice(false)).catch(error=>toast.push({level:'error',message:error.message}))}>I understand · Start browsing</button>}><div className="tablet-notice-art"><Logo/><span>Your stories.<br/><b>Your tablet.</b></span></div><p><b>A browser with anime features.</b> You choose and add the websites. AniVerse keeps each source in its own browser profile and uses the website’s original player. No streaming-source list is included.</p><p><b>Android 15+ tablets, in landscape.</b> Built primarily for the developer’s personal use on Galaxy Tab S10+. Compatible Tab S8/S9 and other tablets can be used when they run Android 15+ and meet the tablet-screen requirement. Compatibility with every model or future Android version is not guaranteed.</p><p>This is a personal project with no promised update schedule. Phone, iOS and other mobile-device editions are not planned. OS, browser, firmware and codec updates remain the device owner’s responsibility.</p><p>Use websites and local files you are entitled to access. Offline imports and completed downloads remain in app-private storage until you remove them. See the repository’s license, privacy and browser notices.</p></Modal>}
  </div><div className="tablet-rotate"><Smartphone size={48}/><h1>Turn your tablet sideways</h1><p>AniVerse is designed for landscape. Rotate the tablet or widen this window to continue.</p></div></>;
}
function TabletSearch(){
  const [text,setText]=useState(''),[query,setQuery]=useState(''),[open,setOpen]=useState(false);const navigate=useNavigate();const settings=useSettings();const {data,isFetching}=useSearch(query);
  useEffect(()=>{const timer=setTimeout(()=>setQuery(text.trim()),350);return()=>clearTimeout(timer);},[text]);
  const go=(route:string)=>{setOpen(false);setText('');navigate(route);};
  return <form className="tablet-search" role="search" onSubmit={event=>{event.preventDefault();if(text.trim())go('/browse?search='+encodeURIComponent(text.trim()));}}><Search size={19}/><input aria-label="Search anime" placeholder="Find your next story…" value={text} onFocus={()=>setOpen(true)} onChange={event=>{setText(event.target.value);setOpen(true);}} enterKeyHint="search" autoComplete="off"/>{text&&<button type="button" className="icon-btn" aria-label="Clear search" onClick={()=>setText('')}><X size={18}/></button>}
    {open&&text.trim().length>=2&&<><button type="button" className="tablet-search-dismiss" aria-label="Close search suggestions" onClick={()=>setOpen(false)}/><div className="tablet-search-results card">{query!==text.trim()||isFetching?<p className="faint">Searching…</p>:(data??[]).slice(0,6).map(media=><button type="button" key={media.id} onClick={()=>go('/anime/'+media.id)}>{media.cover&&<img src={media.cover} alt=""/>}<span>{titleOf(media,settings.appearance.titleLanguage)}<small>{media.format} · {media.seasonYear??'Year unknown'}</small></span></button>)}<button type="submit" className="tablet-search-all">See all results for “{text}”</button></div></>}
  </form>;
}
