import { isAniVerse2 } from './bridge';
import { setMidnightTheme } from './desktopTheme';

export const appearanceThemes = [
  { id: 'dark', name: 'Dark', color: '#b59cfa', surface: '#181b22', detail: 'Charcoal with violet accents' },
  { id: 'light', name: 'Light', color: '#2458b3', surface: '#ffffff', detail: 'Soft white with blue accents' },
  { id: 'github-dimmed', name: 'GitHub Dimmed', color: '#8dc2ff', surface: '#2d333b', detail: 'Muted slate and soft blue' },
  { id: 'vscode', name: 'VS Code Dark+', color: '#70b5ed', surface: '#292929', detail: 'Editor gray and blue' },
  { id: 'ion', name: 'Ion', color: '#66dcf9', surface: '#16213c', detail: 'Cyan on midnight blue' },
  { id: 'copper', name: 'Copper', color: '#f6ac78', surface: '#2a201c', detail: 'Warm amber and soft edges' },
  { id: 'wisteria', name: 'Wisteria', color: '#d7b2ff', surface: '#281f39', detail: 'Lavender glass and round controls' },
  { id: 'verdant', name: 'Verdant', color: '#84e7af', surface: '#162c2b', detail: 'Jade, moss and deep teal' },
  { id: 'nocturne', name: 'Nocturne', color: '#ff91bd', surface: '#261b2a', detail: 'Rose highlights on ink black' },
  { id: 'legacy', name: 'Original colours', color: '#ff7a1a', surface: '#151922', detail: 'Colours from the current layout' },
] as const;

export const colourLayers = [
  { id: 'header', name: 'Header', token: '--bg-2', fallback: '#111a30' },
  { id: 'navigation', name: 'Navigation', token: '--bg-2', fallback: '#111a30' },
  { id: 'sidebar', name: 'Sidebar', token: '--surface', fallback: '#16213c' },
  { id: 'pages', name: 'Pages', token: '--bg', fallback: '#0a1020' },
  { id: 'cards', name: 'Cards', token: '--surface', fallback: '#16213c' },
  { id: 'buttons', name: 'Buttons', token: '--accent', fallback: '#66dcf9' },
  { id: 'icons', name: 'Icons', token: '--accent', fallback: '#66dcf9' },
  { id: 'menu', name: 'Floating menus', token: '--surface-2', fallback: '#1d2b4c' },
] as const;

export const colourSwatches = [
  { name: 'Ink', value: '#172036' }, { name: 'Ocean', value: '#234d73' },
  { name: 'Turquoise', value: '#249985' }, { name: 'Pine', value: '#235243' },
  { name: 'Indigo', value: '#49408f' }, { name: 'Lilac', value: '#b09ae0' },
  { name: 'Rose', value: '#c44575' }, { name: 'Copper', value: '#ab673e' },
  { name: 'Mist', value: '#aebdcb' }, { name: 'Snow', value: '#eef4ff' },
] as const;

export type AppearanceTheme = (typeof appearanceThemes)[number]['id'];
export type ColourLayer = (typeof colourLayers)[number]['id'];
type LayerColours = Partial<Record<ColourLayer, string>>;

const THEME_KEY = 'aniverse2.palette';
const COLOUR_KEY = 'aniverse2.colours.v1';
const DEFAULT_THEME: AppearanceTheme = 'ion';

function hex(value: unknown) {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : undefined;
}
function read(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Allow in-session changes if storage is unavailable. */ }
}
function storedColours(): LayerColours {
  const raw = read(COLOUR_KEY);
  if (!raw || raw.length > 500) return {};
  try {
    const saved: unknown = JSON.parse(raw);
    if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return {};
    const clean: LayerColours = {};
    for (const { id } of colourLayers) {
      const colour = hex((saved as Record<string, unknown>)[id]);
      if (colour) clean[id] = colour;
    }
    return clean;
  } catch { return {}; }
}

const rgb = (colour: string) => [1, 3, 5].map(at => Number.parseInt(colour.slice(at, at + 2), 16));
const luminance = (colour: string) => rgb(colour).map(value => value / 255).reduce((sum, value, index) =>
  sum + [0.2126, 0.7152, 0.0722][index] * (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4), 0);

export function colourInk(background: string) {
  return luminance(background) >= 0.179 ? '#000000' : '#ffffff';
}
function readableColour(colour: string, surface: string) {
  const background = luminance(surface);
  const ratio = (foreground: string) => {
    const light = luminance(foreground);
    return (Math.max(light, background) + 0.05) / (Math.min(light, background) + 0.05);
  };
  if (ratio(colour) >= 4.5) return colour;
  const original = rgb(colour);
  const contrast = colourInk(surface);
  const endpoint = contrast === '#ffffff' ? 255 : 0;
  for (const amount of [0.25, 0.5, 0.75]) {
    const adjusted = '#' + original.map(channel =>
      Math.round(channel + (endpoint - channel) * amount).toString(16).padStart(2, '0')).join('');
    if (ratio(adjusted) >= 4.5) return adjusted;
  }
  return contrast;
}

