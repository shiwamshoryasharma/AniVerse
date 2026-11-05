/* Read-only playback metadata observer. No host command object or credentials enter source frames. */
(() => {
  const key = '__aniversePlayingMediaV1';
  if (window[key]) return;
  const channel = 'aniverse-playing-media-v1';
  const send = console.debug.bind(console), stringify = JSON.stringify.bind(JSON);
  const prefix = __ANIVERSE_TELEMETRY_PREFIX__;
  const records = new Map(), states = new WeakMap(), protectedVideos = new WeakSet();
  let lastOwner = null;
  const visible = el => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width >= 64 && r.height >= 36 && r.bottom > 0 && r.right > 0 &&
      r.top < innerHeight && r.left < innerWidth && s.display !== 'none' &&
      s.visibility === 'visible' && Number(s.opacity) > 0 &&
      (!el.checkVisibility || el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
  };
  const keep = (item, owner) => {
    if (!item || typeof item.id !== 'string' || item.id.length > 100) return;
    if (!records.has(item.id) && records.size >= 16) records.delete(records.keys().next().value);
    records.set(item.id, {item, owner, at: performance.now()});
  };
  const publish = (item, owner) => {
    if (window === top) keep(item, owner);
    else parent.postMessage({type:channel,item}, '*');
  };
  const owned = frame => {
    const player = document.querySelector('[data-aniverse-player]');
    if (player) {
      const matches = player === frame || player.contains(frame);
      if (matches) lastOwner = frame.contentWindow;
      return matches;
    }
    return lastOwner === frame.contentWindow;
  };
  addEventListener('message', event => {
    const data = event.data;
    if (!data || data.type !== channel || !data.item || typeof data.item !== 'object') return;
    const frame = [...document.querySelectorAll('iframe,frame')].find(el => el.contentWindow === event.source);
    if (!frame || !visible(frame)) return;
    if (window === top && !owned(frame)) return;
    if(typeof data.item.id!=='string'||data.item.id.length>100)return;
    const item={id:data.item.id};
    if(window===top)keep(item,frame);else publish(item);
  }, true);
  document.addEventListener('encrypted', event => {
    if (event.target instanceof HTMLVideoElement) protectedVideos.add(event.target);
  }, true);
  const collect = () => {
    const player = document.querySelector('[data-aniverse-player]');
    let videos = [...document.querySelectorAll('video')];
    if (window === top) videos = videos.filter(v => player ? player === v || player.contains(v) : states.has(v));
    for (const video of videos.slice(0,8)) {
      let state = states.get(video);
      const src = video.currentSrc || video.src || '';
      if (!state || state.src !== src) {
        state = {id:Date.now().toString(36)+Math.random().toString(36).slice(2),src,last:video.currentTime,played:false,started:performance.now()};
        states.set(video,state);
      }
      if(video.currentTime < state.last - .5){state.played=false;state.started=performance.now();}
      if (!video.paused && video.readyState >= 2 && video.currentTime > state.last + .02) state.played = true;
      state.last = video.currentTime;
      const rect = video.getBoundingClientRect();
      const resources = performance.getEntriesByType('resource').filter(entry =>
        entry.startTime >= state.started - 8000 && /\.m3u8(?:[?#]|$)/i.test(entry.name))
        .slice(-16).map(entry => entry.name);
      const report={id:state.id,frameUrl:location.href,src,resources,position:video.currentTime,
        duration:Number.isFinite(video.duration)?video.duration:0,width:Math.round(rect.width),
        height:Math.round(rect.height),ready:video.readyState,played:state.played,
        visible:visible(video),encrypted:protectedVideos.has(video)||!!video.mediaKeys};
      let packet=stringify(report);
      while(new TextEncoder().encode(packet).byteLength>16000&&report.resources.length){report.resources.pop();packet=stringify(report);}
      if(new TextEncoder().encode(packet).byteLength<=16000)send(prefix+packet);
      // Parent documents receive only opaque ownership IDs, never a provider URL.
      publish({id:state.id},video);
    }
  };
  const read = () => {
    collect();
    const player=document.querySelector('[data-aniverse-player]');
    return [...records.values()].filter(row => performance.now() - row.at < 2500 && row.owner?.isConnected &&
      visible(row.owner) && (!player || player===row.owner || player.contains(row.owner))).map(row => row.item.id);
  };
  Object.defineProperty(window,key,{value:Object.freeze({read}),writable:false,configurable:false});
  setInterval(collect,500);
})();
