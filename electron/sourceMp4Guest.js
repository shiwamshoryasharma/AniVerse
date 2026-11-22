(() => {
  const visible = node => node.clientWidth >= 160 && node.clientHeight >= 90 &&
    (node.checkVisibility?.({ checkOpacity:true, checkVisibilityCSS:true }) ?? !!node.getClientRects().length);
  const mark = document.querySelector('[data-aniverse-media]');
  if (mark instanceof HTMLIFrameElement && visible(mark)) return { frame:true };
  const videos = [...document.querySelectorAll('video')].filter(video => visible(video) &&
    video.readyState >= 2 && video.videoWidth && Number.isFinite(video.duration) && video.duration > 0);
  if (videos.length !== 1 || (mark && videos[0] !== mark)) return null;
  const video = videos[0], media = video.currentSrc;
  if (!media || media.length > 4096 || video.mediaKeys || video.srcObject) return null;
  // This state lives only in the native-owned isolated world.
  const state = globalThis.__avDownloadNodes ??= { document: crypto.randomUUID(), nodes: new WeakMap(), next: 0 };
  if (!state.nodes.has(video)) state.nodes.set(video, ++state.next);
  const identity = state.document + ':' + state.nodes.get(video);
  const plain = name => {
    try {
      const url = new URL(name);
      if (/^https?:$/.test(url.protocol) && !url.hash && !url.username && !url.password && name.length <= 4096) return url.href;
    } catch { /* Invalid references are not download candidates. */ }
    return null;
  };
  const direct = plain(media);
  const supported = direct && /\.(?:mp4|m3u8|ts|m2ts|mts|webm|mkv|mov|m4v|avi|mpg|mpeg|ogv|flv|wmv|3gp)$/i.test(new URL(direct).pathname);
  if (!media.startsWith('blob:') && !supported) return null;
  if (supported && !/\.m3u8$/i.test(new URL(direct).pathname)) return { identity, media, url:direct };

  // These are observations, not an ordered media list. Native code must find an
  // exact member of a finite playlist before transferring any media fragments.
  const resources = performance.getEntriesByType('resource').slice(-256).filter(entry =>
    ['video', 'fetch', 'xmlhttprequest'].includes(entry.initiatorType));
  const playlists = [], observations = [];
  const add = (list, value, limit) => { if (value && list.length < limit && !list.includes(value)) list.push(value); };
  if (supported) add(playlists, direct, 8);
  for (let index = resources.length - 1; index >= 0; index--) {
    const url = plain(resources[index].name);
    if (!url) continue;
    if (/\.m3u8$/i.test(new URL(url).pathname)) add(playlists, url, 8);
    else add(observations, url, 32);
  }
  if (!playlists.length || (media.startsWith('blob:') && !observations.length)) return null;
  let subtitle;
  const selected = [...(video.textTracks ?? [])].find(track => track.mode === 'showing' && ['subtitles','captions'].includes(track.kind));
  if (selected) {
    const element = [...video.querySelectorAll('track')].find(track => track.track === selected);
    const url = element && plain(element.src);
    subtitle = { ...(url ? { url } : {}), ...(selected.language ? { language:selected.language.slice(0,64) } : {}),
      ...(selected.label ? { label:selected.label.slice(0,128) } : {}) };
  }
  return { identity, media, url:playlists[0], playlists, observations, expectedDuration:video.duration, ...(subtitle ? { subtitle } : {}) };
})()
