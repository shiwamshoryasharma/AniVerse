/// <reference lib="dom" />
import {
  ImageUpscaler, Anime4K_Clamp_Highlights, Anime4K_Restore_CNN_M, Anime4K_Restore_CNN_Soft_M,
  Anime4K_Upscale_CNN_x2_M, Anime4K_Upscale_Denoise_CNN_x2_M, Anime4K_Darken_Fast, Anime4K_Thin_Fast,
  Anime4K_Restore_CNN_S, Anime4K_Restore_CNN_Soft_S, Anime4K_Upscale_CNN_x2_S, Anime4K_Upscale_Denoise_CNN_x2_S,
  type Anime4KShaderConstructor,
} from 'anime4k.js';
import { freshUpscaleFrame } from './upscaleTiming';
import { lineEffectShader } from './lineEffects';
import { upscaleSize, type UpscaleSettings, type UpscaleStatus } from './upscale';

export function shaderConfig(options: UpscaleSettings, enlarge = true, inputHeight = 1080, lighter = false): Anime4KShaderConstructor[] {
  const result: Anime4KShaderConstructor[] = [Anime4K_Clamp_Highlights];
  const first = options.mode[0];
  const restore=lighter?Anime4K_Restore_CNN_S:Anime4K_Restore_CNN_M;
  const soft=lighter?Anime4K_Restore_CNN_Soft_S:Anime4K_Restore_CNN_Soft_M;
  const upscale=lighter?Anime4K_Upscale_CNN_x2_S:Anime4K_Upscale_CNN_x2_M;
  const denoise=lighter?Anime4K_Upscale_Denoise_CNN_x2_S:Anime4K_Upscale_Denoise_CNN_x2_M;
  if (first !== 'C' || !enlarge) result.push(first === 'B' ? soft : restore);
  if (enlarge) result.push(first === 'C' ? denoise : upscale);
  if (options.mode.includes('+')) result.push(options.mode === 'B+B' ? soft : restore);
  if (options.darken) result.push(lineEffectShader(Anime4K_Darken_Fast, inputHeight * (enlarge ? 2 : 1)));
  if (options.thin) result.push(lineEffectShader(Anime4K_Thin_Fast, inputHeight * (enlarge ? 2 : 1)));
  return result;
}

/** Filters the existing decoded element. Keeps its audio and media clock authoritative. */
export function attachAnime4K(video: HTMLVideoElement, canvas: HTMLCanvasElement, options: UpscaleSettings, report: (state: UpscaleStatus) => void): () => void {
  let stopped=false,handle=0,engine:ImageUpscaler|null=null;
  let dimensions='',inputDimensions='',lighter=false,lateFrames=0;
  const frameCallbacks=typeof video.requestVideoFrameCallback==='function';
  canvas.style.visibility='hidden';
  const disposeEngine=()=>{engine?.detachSource();engine=null;};
  const fail=(message:string)=>{stopped=true;disposeEngine();canvas.style.visibility='hidden';report({state:'unavailable',message});};
  const schedule=()=>{if(!stopped)handle=frameCallbacks?video.requestVideoFrameCallback(draw):requestAnimationFrame(draw);};
  const draw=(_now?:number,metadata?:VideoFrameCallbackMetadata)=>{
    if(stopped||!options.enabled)return;
    if(video.readyState>=2&&video.videoWidth){
      const mediaTime=metadata?.mediaTime??video.currentTime;
      try{
        const gl=canvas.getContext('webgl',{premultipliedAlpha:false,stencil:false,depth:false});
        if(!gl||!gl.getExtension('OES_texture_float')||!gl.getExtension('OES_texture_float_linear')||gl.isContextLost()){
          fail('Anime4K requires a working WebGL GPU with floating-point textures.');return;
        }
        gl.getExtension('WEBGL_color_buffer_float');
        const max=Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),size=upscaleSize(video.videoWidth,video.videoHeight,max);
        if(!size){schedule();return;}
        const input=video.videoWidth+'x'+video.videoHeight;
        if(!engine||input!==inputDimensions){
          disposeEngine();
          const enlarge=video.videoHeight<size.height;
          if(enlarge&&Math.max(video.videoWidth,video.videoHeight)*2>max){fail('This GPU cannot allocate the required Anime4K textures.');return;}
          engine=new ImageUpscaler(shaderConfig(options,enlarge,video.videoHeight,lighter));
          engine.attachSource(video,canvas);inputDimensions=input;
        }
        if(canvas.width!==size.width)canvas.width=size.width;
        if(canvas.height!==size.height)canvas.height=size.height;
        const started=performance.now();
        canvas.style.visibility='hidden';
        engine.upscale();
        // WebGL 1 has no portable fence. Completing one frame prevents an unbounded
        // GPU queue from showing old pictures while the original audio advances.
        gl.finish();
        if(gl.getError()!==gl.NO_ERROR){fail('The GPU could not process this video. Original playback continues.');return;}
        const renderMs=performance.now()-started,driftMs=(video.currentTime-mediaTime)*1000;
        if(!freshUpscaleFrame(renderMs,driftMs)){
          canvas.style.visibility='hidden';dimensions='';lateFrames++;
          if(lateFrames>=3){
            if(!lighter){lighter=true;lateFrames=0;disposeEngine();inputDimensions='';}
            else{fail('Upscaling paused because rendering is too slow. Original picture and audio continue.');return;}
          }
          report({state:'waiting',message:lighter?'Trying lighter processing to keep up with playback…':'Keeping the original picture while the GPU catches up…'});
          schedule();return;
        }
        lateFrames=0;canvas.style.visibility='visible';
        const label=size.width+' × '+size.height+(lighter?' · lighter processing':'');
        if(dimensions!==label){dimensions=label;report({state:'active',message:'Anime4K '+options.mode+' · '+label,...size});}
      }catch(error){
        fail(error instanceof DOMException&&error.name==='SecurityError'
          ?'This video blocks GPU pixel access (CORS or protected media). Original playback continues.'
          :'Anime4K could not process this video. Original playback continues.');
        return;
      }
    }
    schedule();
  };
  const lost=(event:Event)=>{event.preventDefault();fail('GPU context lost. Toggle Anime4K to retry.');};
  canvas.addEventListener('webglcontextlost',lost);
  report({state:options.enabled?'waiting':'off',message:options.enabled?'Waiting for a decoded video frame…':'Anime4K is off'});
  if(options.enabled)draw();
  return()=>{
    stopped=true;
    if(handle){if(frameCallbacks)video.cancelVideoFrameCallback(handle);else cancelAnimationFrame(handle);}
    canvas.removeEventListener('webglcontextlost',lost);disposeEngine();canvas.style.visibility='hidden';
  };
}
