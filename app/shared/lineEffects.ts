/// <reference lib="dom" />
import type { Anime4KShaderConstructor } from 'anime4k.js';
/** The pinned line shaders use integer max and uniform loop bounds, invalid in WebGL 1.
 * Specialize their Gaussian loop radius to the known MAIN height at program creation. */
export function webgl1LineShader(source:string,mainHeight:number):string {
  const sigma=source.match(/#define SPATIAL_SIGMA \(([\d.]+) \* float\(MAIN_size\.y\) \/ 1080\.0\)/);
  if(!sigma||!Number.isFinite(mainHeight)||mainHeight<=0)return source;
  const radius=Math.max(Math.ceil(Number(sigma[1])*mainHeight/1080*2),1);
  return source.replace(/#define KERNELSIZE[^\r\n]*/g,'#define KERNELSIZE '+(radius*2+1));
}
export function lineEffectShader(Base:Anime4KShaderConstructor,mainHeight:number):Anime4KShaderConstructor {
  return new Proxy(Base,{construct(Target,args){
    const gl=args[0] as WebGLRenderingContext;
    // Keep the correction local to the vendor line shader, without mutating WebGL globals.
    const context=new Proxy(gl,{get(target,key){
      if(key==='shaderSource')return(shader:WebGLShader,source:string)=>target.shaderSource(shader,webgl1LineShader(source,mainHeight));
      const value=Reflect.get(target,key,target);
      return typeof value==='function'?value.bind(target):value;
    }});
    return new Target(context);
  }});
}
