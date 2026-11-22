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
  if (direct && /\.mp4$/i.test(new URL(direct).pathname)) return { media, expectedDuration: video.duration, url: direct, ...(subtitle ? { subtitle } : {}) };
  if (!media.startsWith('blob:') && (!direct || !/\.m3u8$/i.test(new URL(direct).pathname))) return null;

  const resources = performance.getEntriesByType('resource').filter(entry =>
    ['video', 'fetch', 'xmlhttprequest'].includes(entry.initiatorType));
  const playlists = [], observations = [];
  const add = (list, value, limit) => { if (list.length < limit && !list.includes(value)) list.push(value); };
  // A filename or MIME label does not prove a resource is video. The worker must
  // match observations to the selected playlist and validate actual container bytes.
  for (let index = resources.length - 1; index >= 0; index--) {
    const url = plain(resources[index].name);
    if (!url) continue;
    if (/\.m3u8$/i.test(new URL(url).pathname)) add(playlists, url, 8);
    else add(observations, url, 32);
  }
  if (direct) {
    const at = playlists.indexOf(direct);
    if (at >= 0) playlists.splice(at, 1);
    playlists.unshift(direct);
    playlists.length = Math.min(playlists.length, 8);
  }
  if (!playlists.length || (!direct && !observations.length)) return null;
  return { media, expectedDuration: video.duration, url: playlists[0], playlists, observations, ...(subtitle ? { subtitle } : {}) };
})()
