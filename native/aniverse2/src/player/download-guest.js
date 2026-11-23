(() => {
  const visible = node => node.clientWidth >= 160 && node.clientHeight >= 90 &&
    (node.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? !!node.getClientRects().length);
  const mark = document.querySelector('[data-aniverse-media]');
  if (mark instanceof HTMLIFrameElement && visible(mark)) return { frame: true };

  const videos = [...document.querySelectorAll('video')].filter(video =>
    visible(video) && video.readyState >= 2 && video.videoWidth &&
    Number.isFinite(video.duration) && video.duration > 0);
  if (videos.length !== 1 || (mark && videos[0] !== mark)) return null;
  const video = videos[0], media = video.currentSrc;
  if (!media || media.length > 4096 || video.mediaKeys || video.srcObject) return null;

  // Private isolated-world state binds the actual video element and document.
  // Rolling request order, text-track discovery and playhead changes are evidence, not identity.
  const state = globalThis.__avDownloadNodes ??= { document: crypto.randomUUID(), nodes: new WeakMap(), next: 0 };
  if (!state.nodes.has(video)) state.nodes.set(video, ++state.next);
  const identity = state.document + ':' + state.nodes.get(video);

  const plain = name => {
    if (typeof name !== 'string' || name.length > 4096 || /[\u0000-\u001f\u007f]/.test(name)) return null;
    try {
      const url = new URL(name);
      if (/^https?:$/.test(url.protocol) && !url.hash && !url.username && !url.password) return url.href;
    } catch { /* Invalid references never become download evidence. */ }
    return null;
  };
  const text = (value, limit) => typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit) : '';
  const subtitleHint = () => {
    const dom = [...video.querySelectorAll('track')].filter(track =>
      ['subtitles', 'captions'].includes(track.kind || track.getAttribute('kind')));
    const selected = dom.find(track => track.track?.mode === 'showing');
    const active = selected?.track ?? [...(video.textTracks ?? [])].find(track => track.mode === 'showing');
    const fallback = !active ? dom.find(track => track.default) : undefined;
    const element = selected ?? fallback;
    const url = element && plain(element.src);
    // DOM tracks may be on their own public origin. Native transport independently
    // validates and pins that origin; HLS playlist children remain same-origin.
    const language = text(active?.language ?? element?.srclang, 64);
    const label = text(active?.label ?? element?.label, 128);
    if (url || language || label) return { ...(url ? { url } : {}), ...(language ? { language } : {}), ...(label ? { label } : {}) };
    return undefined;
  };
  const subtitle = subtitleHint();
  const direct = plain(media);
  if (!direct && !media.startsWith('blob:')) return null;
  const resources = performance.getEntriesByType('resource').filter(entry =>
    ['video', 'audio', 'fetch', 'xmlhttprequest', 'track'].includes(entry.initiatorType));
  const playlists = [], observations = [], seen = [];
  const add = (list, value, limit) => { if (list.length < limit && !list.includes(value)) list.push(value); };
  // Only the native response observer supplies MIME and request context. These
  // URLs let it intersect its records with this particular owned frame.
  for (let index = resources.length - 1; index >= 0; index--) {
    const url = plain(resources[index].name);
    if (!url) continue;
    add(seen, url, 48);
    if (/\.m3u8$/i.test(new URL(url).pathname)) add(playlists, url, 8);
    else add(observations, url, 32);
  }
  if (direct && /\.m3u8$/i.test(new URL(direct).pathname)) {
    const at = playlists.indexOf(direct);
    if (at >= 0) playlists.splice(at, 1);
    playlists.unshift(direct);
    playlists.length = Math.min(playlists.length, 8);
  }
  const url = direct ?? playlists[0] ?? seen[0];
  if (!url) return null;
  return {
    identity, media, expectedDuration: video.duration, url, playlists, observations,
    resources: seen, ...(subtitle ? { subtitle } : {}),
  };
})()
