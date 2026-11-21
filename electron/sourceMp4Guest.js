(() => {
  const visible = (node) => node.clientWidth >= 160 && node.clientHeight >= 90 &&
    (node.checkVisibility?.({ checkOpacity:true, checkVisibilityCSS:true }) ?? !!node.getClientRects().length);
  const mark = document.querySelector('[data-aniverse-media]');
  if (mark instanceof HTMLIFrameElement && visible(mark)) return { frame:true };

  const videos = [...document.querySelectorAll('video')].filter(video =>
    visible(video) && video.readyState >= 2 && video.videoWidth &&
    Number.isFinite(video.duration) && video.duration > 0);
  if (videos.length !== 1 || (mark && videos[0] !== mark)) return null;
  const video = videos[0];
  const media = video.currentSrc;
  if (!media || media.length > 4096 || video.mediaKeys || video.srcObject) return null;

  const plain = (name, extensions) => {
    try {
      const url = new URL(name);
      if (/^https?:$/.test(url.protocol) && !url.search && !url.hash && !url.username && !url.password &&
          name.length < 4096 && extensions.test(url.pathname)) return url.href;
    } catch { /* skip invalid media references */ }
    return null;
  };
  const direct = plain(media, /\.(?:mp4|m3u8)$/i);
  if (direct) return { media, url:direct };
  if (!media.startsWith('blob:')) return null;

  // Pair the last fetched fragment with the most recent same-origin playlist that
  // preceded it. Rust verifies the fragment is actually listed before downloading.
  const resources = performance.getEntriesByType('resource').filter(entry =>
    ['video', 'fetch', 'xmlhttprequest'].includes(entry.initiatorType));
  for (let index = resources.length - 1; index >= 0; index--) {
    const observed = plain(resources[index].name, /\.(?:ts|m4s|cmfv)$/i);
    if (!observed) continue;
    const origin = new URL(observed).origin;
    for (let item = index - 1; item >= 0; item--) {
      const url = plain(resources[item].name, /\.m3u8$/i);
      if (url && new URL(url).origin === origin) return { media, url, observed };
    }
    return null;
  }
  return null;
})()