function applyIconContrast(root: HTMLElement, colours: LayerColours) {
  const selectedIcon = colours.icons;
  const computed = selectedIcon ? getComputedStyle(root) : undefined;
  for (const { id, token, fallback } of colourLayers) {
    if (id === 'icons') continue;
    const property = '--av2-icon-on-' + id;
    if (selectedIcon) {
      const surface = colours[id] ?? hex(computed?.getPropertyValue(token).trim()) ?? fallback;
      root.style.setProperty(property, readableColour(selectedIcon, surface));
    } else {
      root.style.removeProperty(property);
    }
  }
  if (selectedIcon) {
    root.style.setProperty('--av2-icon-on-player', readableColour(selectedIcon, '#101218'));
  } else {
    root.style.removeProperty('--av2-icon-on-player');
  }
}

const semantic = { ok: '#3ddc97', warn: '#ffc94d', err: '#ff5d6c', info: '#5aa9ff' };
let applied: LayerColours = {};

function applyAppearance(theme: AppearanceTheme, colours: LayerColours) {
  if (!isAniVerse2) return;
  const root = document.documentElement;
  root.dataset.aniverse2Theme = theme;
  root.toggleAttribute('data-av2-custom', Object.keys(colours).length > 0);
  for (const { id } of colourLayers) {
    const colour = colours[id];
    if (applied[id] === colour) continue;
    root.toggleAttribute('data-av2-' + id, Boolean(colour));
    const tokens = colour ? {
      '': colour,
      '-ink': colourInk(colour),
      '-edge': colourInk(colour) === '#ffffff' ? '#000000' : '#ffffff',
      ...Object.fromEntries(Object.entries(semantic).map(([name, value]) => ['-' + name, readableColour(value, colour)])),
    } : {};
    for (const suffix of ['', '-ink', '-edge', '-ok', '-warn', '-err', '-info']) {
      const value = tokens[suffix as keyof typeof tokens];
      const property = '--av2-' + id + suffix;
      if (value) root.style.setProperty(property, value);
      else root.style.removeProperty(property);
    }
  }
  applyIconContrast(root, colours);
  applied = colours;
}
const savedTheme = isAniVerse2 ? read(THEME_KEY) : null;
const activeTheme = appearanceThemes.find(theme => theme.id === savedTheme)?.id ??
  (isAniVerse2 && read('aniverse.desktop-theme') === 'midnight' ? 'legacy' : DEFAULT_THEME);
let state = { theme: activeTheme, colours: isAniVerse2 ? storedColours() : {} as LayerColours };
applyAppearance(state.theme, state.colours);
if (isAniVerse2) {
  const root = document.documentElement;
  new MutationObserver(() => {
    if (state.colours.icons) applyIconContrast(root, state.colours);
  }).observe(root, { attributes: true, attributeFilter: ['data-style', 'data-accent', 'data-desktop-theme', 'data-layout'] });
}
const listeners = new Set<() => void>();

export function subscribeAppearance(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getAppearance() { return state; }
function updateAppearance(theme: AppearanceTheme, colours: LayerColours) {
  state = { theme, colours };
  applyAppearance(theme, colours);
  for (const listener of listeners) listener();
}
export function selectAppearanceTheme(theme: AppearanceTheme) {
  if (read('aniverse.desktop-theme') === 'midnight') setMidnightTheme(false);
  save(THEME_KEY, theme);
  updateAppearance(theme, state.colours);
}
export function changeLayerColour(layer: ColourLayer, colour?: string) {
  const next = colour ? hex(colour) : undefined;
  if (state.colours[layer] === next || (colour && !next)) return;
  const colours = { ...state.colours };
  if (next) colours[layer] = next;
  else delete colours[layer];
  save(COLOUR_KEY, JSON.stringify(colours));
  updateAppearance(state.theme, colours);
}
export function resetAppearance() {
  if (read('aniverse.desktop-theme') === 'midnight') setMidnightTheme(false);
  save(THEME_KEY, DEFAULT_THEME);
  save(COLOUR_KEY, '{}');
  updateAppearance(DEFAULT_THEME, {});
}

export function defaultLayerColour(layer: ColourLayer) {
  const match = colourLayers.find(entry => entry.id === layer)!;
  return hex(getComputedStyle(document.documentElement).getPropertyValue(match.token).trim()) ?? match.fallback;
}
