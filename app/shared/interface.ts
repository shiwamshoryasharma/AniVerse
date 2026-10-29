export const INTERFACE_STYLES = [
  { id: 'classic', layout: 'classic', name: 'Classic', label: 'Original compact workspace', description: 'Collapsible icon rail, compact discovery grids and side-by-side episode browsing.' },
  { id: 'aurora', layout: 'studio', name: 'Studio', label: 'Navigation and library workspace', description: 'Permanent labelled sidebar, dashboard navigation and an inspector-style episode list.' },
  { id: 'paper', layout: 'cinema', name: 'Cinema', label: 'A screen-first viewing layout', description: 'Horizontal top navigation, full-width playback and an episode shelf below the player.' },
] as const;
export function interfaceStyle(id: string) { return INTERFACE_STYLES.find((style) => style.id === id) ?? INTERFACE_STYLES[0]; }
