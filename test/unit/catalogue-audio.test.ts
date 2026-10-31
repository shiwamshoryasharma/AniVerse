import {expect,it} from 'vitest';
import {matchesAudio} from '../../app/shared/audioAvailability';
it('catalogue DUB includes a mixed series even when its latest episode is sub-only',()=>{
 const rows=[{mediaId:7,audio:['sub','dub'] as ('sub'|'dub')[],episodes:[{episode:11,audio:['sub','dub'] as ('sub'|'dub')[]},{episode:12,audio:['sub'] as ('sub'|'dub')[]}]}];
 expect(matchesAudio(7,'dub',rows,12)).toBe(true);
 expect(matchesAudio(7,'sub',rows,12)).toBe(true);
});
it('catalogue SUB is inclusive of mixed and sub-only series; DUB requires both',()=>{
 const rows=[{mediaId:1,audio:['sub','dub'] as ('sub'|'dub')[]},{mediaId:2,audio:['sub'] as ('sub'|'dub')[]},{mediaId:3,audio:['dub'] as ('sub'|'dub')[]}];
 expect(matchesAudio(1,'dub',rows)).toBe(true);expect(matchesAudio(2,'dub',rows)).toBe(false);expect(matchesAudio(3,'dub',rows)).toBe(false);
 expect(matchesAudio(1,'sub',rows)).toBe(true);expect(matchesAudio(2,'sub',rows)).toBe(true);expect(matchesAudio(3,'sub',rows)).toBe(false);
});

import {catalogueMatches,audioMatches} from '../../app/shared/audioAvailability';
it('treats explicit zero correctly and uses a selected source category only for unknown counts',()=>{
 expect(catalogueMatches({sub:12,dub:11},'dub')).toBe(true);
 expect(catalogueMatches({sub:6,dub:0},'dub','dub')).toBe(false);
 expect(catalogueMatches({sub:0,dub:4},'dub','dub')).toBe(false);
 expect(catalogueMatches({sub:6,dub:0},'sub')).toBe(true);
 expect(catalogueMatches({sub:null,dub:null},'dub','dub')).toBe(true);
 expect(catalogueMatches({sub:null,dub:null},'dub')).toBe(false);
 expect(audioMatches(['sub','dub'],'sub')).toBe(true);
 expect(audioMatches(['sub'],'sub')).toBe(true);
 expect(audioMatches(['sub'],'dub')).toBe(false);
});
it('resolves public catalogue IDs in one bounded official metadata query with existing filters',async()=>{
 const {Store}=await import('../../app/core/db/store');
 const {AniListClient}=await import('../../app/core/metadata/anilist');
 const store=new Store(':memory:');let calls=0;let body:any;
 try{
  const client=new AniListClient(async(_url,init)=>{calls++;body=JSON.parse(String(init?.body));return new Response(JSON.stringify({data:{Page:{media:[]}}}));},store,{showAdult:()=>false,token:()=>null});
  expect(await client.catalogueCards([])).toEqual([]);expect(calls).toBe(0);
  await client.catalogueCards([7,7,-1,...Array.from({length:70},(_,i)=>i+20)],{genres:['Action'],country:'JP'});
  expect(calls).toBe(1);expect(body.variables.id_in).toHaveLength(50);
  expect(body.variables.id_in[0]).toBe(7);expect(body.variables.isAdult).toBe(false);
  expect(body.variables.genre_in).toEqual(['Action']);expect(body.variables.countryOfOrigin).toBe('JP');
  expect(body.query).toContain('id_in: $id_in');
 }finally{store.close();}
});
