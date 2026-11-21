import { ArrowUpRight, BadgeCheck, Search, Sparkles, TrendingUp, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { onEvent } from '../lib/bridge';
import { cx, formatLabel, titleOf } from '../lib/format';
import { usePrivacy } from '../lib/privacy';
import { useSearch, useSettings } from '../lib/queries';
import { useCompletedResults, useSearchDiscovery } from '../lib/useSearchDiscovery';
import { Spinner } from './common';
import '../styles/desktop-search.css';

export function DesktopSearch() {
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listbox = useId();
  const navigate = useNavigate();
  const lang = useSettings().appearance.titleLanguage;
  const { data: privacy } = usePrivacy();
  const viewedId = Number(useLocation().pathname.match(/^\/(?:anime|watch)\/(\d+)(?:\/|$)/)?.[1]);
  const context = privacy?.privateMediaIds.includes(viewedId) ? { ...privacy, incognito: true } : privacy;
  const term = text.trim();
  const typing = term.length >= 2;
  const search = useSearch(open && typing && term === debounced ? debounced : '');
  const results = open && typing && term === debounced ? search.data ?? [] : [];
  const discovery = useSearchDiscovery(open && !term, context);
  const completed = useCompletedResults(results, context);
  const items = typing ? results : term ? [] : discovery.items;
  const pending = typing ? (term !== debounced || search.isFetching) : !term && discovery.pending;
  const selection = active === null ? (typing ? 0 : -1) : active;
  const selected = items[selection];
  const Icon = discovery.personalized ? Sparkles : TrendingUp;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(term), 320);
    return () => window.clearTimeout(timer);
  }, [term]);

  useEffect(() => {
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      setOpen(true);
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener('keydown', shortcut);
    const clearPrivate = onEvent('privacy.changed', () => {
      setText('');
      setDebounced('');
      setActive(null);
      setOpen(false);
    });
    return () => { window.removeEventListener('keydown', shortcut); clearPrivate(); };
  }, []);

  const close = () => { setOpen(false); setActive(null); };
  const viewAll = '/browse?search=' + encodeURIComponent(term);
  const go = (path: string) => { close(); input.current?.blur(); navigate(path); };
  const handleKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!items.length) return;
      event.preventDefault();
      const next = Math.max(-1, Math.min(items.length - 1, selection + (event.key === 'ArrowDown' ? 1 : -1)));
      setActive(next);
      document.getElementById(listbox + '-' + next)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      if (selected) go('/anime/' + selected.id);
      else if (term) go(viewAll);
    }
  };

  return <div className="search desktop-search" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}>
    <Search size={17} aria-hidden="true" />
    <input ref={input} className="input" placeholder="Search anime…" value={text} role="combobox"
      aria-label="Search anime" aria-controls={open ? listbox : undefined} aria-expanded={open} aria-autocomplete="list"
      aria-activedescendant={open && selected ? listbox + '-' + selection : undefined}
      onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onKeyDown={handleKeys}
      onChange={event => { setText(event.target.value); setActive(null); setOpen(true); }}
    />
    {text ? <button type="button" className="desktop-search-clear icon-btn" aria-label="Clear search"
      onClick={() => { setText(''); setDebounced(''); setActive(null); input.current?.focus(); }}><X size={14} /></button> : <kbd>Ctrl K</kbd>}
    {open && <div className="suggest desktop-search-popover">
      <div className="desktop-search-heading">
        {term ? <Search size={16} aria-hidden="true" /> : <Icon size={16} aria-hidden="true" />}
        <strong>{term ? 'Search results' : discovery.personalized ? 'For you' : 'Trending anime'}</strong>
        {pending && <Spinner size="sm" />}
      </div>
      <div id={listbox} role="listbox" aria-label={term ? 'Search results' : 'Anime suggestions'} aria-busy={pending}>
        {items.map((media, index) => {
          const title = titleOf(media, lang);
          const alternate = [media.title.romaji, media.title.english, media.title.native].find(name => name && name !== title);
          const info = typing ? [alternate, formatLabel(media.format), media.seasonYear, media.episodes ? media.episodes + ' eps' : null]
            : [media.genres.slice(0, 2).join(' · ') || formatLabel(media.format), media.seasonYear];
          return <div key={media.id} id={listbox + '-' + index} role="option" aria-selected={selection === index}
            className={cx('suggest-item', selection === index && 'active')}
            onMouseEnter={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => go('/anime/' + media.id)}>
            {media.cover && <img src={media.cover} loading="lazy" width={36} height={50} alt="" />}
            <div className="desktop-search-text">
              <strong className="ellipsis">{title}</strong>
              <span className="ellipsis faint">{info.filter(Boolean).join(' · ')}</span>
            </div>
            {completed.has(media.id) && <span className="chip ok desktop-search-completed"><BadgeCheck size={12} aria-hidden="true" /> Completed</span>}
          </div>;
        })}
      </div>
      {!pending && items.length === 0 && <div className="desktop-search-empty" role="status">
        {typing ? search.isError ? 'Search is temporarily unavailable.' : 'No matching titles.' : term ? 'Type at least two characters.' : 'Search for an anime by title.'}
      </div>}
      {typing && <button type="button" className="suggest-foot desktop-search-all" onClick={() => go(viewAll)}>View all results<ArrowUpRight size={13} aria-hidden="true" /></button>}
    </div>}
  </div>;
}
