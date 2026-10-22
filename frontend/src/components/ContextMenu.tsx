import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, ClipboardPaste, Copy, RotateCw, Scissors, Settings } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { cx } from '../lib/format';
import { ContextMenuContext, type MenuHeader, type MenuItem } from './contextMenuContext';

interface OpenMenu {
  x: number;
  y: number;
  header: MenuHeader | null;
  items: MenuItem[];
}

const WIDTH = 252;

/** App-wide custom right-click menu (no browser default menu anywhere in the app). */
export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const refresh = useCallback(() => void qc.invalidateQueries(), [qc]);

  // The shortcuts shown in the menu work everywhere in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F5') {
        e.preventDefault();
        refresh();
      } else if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        navigate(-1);
      } else if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        navigate(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, refresh]);

  const generic = useCallback(
    (target: EventTarget | null): MenuItem[] => {
      const el = target instanceof HTMLElement ? target : null;
      const editable = el?.closest('input, textarea, [contenteditable="true"]') as HTMLInputElement | null;
      const selection = window.getSelection()?.toString() ?? '';
      const items: MenuItem[] = [];
      if (editable) {
        items.push(
          { label: 'Cut', icon: <Scissors size={15} />, hint: 'Ctrl X', onSelect: () => document.execCommand('cut'), disabled: !selection && !(editable.selectionEnd! > editable.selectionStart!) },
          { label: 'Copy', icon: <Copy size={15} />, hint: 'Ctrl C', onSelect: () => document.execCommand('copy') },
          {
            label: 'Paste',
            icon: <ClipboardPaste size={15} />,
            hint: 'Ctrl V',
            onSelect: () => {
              editable.focus();
              void navigator.clipboard.readText().then((t) => document.execCommand('insertText', false, t));
            },
          },
          { label: '', separator: true },
        );
      } else if (selection) {
        items.push({ label: 'Copy', icon: <Copy size={15} />, hint: 'Ctrl C', onSelect: () => void navigator.clipboard.writeText(selection) }, { label: '', separator: true });
      }
      items.push(
        { label: 'Back', icon: <ArrowLeft size={15} />, hint: 'Alt ←', onSelect: () => navigate(-1) },
        { label: 'Forward', icon: <ArrowRight size={15} />, hint: 'Alt →', onSelect: () => navigate(1) },
        { label: 'Refresh', icon: <RotateCw size={15} />, hint: 'F5', onSelect: refresh },
        { label: '', separator: true },
        { label: 'Settings', icon: <Settings size={15} />, onSelect: () => navigate('/settings') },
      );
      return items;
    },
    [navigate, refresh],
  );

  const open = useCallback(
    (e: React.MouseEvent | MouseEvent, items: MenuItem[], header?: MenuHeader) => {
      e.preventDefault();
      e.stopPropagation();
      const all = items.length ? [...items, { label: '', separator: true }, ...generic(e.target)] : generic(e.target);
      setActive(-1);
      setMenu({ x: e.clientX, y: e.clientY, header: header ?? null, items: all });
    },
    [generic],
  );

  // Fallback for everything that does not provide its own items.
  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      open(e, []);
    };
    window.addEventListener('contextmenu', onContext);
    return () => window.removeEventListener('contextmenu', onContext);
  }, [open]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof MouseEvent && box.current?.contains(e.target as Node)) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      const enabled = menu.items.map((it, i) => (!it.separator && !it.disabled ? i : -1)).filter((i) => i >= 0);
      if (e.key === 'Escape') setMenu(null);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const pos = enabled.indexOf(active);
        const nextPos = e.key === 'ArrowDown' ? (pos + 1) % enabled.length : (pos - 1 + enabled.length) % enabled.length;
        setActive(enabled[nextPos] ?? -1);
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        menu.items[active].onSelect?.();
        setMenu(null);
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu, active]);

  const api = useMemo(() => ({ open }), [open]);
  const height = menu ? menu.items.reduce((h, it) => h + (it.separator ? 9 : 34), menu.header ? 78 : 12) : 0;

  return (
    <ContextMenuContext.Provider value={api}>
      {children}
      {menu &&
        createPortal(
          <div
            ref={box}
            className="ctx-menu"
            role="menu"
            style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - WIDTH - 8)), top: Math.max(8, Math.min(menu.y, window.innerHeight - height - 8)), width: WIDTH }}
            onContextMenu={(e) => e.preventDefault()}
          >
            {menu.header && (
              <div className="ctx-head">
                {menu.header.image && <img src={menu.header.image} alt="" />}
                <div style={{ minWidth: 0 }}>
                  <div className="ctx-title clamp-2">{menu.header.title}</div>
                  {menu.header.subtitle && <div className="ctx-sub ellipsis">{menu.header.subtitle}</div>}
                </div>
              </div>
            )}
            {menu.items.map((it, i) =>
              it.separator ? (
                i > 0 && i < menu.items.length - 1 && !menu.items[i - 1].separator ? <div key={i} className="ctx-sep" /> : null
              ) : (
                <button
                  key={i}
                  role="menuitem"
                  disabled={it.disabled}
                  className={cx('ctx-item', i === active && 'active', it.danger && 'danger')}
                  onMouseEnter={() => setActive(i)}
                  // Keep focus (and the text selection) in the page while the menu is used.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setMenu(null);
                    it.onSelect?.();
                  }}
                >
                  <span className="ctx-icon">{it.icon}</span>
                  <span className="ctx-label">{it.label}</span>
                  {it.hint && <kbd className="ctx-hint">{it.hint}</kbd>}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </ContextMenuContext.Provider>
  );
}
