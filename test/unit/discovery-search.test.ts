import {expect,it} from 'vitest';
import {broaderSearch,discoveryScore} from '../../app/core/metadata/search';
import {searchQueries} from '../../electron/siteNavigator';
it('ranks exact, partial and typo discovery matches while accepting native/romaji aliases',()=>{
 expect(discoveryScore('cowboy beebop',['Cowboy Bebop'])).toBeGreaterThan(discoveryScore('cowboy beebop',['Cowboy Adventures']));
 expect(discoveryScore('cowboy',['Cowboy Bebop'])).toBeGreaterThan(0.9);
 expect(discoveryScore('カウボーイ',['Cowboy Bebop','カウボーイビバップ'])).toBe(1.5);
 expect(discoveryScore('sousou',['Frieren: Beyond Journey’s End','Sousou no Frieren'])).toBeGreaterThan(0.9);
 expect(discoveryScore('bebop',['Unrelated Series'])).toBe(0);
});
it('limits broadening to a meaningful query word and retains Japanese search variants',()=>{
 expect(broaderSearch('Cowboy beebop')).toBe('cowboy');
 expect(broaderSearch('カウボーイビバップ')).toBeNull();
 expect(searchQueries(['English Series','Romaji Series','日本語タイトル','Alternate Name'])).toContain('日本語タイトル');
 expect(searchQueries(Array.from({length:20},(_,i)=>'Title '+i)).length).toBeLessThanOrEqual(6);
});

it('merges broader catalogue results instead of depending on a single source or exact spelling',async()=>{
 const {Store}=await import('../../app/core/db/store');const {AniListClient}=await import('../../app/core/metadata/anilist');
 const {readFileSync}=await import('node:fs');
 const base=JSON.parse(readFileSync('test/fixtures/anilist-home.json','utf8')).data.trending.media[0];
 const cowboy={...base,id:1,title:{english:'Cowboy Bebop',romaji:'Cowboy Bebop',native:'カウボーイビバップ',userPreferred:'Cowboy Bebop'},isAdult:false};
 const nearby={...base,id:2,title:{english:'Cowboy Adventure',romaji:'Cowboy Adventure',native:null,userPreferred:'Cowboy Adventure'},isAdult:false};
 const excluded={...base,id:3,isAdult:true};
 const queries:string[]=[];
 const store=new Store(':memory:');
 try{
  const client=new AniListClient(async(_url,init)=>{const q=JSON.parse(String(init?.body)).variables.search;queries.push(q);return new Response(JSON.stringify({data:{Page:{media:q==='cowboy'?[nearby,cowboy,excluded]:[]}}}));},store,{showAdult:()=>false,token:()=>null});
  const results=await client.search('cowboy beebop');
  expect(queries).toEqual(['cowboy beebop','cowboy']);expect(results.map(r=>r.id)).toEqual([1,2]);
 }finally{store.close();}
});
