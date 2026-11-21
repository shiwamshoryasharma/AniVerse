/// <reference lib="dom" />
import Hls from 'hls.js';

const style=document.createElement('style');
style.textContent='*{box-sizing:border-box}body{margin:0;background:#000;color:#eee;font:16px system-ui}video,.cast-picture{display:block;width:100vw;height:100vh;object-fit:contain}aside{position:absolute;inset:0;display:grid;place-content:center;text-align:center;padding:40px;background:#101218}h1{color:#a98bff}p{max-width:640px;line-height:1.7}body.playing aside{display:none}';
document.head.append(style);
const video=document.createElement('video'); video.controls=true; video.autoplay=true; video.playsInline=true;
const aside=document.createElement('aside');
aside.innerHTML='<h1>AniVerse · Chrome Cast</h1><p>Choose your TV in AniVerse. This window receives only the selected player. Keep AniVerse open while casting.</p><p>Google Chrome handles TV discovery and tab casting. Windows display resolution stays unchanged.</p>';
document.body.replaceChildren(video,aside);
let hls:Hls|null=null, live=false;
interface MirrorView {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  controller: AbortController;
  sequence: number;
  started: number;
  ended: boolean;
  phase: string;
  error?: string;
}
let mirrored: MirrorView | null = null;
const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 85));

function clearMirror() {
  if (!mirrored) return;
  mirrored.controller.abort();
  mirrored.canvas.remove();
  mirrored = null;
  video.style.display = '';
}

async function nextFrame(url: URL, state: MirrorView) {
  url.searchParams.set('after', String(state.sequence));
  state.phase = 'fetch';
  const signal = AbortSignal.any([state.controller.signal, AbortSignal.timeout(2500)]);
  const response = await fetch(url, { cache: 'no-store', signal });
  if (response.status === 204) return;
  if (!response.ok || response.headers.get('content-type') !== 'image/jpeg') throw new Error('The source capture stopped.');
  const sequence = Number(response.headers.get('x-frame-sequence'));
  if (!Number.isSafeInteger(sequence) || sequence <= state.sequence) throw new Error('Invalid capture frame.');
  state.phase = 'decode';
  const bitmap = await createImageBitmap(await response.blob());
  try {
    if (state.controller.signal.aborted) return;
    if (state.canvas.width !== bitmap.width || state.canvas.height !== bitmap.height) {
      state.canvas.width = bitmap.width;
      state.canvas.height = bitmap.height;
    }
    state.context.drawImage(bitmap, 0, 0);
    state.sequence = sequence;
    state.phase = 'rendered';
    document.body.classList.add('playing');
  } finally { bitmap.close(); }
}

function showMirror(input: {url:string; title:string}) {
  clearMirror();
  const url = new URL(input.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(location.pathname + 'mirror-')) {
    throw new Error('Invalid Chrome capture source.');
  }
  video.pause();
  video.style.display = 'none';
  document.title = input.title + ' · AniVerse Cast';
  const canvas = document.createElement('canvas');
  canvas.className = 'cast-picture';
  const context = canvas.getContext('2d', {alpha:false});
  if (!context) throw new Error('Chrome could not create the capture surface.');
  document.body.prepend(canvas);
  const state: MirrorView = {
    canvas, context, controller:new AbortController(), sequence:0, started:performance.now(), ended:false, phase:'ready',
  };
  mirrored = state;
  void (async () => {
    try {
      while (!state.controller.signal.aborted) {
        await nextFrame(url, state);
        if (!state.sequence && performance.now() - state.started > 7500) throw new Error('No source capture frame reached Chrome.');
        await wait();
      }
    } catch (error) {
      if (!state.controller.signal.aborted) {
        state.ended = true;
        state.error = error instanceof Error ? error.message : 'Website capture stopped.';
        state.canvas.remove();
      }
    }
  })();
  return status();
}

function status() {
  if (mirrored) return {mediaSessionId:1,playerState:mirrored.ended?'IDLE':mirrored.sequence?'PLAYING':'BUFFERING',
    ...(mirrored.ended?{idleReason:'FINISHED'}:{}),currentTime:(performance.now()-mirrored.started)/1000,
    media:{duration:0},volume:{level:0,muted:true},mirrorPhase:mirrored.phase,mirrorError:mirrored.error};
  return {mediaSessionId:1,playerState:video.ended?'IDLE':video.paused?'PAUSED':video.readyState<3?'BUFFERING':'PLAYING',
    ...(video.ended?{idleReason:'FINISHED'}:{}),currentTime:video.currentTime||0,
    media:{duration:Number.isFinite(video.duration)?video.duration:0},volume:{level:video.volume,muted:video.muted}};
}
const player={
  mirror: showMirror,
  async load(input:{url:string;title:string;startAt:number;live:boolean;hls?:boolean;tracks?:{trackContentId:string;name:string;language:string}[]}) {
    clearMirror();hls?.destroy();hls=null;video.pause();video.removeAttribute('src');video.replaceChildren();document.title=input.title+' · AniVerse Cast';live=input.live;
    const ready=new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>done(new Error('Chrome could not decode the stream. Try standard 1080p casting.')),30000);
      const loaded=()=>done();const failed=()=>done(new Error('Chrome cannot play this video codec. Try standard 1080p casting.'));
      const done=(error?:Error)=>{clearTimeout(timer);video.removeEventListener('loadeddata',loaded);video.removeEventListener('error',failed);if(error)reject(error);else resolve();};
      video.addEventListener('loadeddata',loaded,{once:true});video.addEventListener('error',failed,{once:true});
      if(input.hls || /\.m3u8(?:[?#]|$)/i.test(input.url)){
        if(!Hls.isSupported()){done(new Error('Chrome Media Source playback is unavailable.'));return;}
        hls=new Hls({enableWorker:false,lowLatencyMode:false,maxBufferLength:12,startPosition:input.live?-1:input.startAt});
        hls.on(Hls.Events.ERROR,(_,data)=>{if(data.fatal)done(new Error('Chrome could not load the cast stream: '+data.details));});
        hls.loadSource(input.url);hls.attachMedia(video);
      }else{video.src=input.url;if(input.startAt)video.currentTime=input.startAt;}
      for(const track of input.tracks??[]){const element=document.createElement('track');element.kind='subtitles';element.src=track.trackContentId;element.label=track.name;element.srclang=track.language;video.append(element);}
    });
    await ready;await video.play();document.body.classList.add('playing');return status();
  },
  async command(type:string,value?:number){
    if (mirrored) return status();
    if(type==='PLAY')await video.play();
    if(type==='PAUSE')video.pause();
    if(type==='SEEK'&&!live)video.currentTime=Math.max(0,value??0);
    if(type==='VOLUME')video.volume=Math.max(0,Math.min(1,value??1));
    return status();
  },
  manualChoice(){
    const banner=document.createElement('p');banner.id='cast-choice';banner.style.cssText='position:fixed;top:16px;left:16px;right:16px;margin:auto;padding:16px;background:#171a22ed;color:white;border:1px solid #a98bff;border-radius:12px;text-align:center;z-index:2';
    banner.textContent='Several TVs have the same name. Open Chrome’s Cast menu → Sources → Cast tab, then choose your TV. AniVerse is waiting for your choice.';
    document.querySelector('#cast-choice')?.remove();document.body.append(banner);
  },
  casting(){video.controls=false;document.querySelector('#cast-choice')?.remove();}
};
Object.assign(globalThis,{AniVerseChromePlayer:player});
