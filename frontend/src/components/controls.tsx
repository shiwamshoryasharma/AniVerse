import { Check, ChevronDown, Search } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../lib/format';

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

interface SelectProps<T extends string | number> {
  value: T | null;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  placeholder?: string;
  size?: 'sm' | 'md' | 'lg';
  width?: number | string;
  icon?: ReactNode;
  disabled?: boolean;
  /** Show a filter box (defaults to on for long lists). */
  searchable?: boolean;
  className?: string;
}

/** Fully custom select: themed trigger, popover listbox, hover, keyboard and type-ahead. */
export function Select<T extends string | number>({ value, options, onChange, ariaLabel, placeholder = 'Select…', size = 'md', width, icon, disabled, searchable, className }: SelectProps<T>) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [filter, setFilter] = useState('');
  const [pos, setPos] = useState<CSSProperties>({});
  const typed = useRef({ text: '', at: 0 });
  const current = options.find((o) => o.value === value) ?? null;
  const withSearch = searchable ?? options.length > 12;
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, filter]);

  const place = () => {
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const maxH = 320;
    const below = window.innerHeight - r.bottom - 8;
    const up = below < Math.min(maxH, 40 + options.length * 34) && r.top > below;
    setPos({
      left: Math.min(r.left, window.innerWidth - Math.max(r.width, 190) - 8),
      minWidth: Math.max(r.width, 190),
      maxHeight: Math.min(maxH, (up ? r.top : below) - 8),
      ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }),
    });
  };

  const openList = () => {
    if (disabled) return;
    place();
    setFilter('');
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const choose = (o: SelectOption<T> | undefined) => {
    if (!o || o.disabled) return;
    onChange(o.value);
    close();
  };

  useLayoutEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) close(false);
    };
    const onScroll = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) close(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', place);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        openList();
      }
      return;
    }
    const move = (to: number) => {
      e.preventDefault();
      setActive(Math.max(0, Math.min(shown.length - 1, to)));
    };
    if (e.key === 'ArrowDown') move(active + 1);
    else if (e.key === 'ArrowUp') move(active - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(shown.length - 1);
    else if (e.key === 'Enter' || (e.key === ' ' && !withSearch)) {
      e.preventDefault();
      choose(shown[active]);
    } else if (e.key === 'Escape' || e.key === 'Tab') close(e.key === 'Escape');
    else if (!withSearch && e.key.length === 1) {
      // Type-ahead: jump to the first option starting with the typed letters.
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + e.key.toLowerCase(), at: now };
      const i = shown.findIndex((o) => o.label.toLowerCase().startsWith(typed.current.text));
      if (i >= 0) setActive(i);
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-haspopup="listbox"
        disabled={disabled}
        className={cx('select-trigger', size, open && 'open', !current && 'empty', className)}
        style={width !== undefined ? { width } : undefined}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKey}
      >
        {icon}
        <span className="select-value">{current?.label ?? placeholder}</span>
        <ChevronDown size={14} className="select-chevron" />
      </button>
      {open &&
        createPortal(
          <div ref={list} id={`${id}-list`} className="select-pop" style={pos} role="listbox" aria-label={ariaLabel} onKeyDown={onKey}>
            {withSearch && (
              <div className="select-filter">
                <Search size={13} />
                <input
                  autoFocus
                  value={filter}
                  placeholder="Filter…"
                  onChange={(e) => {
                    setFilter(e.target.value);
                    setActive(0);
                  }}
                  aria-label={`Filter ${ariaLabel}`}
                />
              </div>
            )}
            <div className="select-options">
              {shown.length === 0 && <div className="select-empty">No matches</div>}
              {shown.map((o, i) => (
                <div
                  key={String(o.value)}
                  role="option"
                  aria-selected={o.value === value}
                  aria-disabled={o.disabled}
                  data-active={i === active}
                  className={cx('select-option', o.value === value && 'selected', i === active && 'active', o.disabled && 'disabled')}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(o)}
                >
                  <span className="grow ellipsis">{o.label}</span>
                  {o.hint && <span className="select-hint">{o.hint}</span>}
                  {o.value === value && <Check size={14} />}
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export function Checkbox({ checked, onChange, label, disabled, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; hint?: string }) {
  return (
    <label className={cx('check', checked && 'on', disabled && 'disabled')} title={hint}>
      <input type="checkbox" className="sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="check-box" aria-hidden>
        <Check size={12} strokeWidth={3.2} />
      </span>
      <span className="check-label">{label}</span>
    </label>
  );
}

export function RadioGroup<T extends string | number>({
  value,
  options,
  onChange,
  name,
  direction = 'row',
}: {
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  name: string;
  direction?: 'row' | 'column';
}) {
  return (
    <div className={cx('radio-group', direction)} role="radiogroup" aria-label={name}>
      {options.map((o) => (
        <label key={String(o.value)} className={cx('radio', o.value === value && 'on', o.disabled && 'disabled')}>
          <input type="radio" className="sr-only" name={name} checked={o.value === value} disabled={o.disabled} onChange={() => onChange(o.value)} />
          <span className="radio-dot" aria-hidden />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

/** Themed range slider (track fill follows the value). */
export function Range({ value, min = 0, max = 1, step = 0.01, onChange, ariaLabel, width }: { value: number; min?: number; max?: number; step?: number; onChange: (v: number) => void; ariaLabel: string; width?: number | string }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <input
      type="range"
      className="range"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={ariaLabel}
      style={{ '--fill': `${pct}%`, width } as CSSProperties}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}
