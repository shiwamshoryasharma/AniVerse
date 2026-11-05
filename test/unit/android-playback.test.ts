import {describe,expect,it} from 'vitest';
import {episodeChoices,nextEnabledSource} from '../../frontend/src/android/playback';
describe('Android source-backed episode navigation',()=>{
 it('uses only source-confirmed episode numbers when available',()=>{
   expect(episodeChoices(2,[1,2,5],12)).toEqual([1,2,5]);
 });
 it('does not invent 24 episodes for an unknown series',()=>{
   expect(episodeChoices(7,null,null)).toEqual([7]);
 });
 it('keeps long series reachable beyond episode 300 in a bounded window',()=>{
   const values=episodeChoices(740,null,1100);
   expect(values).toContain(740);expect(values).toContain(741);
   expect(values.length).toBeLessThanOrEqual(100);
 });
 it('normalizes duplicate and untrusted episode values',()=>{
   expect(episodeChoices(2,[3,1,3,-1,Infinity,2.5],12)).toEqual([1,3]);
 });
 it('limits fallback to each remaining enabled source once',()=>{
   const tried=new Set(['a']);
   expect(nextEnabledSource(['a','b','c'],tried)).toBe('b');
   tried.add('b');expect(nextEnabledSource(['a','b','c'],tried)).toBe('c');
   tried.add('c');expect(nextEnabledSource(['a','b','c'],tried)).toBeUndefined();
 });
});
