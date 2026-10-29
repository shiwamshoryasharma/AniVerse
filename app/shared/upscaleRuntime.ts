/// <reference lib="dom" />
import {
  ImageUpscaler, Anime4K_Clamp_Highlights, Anime4K_Restore_CNN_M, Anime4K_Restore_CNN_Soft_M,
  Anime4K_Upscale_CNN_x2_M, Anime4K_Upscale_Denoise_CNN_x2_M, Anime4K_Darken_Fast, Anime4K_Thin_Fast,
  type Anime4KShaderConstructor,
} from 'anime4k.js';
import { upscaleSize, type UpscaleSettings, type UpscaleStatus } from './upscale';

export function shaderConfig(options: UpscaleSettings, enlarge = true): Anime4KShaderConstructor[] {
  const result: Anime4KShaderConstructor[] = [Anime4K_Clamp_Highlights];
  const first = options.mode[0];
  if (first !== 'C' || !enlarge) result.push(first === 'B' ? Anime4K_Restore_CNN_Soft_M : Anime4K_Restore_CNN_M);
  if (enlarge) result.push(first === 'C' ? Anime4K_Upscale_Denoise_CNN_x2_M : Anime4K_Upscale_CNN_x2_M);
  if (options.mode.includes('+')) result.push(options.mode === 'B+B' ? Anime4K_Restore_CNN_Soft_M : Anime4K_Restore_CNN_M);
  if (options.darken) result.push(Anime4K_Darken_Fast);
  if (options.thin) result.push(Anime4K_Thin_Fast);
  return result;
}

/** Filters the existing decoded element. Never fetches, records, or extracts its URL. */
export function attachAnime4K(video: HTMLVideoElement, canvas: HTMLCanvasElement, options: UpscaleSettings, report: (state: UpscaleStatus) => void): () => void {
  let stopped = false, handle = 0, engine: ImageUpscaler | null = null;
  let dimensions = '', inputDimensions = '';
  const frameCallbacks = typeof video.requestVideoFrameCallback === 'function';
  canvas.style.visibility = 'hidden';
  const disposeEngine = () => { engine?.detachSource(); engine = null; };
  const fail = (message: string) => {
    stopped = true; disposeEngine(); canvas.style.visibility = 'hidden'; report({ state: 'unavailable', message });
  };
  const draw = () => {
    if (stopped || !options.enabled) return;
    if (video.readyState >= 2 && video.videoWidth) {
      try {
        const gl = canvas.getContext('webgl', { premultipliedAlpha: false, stencil: false, depth: false });
        if (!gl || !gl.getExtension('OES_texture_float') || !gl.getExtension('OES_texture_float_linear') || gl.isContextLost()) {
          fail('Anime4K requires a working WebGL GPU with floating-point textures.'); return;
        }
        gl.getExtension('WEBGL_color_buffer_float');
        const max = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
        const size = upscaleSize(video.videoWidth, video.videoHeight, max);
        if (!size) return;
        const input = video.videoWidth + 'x' + video.videoHeight;
        if (!engine || input !== inputDimensions) {
          disposeEngine();
          const enlarge = video.videoHeight < size.height;
          if (enlarge && Math.max(video.videoWidth, video.videoHeight) * 2 > max) { fail('This GPU cannot allocate the required Anime4K textures.'); return; }
          engine = new ImageUpscaler(shaderConfig(options, enlarge));
          engine.attachSource(video, canvas);
          inputDimensions = input;
        }
        if (canvas.width !== size.width) canvas.width = size.width;
        if (canvas.height !== size.height) canvas.height = size.height;
        engine.upscale();
        if (gl.getError() !== gl.NO_ERROR) { fail('The GPU could not process this video. Original playback continues.'); return; }
        const label = size.width + ' × ' + size.height;
        if (dimensions !== label) { dimensions = label; report({ state: 'active', message: 'Anime4K ' + options.mode + ' · ' + label, ...size }); }
      } catch (error) {
        fail(error instanceof DOMException && error.name === 'SecurityError'
          ? 'This video blocks GPU pixel access (CORS or protected media). Original playback continues.'
          : 'Anime4K could not process this video. Original playback continues.');
        return;
      }
    }
    if (!stopped) handle = frameCallbacks ? video.requestVideoFrameCallback(draw) : requestAnimationFrame(draw);
  };
  const lost = (event: Event) => { event.preventDefault(); fail('GPU context lost. Toggle Anime4K to retry.'); };
  canvas.addEventListener('webglcontextlost', lost);
  report({ state: options.enabled ? 'waiting' : 'off', message: options.enabled ? 'Waiting for a decoded video frame…' : 'Anime4K is off' });
  if (options.enabled) draw();
  return () => {
    stopped = true;
    if (handle) { if (frameCallbacks) video.cancelVideoFrameCallback(handle); else cancelAnimationFrame(handle); }
    canvas.removeEventListener('webglcontextlost', lost); disposeEngine();
    canvas.style.visibility = 'hidden';
    // Shader resources are released above. The same canvas may be reused after PiP/cast or a settings change.
  };
}
