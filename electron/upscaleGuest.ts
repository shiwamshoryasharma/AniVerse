/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { attachAnime4K } from '../app/shared/upscaleRuntime';
import { upscaleSchema, type UpscaleSettings, type UpscaleStatus } from '../app/shared/upscale';
interface Session { video: HTMLVideoElement; key: string; canvas: HTMLCanvasElement; stop: () => void; state: UpscaleStatus }
let session: Session | null = null;
export function stop() { session?.stop(); session?.canvas.remove(); session = null; }
export function apply(input: UpscaleSettings): UpscaleStatus {
  const options = upscaleSchema.parse(input);
  if (!options.enabled) { stop(); return { state: 'off', message: 'Anime4K is off' }; }
  const marked = document.querySelector('[data-aniverse-player]');
  const video = [...document.querySelectorAll('video')].filter((v) => v.readyState >= 2 && v.videoWidth > 0 &&
    (!marked || marked === v || marked.contains(v)) && v.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && v.getBoundingClientRect().width > 0)
    .sort((a, b) => Number(b.duration >= 60) - Number(a.duration >= 60) || Number(!b.paused) - Number(!a.paused) || b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
  if (!video) { stop(); return { state: 'waiting', message: 'Waiting for a compatible website video…' }; }
  const key = JSON.stringify(options);
  if (session?.video === video && session.key === key) return session.state;
  stop();
  const canvas = document.createElement('canvas');
  canvas.dataset.aniverseUpscale = '';
  Object.assign(canvas.style, { position: 'absolute', pointerEvents: 'none', objectFit: 'contain', zIndex: '2', margin: '0', padding: '0', border: '0', transform: 'none' });
  video.parentElement?.append(canvas);
  const current: Session = { video, key, canvas, stop: () => undefined, state: { state: 'waiting', message: 'Starting Anime4K…' } };
  session = current;
  const position = () => {
    // Use the overlay's actual containing block, including transformed player wrappers.
    // Viewport coordinates on a fixed child are incorrect inside such wrappers.
    canvas.style.left='0px';canvas.style.top='0px';canvas.style.width='0px';canvas.style.height='0px';
    const origin=canvas.getBoundingClientRect(), r=video.getBoundingClientRect();
    const parent=canvas.offsetParent as HTMLElement|null;
    const bounds=parent?.getBoundingClientRect();
    const sx=parent&&bounds&&parent.offsetWidth?bounds.width/parent.offsetWidth:1;
    const sy=parent&&bounds&&parent.offsetHeight?bounds.height/parent.offsetHeight:1;
    Object.assign(canvas.style,{left:(r.left-origin.left)/(sx||1)+'px',top:(r.top-origin.top)/(sy||1)+'px',
      width:r.width/(sx||1)+'px',height:r.height/(sy||1)+'px'});
  };
  position();
  const resize = new ResizeObserver(position); resize.observe(video);
  window.addEventListener('scroll', position, true); window.addEventListener('resize', position); document.addEventListener('fullscreenchange', position);
  const timer = window.setInterval(() => { if (!video.isConnected) stop(); else position(); }, 1000);
  const dispose = attachAnime4K(video, canvas, options, (state) => { current.state = state; });
  current.stop = () => { dispose(); resize.disconnect(); clearInterval(timer); window.removeEventListener('scroll', position, true); window.removeEventListener('resize', position); document.removeEventListener('fullscreenchange', position); };
  return current.state;
}
