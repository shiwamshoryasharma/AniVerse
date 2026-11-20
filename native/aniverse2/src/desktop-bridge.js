(() => {
  if (window !== window.top || location.origin !== 'https://tauri.localhost') return;
  const events = new Set([
    'sources.changed', 'cloudflare.status', 'sync.status', 'adblock.stats', 'app.notice',
    'site.status', 'cast.status', 'privacy.changed', 'player.captureEnded', 'update.status',
  ]);
  Object.defineProperty(window, 'aniverse', { value: Object.freeze({
    platform: 'win32',
    edition: 'aniverse2',
    async invoke(method, input) {
      try {
        return await window.__TAURI__.core.invoke('desktop_rpc', { method, input });
      } catch (failure) {
        const error = new Error(failure?.message ?? String(failure));
        error.code = failure?.code ?? 'internal';
        throw error;
      }
    },
    on(name, listener) {
      if (!events.has(name)) throw new Error('Unknown AniVerse event');
      const off = window.__TAURI__.event.listen('aniverse:' + name.replaceAll('.', '/'), ({ payload }) => listener(payload));
      return () => void off.then((unlisten) => unlisten()).catch(() => {});
    },
  }) });
})();
