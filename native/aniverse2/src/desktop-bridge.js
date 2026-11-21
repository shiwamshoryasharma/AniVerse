(() => {
  if (window !== window.top || location.origin !== 'https://tauri.localhost') return;
  const events = new Set([
    'sources.changed', 'cloudflare.status', 'sync.status', 'adblock.stats', 'app.notice',
    'site.status', 'cast.status', 'privacy.changed', 'player.captureEnded', 'update.status',
  ]);
  const nativeWindow = () => window.__TAURI__.window.getCurrentWindow();
  Object.defineProperty(window, 'aniverse', { value: Object.freeze({
    platform: 'win32',
    edition: 'aniverse2',
    releasePlayerFile(url) {
      return window.aniverse.invoke('player.releaseFile', { url });
    },
    saveMp4(url, sourceId) {
      return window.aniverse.invoke('player.saveMp4', { url, sourceId });
    },
    saveSiteMp4(webContentsId) {
      return window.aniverse.invoke('site.surface', { action: 'downloadMedia', webContentsId, save: true });
    },
    onMp4Progress(listener) {
      const off = window.__TAURI__.event.listen('aniverse:mp4/progress', ({ payload }) => listener(payload));
      return () => void off.then((unlisten) => unlisten()).catch(() => {});
    },
    hoverSourceAudio(sourceId, mediaId) {
      return window.aniverse.invoke('sources.hoverAudio', { sourceId, mediaId });
    },
    windowControls: Object.freeze({
      minimize: () => nativeWindow().minimize(),
      toggleMaximize: () => nativeWindow().toggleMaximize(),
      isMaximized: () => nativeWindow().isMaximized(),
      close: () => nativeWindow().close(),
    }),
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
