import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { webgl1LineShader } from '../../app/shared/lineEffects';
it('specializes the vendor line-effect loop bound to a WebGL 1 constant integer',()=>{
  const source='#define SPATIAL_SIGMA (0.5 * float(MAIN_size.y) / 1080.0)\n#define KERNELSIZE (max(int(ceil(SPATIAL_SIGMA * 2.0)), 1) * 2 + 1)\nfor (int i=0; i<KERNELSIZE; i++) {}';
  expect(webgl1LineShader(source,2160)).toContain('#define KERNELSIZE 5');
  expect(webgl1LineShader(source,1080)).toContain('#define KERNELSIZE 3');
  expect(webgl1LineShader(source,2160)).not.toContain('max(int(');
});
it('repairs the pinned Darken and Thin shader sources without modifying unrelated shaders',()=>{
  for(const name of ['Darken','Thin']){
    const source=readFileSync(new URL('../../node_modules/anime4k.js/dist/glsl/Experimental-Effects/Anime4K_'+name+'_Fast.mjs',import.meta.url),'utf8');
    // Check every compiled fragment separately, as the actual shaderSource adapter does.
    const fragments=[...source.matchAll(/const fragment_\d+_shader = \x60([\s\S]*?)\x60;/g)].map(match=>match[1]);
    expect(fragments.length).toBeGreaterThan(2);
    for(const fragment of fragments){
      const fixed=webgl1LineShader(fragment,2160);
      if(fragment.includes('#define KERNELSIZE'))expect(fixed).toContain('#define KERNELSIZE '+(fragment.includes('SPATIAL_SIGMA (0.5')?5:9));
      expect(fixed).not.toContain('max(int(ceil');
    }
  }
  expect(webgl1LineShader('void main() {}',2160)).toBe('void main() {}');
});
