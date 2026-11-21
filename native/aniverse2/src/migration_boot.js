(() => {
  if (window !== window.top || location.origin !== 'https://tauri.localhost') return;
  const verify = async () => {
    const [settings, sources, history, preferences] = await Promise.all([
      window.aniverse.invoke('settings.get'),
      window.aniverse.invoke('sources.list'),
      window.aniverse.invoke('library.history', { limit: 200, offset: 0 }),
      window.aniverse.invoke('migration.preferenceKeys'),
    ]);
    const expected = history.map(row => String(row.id)).sort();
    const entries = () => [...document.querySelectorAll('.history-page [data-history-id]')]
      .map(row => row.dataset.historyId).sort();
    const shellReady = () => document.querySelector('header.tauri-topbar') &&
      document.querySelector('.history-page') && JSON.stringify(entries()) === JSON.stringify(expected) &&
      (expected.length || document.querySelector('.history-page .state h3')?.textContent === 'Your next story starts here');
    for (let i = 0; i < 250 && !shellReady(); i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!shellReady()) return;
    const saved = Object.fromEntries(preferences.sort().map(key => [key, localStorage.getItem(key)]));
    const evidence = [settings.profile.name, sources.map(source => source.id).sort(), entries(), saved];
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(evidence)));
    await window.aniverse.invoke('migration.ready',
      [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''));
  };
  addEventListener('DOMContentLoaded', () => void verify().catch(() => {}), { once: true });
})();