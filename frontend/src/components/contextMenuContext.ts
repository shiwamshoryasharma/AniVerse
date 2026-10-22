import { createContext, useContext, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  /** Keyboard shortcut shown on the right. */
  hint?: string;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
}

/** Optional header (e.g. the anime the menu is about). */
export interface MenuHeader {
  title: string;
  subtitle?: string;
  image?: string;
}

export interface ContextMenuApi {
  /** Opens the menu with these items (plus the generic navigation items). */
  open: (e: React.MouseEvent | MouseEvent, items: MenuItem[], header?: MenuHeader) => void;
}

export const ContextMenuContext = createContext<ContextMenuApi>({ open: () => undefined });

export const useContextMenu = () => useContext(ContextMenuContext);
