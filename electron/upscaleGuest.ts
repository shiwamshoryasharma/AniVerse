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
  Object.assign(canvas.style, { position: 'fixed', pointerEvents: 'none', objectFit: 'contain', zIndex: '2' });
  video.parentElement?.append(canvas);
  const current: Session = { video, key, canvas, stop: () => undefined, state: { state: 'waiting', message: 'Starting Anime4K…' } };
  session = current;
  const position = () => { const r = video.getBoundingClientRect(); Object.assign(canvas.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' }); };
  position();
  const resize = new ResizeObserver(position); resize.observe(video);
  window.addEventListener('scroll', position, true); window.addEventListener('resize', position); document.addEventListener('fullscreenchange', position);
  const timer = window.setInterval(() => { if (!video.isConnected) stop(); else position(); }, 1000);
  const dispose = attachAnime4K(video, canvas, options, (state) => { current.state = state; });
  current.stop = () => { dispose(); resize.disconnect(); clearInterval(timer); window.removeEventListener('scroll', position, true); window.removeEventListener('resize', position); document.removeEventListener('fullscreenchange', position); };
  return current.state;
}
