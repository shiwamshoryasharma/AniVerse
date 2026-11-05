/* Playback metadata and fixed, reversible player presentation. No host bridge or credentials enter source frames. */
(() => {
  const key = '__aniversePlayingMediaV1';
  if (window[key]) return;
  const channel = 'aniverse-playing-media-v1';
  const focusChannel = 'aniverse-player-focus-v1';
  const focusCss = __ANIVERSE_FOCUS_CSS__;
  const send = console.debug.bind(console), stringify = JSON.stringify.bind(JSON);
  const prefix = __ANIVERSE_TELEMETRY_PREFIX__;
  const records = new Map(), states = new WeakMap(), protectedVideos = new WeakSet();
  let lastOwner = null, focused = null;
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
    // Every document retains its immediate owner; ancestors see only the opaque ID.
    keep(item, owner);
    if (window !== top) parent.postMessage({type:channel,item}, '*');
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
    publish(item,frame);
  }, true);
  const clearMarks = () => document.querySelectorAll('[data-aniverse-player],[data-aniverse-chain],[data-aniverse-media],[data-aniverse-media-chain]')
    .forEach(el => ['player','chain','media','media-chain'].forEach(name => el.removeAttribute('data-aniverse-'+name)));
  const videoTarget = video => {
    const vr=video.getBoundingClientRect(), area=Math.max(1,vr.width*vr.height);
    const fits=el => {
      if(!el || el===document.body || el===document.documentElement)return false;
      const r=el.getBoundingClientRect();
      return r.width>=vr.width*.95 && r.height>=vr.height*.95 && r.width*r.height<=area*1.45;
    };
    const library=video.closest('.jwplayer,.video-js,.plyr,.shaka-video-container,[data-vjs-player]');
    if(fits(library))return library;
    let fallback=video;
    for(let el=video.parentElement,depth=0;el&&depth<4&&fits(el);el=el.parentElement,depth++){
      if(el.querySelector('header,nav,aside,[role="banner"],[role="navigation"],[role="complementary"]'))break;
      if(fallback===video)fallback=el;
      // Keep the site's own Play/seek/quality buttons with the same-size video wrapper.
      if(el.querySelector('button,[role="button"],input[type="range"]'))return el;
    }
    return fallback;
  };
  const mark = (target, media) => {
    clearMarks();
    target.setAttribute('data-aniverse-player','');
    media.setAttribute('data-aniverse-media','');
    if(media!==target)for(let el=media.parentElement;el&&el!==target;el=el.parentElement)el.setAttribute('data-aniverse-media-chain','');
    const chain=[];
    for(let el=target.parentElement;el;el=el.parentElement){el.setAttribute('data-aniverse-chain','');chain.push(el);}
    let sheet=window.__aniverseTabletFocus;
    if(!sheet){sheet=new CSSStyleSheet();sheet.replaceSync(focusCss);window.__aniverseTabletFocus=sheet;}
    if(!document.adoptedStyleSheets.includes(sheet))document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet];
    return chain;
  };
  const fills = el => {
    const r=el.getBoundingClientRect();
    return Math.abs(r.left)<2 && Math.abs(r.top)<2 && Math.abs(r.width-innerWidth)<3 && Math.abs(r.height-innerHeight)<3;
  };
  const validToken = token => typeof token==='string' && /^[a-z0-9]{1,100}$/i.test(token);
  const child = state => state?.owner instanceof HTMLIFrameElement || state?.owner instanceof HTMLFrameElement;
  const intact = state => !!state && state.owner.isConnected && state.target.isConnected &&
    (state.target===state.owner || state.target.contains(state.owner));
  const release = () => {
    const old=focused;focused=null;
    if(child(old))old.owner.contentWindow?.postMessage({type:focusChannel,focus:false},'*');
    document.adoptedStyleSheets=document.adoptedStyleSheets.filter(sheet=>sheet!==window.__aniverseTabletFocus);
    delete window.__aniverseTabletFocus;
    clearMarks();
  };
  const reply = (state, ready) => {
    if(state.peer)state.peer.postMessage({type:focusChannel,id:state.id,request:state.parentRequest,ready},'*');
  };
  const refreshFocus = () => {
    const state=focused;
    if(!state)return false;
    if(!intact(state)){
      // A site can move the same video out of its old wrapper. Remove stale
      // ancestor rules before discovery, otherwise they hide its new parent.
      reply(state,false);release();return false;
    }
    // Marker replacement is presentation-only: no node is moved, cloned or reloaded.
    const chain=[];
    for(let el=state.target.parentElement;el;el=el.parentElement)chain.push(el);
    const moved=chain.length!==state.chain.length || chain.some((el,index)=>el!==state.chain[index]||!el.hasAttribute('data-aniverse-chain'));
    if(moved || !state.target.hasAttribute('data-aniverse-player') || !state.owner.hasAttribute('data-aniverse-media') ||
      !document.adoptedStyleSheets.includes(window.__aniverseTabletFocus))state.chain=mark(state.target,state.owner);
    const local=document.adoptedStyleSheets.includes(window.__aniverseTabletFocus) && fills(state.target) && fills(state.owner);
    if(child(state) && performance.now()-state.sent>350){
      state.sent=performance.now();
      state.owner.contentWindow?.postMessage({type:focusChannel,focus:true,id:state.id,request:state.request},'*');
    }
    const ready=local && (!child(state) || (state.childReady && performance.now()-state.childAt<2000));
    reply(state,ready);
    return ready;
  };
  const focus = (id, peer=null, parentRequest=null) => {
    if(!validToken(id))return false;
    if(focused && !intact(focused)){reply(focused,false);release();}
    if(focused?.id===id && intact(focused)){
      if(peer){focused.peer=peer;focused.parentRequest=parentRequest;}
      return refreshFocus();
    }
    const row=records.get(id);
    if(!row || performance.now()-row.at>=2500 || !row.owner?.isConnected || !visible(row.owner))return false;
    const owner=row.owner;
    if(!(owner instanceof HTMLVideoElement || owner instanceof HTMLIFrameElement || owner instanceof HTMLFrameElement))return false;
    if(window===top){
      const player=document.querySelector('[data-aniverse-player]');
      if(!player || !(player===owner||player.contains(owner)))return false;
    }
    release();
    const target=owner instanceof HTMLVideoElement?videoTarget(owner):owner;
    focused={id,owner,target,peer,parentRequest,request:Date.now().toString(36)+Math.random().toString(36).slice(2),sent:-Infinity,childReady:false,childAt:0};
    focused.chain=mark(target,owner);
    return refreshFocus();
  };
  addEventListener('message', event => {
    const data=event.data;
    if(!data || data.type!==focusChannel)return;
    // Commands contain only an opaque ownership ID and a bounded token. Never CSS,
    // selectors or addresses from another origin. Rules are native-injected above.
    if(window!==top && event.source===parent && data.focus===false){release();return;}
    if(window!==top && event.source===parent && data.focus===true && validToken(data.id) && validToken(data.request)){
      const ready=focus(data.id,parent,data.request);
      parent.postMessage({type:focusChannel,id:data.id,request:data.request,ready},'*');
      return;
    }
    const state=focused;
    if(child(state) && event.source===state.owner.contentWindow && data.id===state.id && data.request===state.request && typeof data.ready==='boolean'){
      state.childReady=data.ready;state.childAt=performance.now();refreshFocus();
    }
  },true);
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
    refreshFocus();
  };
  const read = () => {
    collect();
    const player=document.querySelector('[data-aniverse-player]');
    return [...records.values()].filter(row => performance.now() - row.at < 2500 && row.owner?.isConnected &&
      visible(row.owner) && (!player || player===row.owner || player.contains(row.owner))).map(row => row.item.id);
  };
  Object.defineProperty(window,key,{value:Object.freeze({read,focus:id=>window===top&&focus(id),focused:refreshFocus,release}),writable:false,configurable:false});
  setInterval(collect,500);
})();
