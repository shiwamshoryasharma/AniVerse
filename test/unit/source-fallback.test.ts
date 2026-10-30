import { expect, it } from 'vitest';
import { SourceFallback, shouldFallback } from '../../app/shared/sourceFallback';
const sources=[{id:'first',enabled:true},{id:'disabled',enabled:false},{id:'second',enabled:true},{id:'third',enabled:true}];
it('tries the next enabled source in order and stops after exhausting the list',()=>{
 const fallback=new SourceFallback();
 expect(fallback.unavailable('episode-1','first',sources)).toEqual({kind:'switch',sourceId:'second'});
 expect(fallback.unavailable('episode-1','second',sources)).toEqual({kind:'switch',sourceId:'third'});
 expect(fallback.unavailable('episode-1','third',sources)).toEqual({kind:'exhausted'});
 expect(fallback.unavailable('episode-1','first',sources)).toEqual({kind:'ignored'});
});
it('starts after the selected source, wraps once, and never retries failed sources',()=>{
 const fallback=new SourceFallback();
 expect(fallback.unavailable('episode-1','third',sources)).toEqual({kind:'switch',sourceId:'first'});
 expect(fallback.unavailable('episode-1','first',sources)).toEqual({kind:'switch',sourceId:'second'});
 expect(fallback.unavailable('episode-1','second',sources)).toEqual({kind:'exhausted'});
});
it('ignores repeated results from a source already replaced',()=>{
 const fallback=new SourceFallback();fallback.unavailable('episode-1','first',sources);
 expect(fallback.unavailable('episode-1','first',sources)).toEqual({kind:'ignored'});
});
it('resets for a new episode or explicit manual retry',()=>{
 const fallback=new SourceFallback();
 fallback.unavailable('episode-1','first',sources);fallback.unavailable('episode-1','second',sources);
 expect(fallback.unavailable('episode-2','first',sources)).toEqual({kind:'switch',sourceId:'second'});
 fallback.reset('episode-2');
 expect(fallback.unavailable('episode-2','first',sources)).toEqual({kind:'switch',sourceId:'second'});
});
it('does not automatically skip security checks or cancelled navigation',()=>{
 expect(shouldFallback({ok:false,failure:'not-found'})).toBe(true);
 for(const failure of ['blocked','cancelled','unavailable',undefined] as const)expect(shouldFallback({ok:false,failure})).toBe(false);
 expect(shouldFallback({ok:true,failure:'not-found'})).toBe(false);
});
it('stops cleanly with one source and ignores disabled or removed sources',()=>{
 const fallback=new SourceFallback();
 expect(fallback.unavailable('episode-1','first',[sources[0]])).toEqual({kind:'exhausted'});
 expect(fallback.unavailable('episode-2','removed',sources)).toEqual({kind:'ignored'});
});
