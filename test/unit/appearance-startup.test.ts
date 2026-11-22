import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mount = vi.hoisted(() => ({ snapshots: [] as { theme: string | undefined; header: string | undefined; pages: string | undefined }[] }));
vi.mock('react-dom/client', () => ({
  createRoot: () => ({ render: () => {
    const root = document.documentElement;
    mount.snapshots.push({ theme: root.dataset.aniverse2Theme, header: root.style.getPropertyValue('--av2-header'), pages: root.style.getPropertyValue('--av2-pages') });
  } }),
}));
vi.mock('react-router', () => ({ createHashRouter: () => ({}), RouterProvider: () => null }));
vi.mock('../../frontend/src/components/Shell', () => ({ Shell: () => null }));
vi.mock('../../frontend/src/components/common', () => ({ Spinner: () => null }));
vi.mock('../../frontend/src/components/RouteCrash', () => ({ RouteCrash: () => null }));
vi.mock('../../frontend/src/pages/Home', () => ({ HomePage: () => null }));
vi.mock('../../frontend/src/lib/toast', () => ({ ToastProvider: () => null }));
vi.mock('../../frontend/src/lib/bridge', () => ({ isAniVerse2: false, modernWindows: true }));

// Vitest transforms the renderer entrypoint separately from the Node-only test tsconfig.
const rendererEntrypoint = '../../frontend/src/main';

describe('saved appearance on desktop renderer startup', () => {
  let saved: Map<string, string>;
  let attributes: Set<string>;
  let properties: Map<string, string>;

  beforeEach(() => {
    vi.resetModules();
    mount.snapshots.length = 0;
    saved = new Map(); attributes = new Set(); properties = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => { saved.set(key, value); },
    });
    vi.stubGlobal('document', {
      documentElement: {
        dataset: {},
        toggleAttribute: (name: string, enabled: boolean) => { if (enabled) attributes.add(name); else attributes.delete(name); },
        style: {
          setProperty: (name: string, value: string) => properties.set(name, value),
          removeProperty: (name: string) => properties.delete(name),
          getPropertyValue: (name: string) => properties.get(name),
        },
      },
      getElementById: () => ({}),
    });
    vi.stubGlobal('MutationObserver', class { observe() {} });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it.each(['light', 'dark', 'vscode', 'wisteria'])('restores %s and custom layer colours before the first React mount without visiting Settings', async theme => {
    saved.set('aniverse2.palette', theme);
    saved.set('aniverse2.colours.v1', JSON.stringify({ header: '#234D73', pages: '#EEF4FF' }));
    await import(rendererEntrypoint);
    expect(mount.snapshots).toEqual([{ theme, header: '#234d73', pages: '#eef4ff' }]);
    expect(attributes.has('data-av2-header')).toBe(true);
    expect(attributes.has('data-av2-pages')).toBe(true);
  });

  it('keeps the existing Electron default without rewriting absent preferences', async () => {
    await import(rendererEntrypoint);
    expect(mount.snapshots[0]?.theme).toBe('legacy');
    expect(saved.size).toBe(0);
  });
});
