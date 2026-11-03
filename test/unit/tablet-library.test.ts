import {describe,expect,it} from 'vitest';
import {TabletLibrary} from '../../frontend/src/android/library';
import type {MediaSnapshot,ProgressSave} from '../../app/shared/types';

const media=(id=101,title='Arcadia Story',episodes:number|null=12):MediaSnapshot=>({id,idMal:null,title,cover:'https://poster-fixture.test/'+id+'.jpg',banner:null,format:'TV',episodes});
const progress=(overrides:Partial<ProgressSave>={}):ProgressSave=>({media:media(),episode:2,position:120,duration:600,sourceId:'fixture-library',...overrides});
const fixture=(saved?:unknown)=>{const clock={value:1_800_000_000};return {clock,library:new TabletLibrary(saved,()=>clock.value)};};
const serialized=(library:TabletLibrary)=>JSON.parse(JSON.stringify(library.exportData()));
const attempt=(write:()=>unknown)=>{try{write();}catch{/* Rejecting private writes and ignoring them are both acceptable. */}};

// These tests intentionally cross only the pure trusted-library interface. Native WebView
// origin/bridge isolation needs a separate Android runtime test; this suite does not certify it.
describe('TabletLibrary persistence and identity',()=>{
 it('starts with the shared empty library-state shape',()=>{
  const {library}=fixture();expect(library.state(101)).toEqual({favourite:false,entry:null,progress:[],pinned:{}});expect(library.history()).toEqual([]);expect(library.continueWatching()).toEqual([]);expect(library.favourites()).toEqual([]);expect(library.entries(null)).toEqual([]);
 });
 it('preserves exact title episode source position duration and timestamp',()=>{
  const {library,clock}=fixture();const save=progress();expect(library.saveProgress(save).completedNow).toBe(false);
  expect(library.state(101).progress).toEqual([{mediaId:101,episode:2,position:120,duration:600,sourceId:'fixture-library',completed:false,updatedAt:clock.value}]);
  expect(library.history()).toEqual([expect.objectContaining({...save,id:expect.any(Number),watchedAt:clock.value})]);
 });
 it('updates one history record rather than duplicating the same episode',()=>{
  const {library,clock}=fixture();library.saveProgress(progress());const id=library.history()[0].id;clock.value++;
  library.saveProgress(progress({position:240}));expect(library.history()).toHaveLength(1);expect(library.history()[0]).toMatchObject({id,position:240,watchedAt:clock.value});
 });
 it('reuses episode identity after changing the source while preserving the latest source',()=>{
  const {library,clock}=fixture();library.saveProgress(progress());const id=library.history()[0].id;clock.value++;
  library.saveProgress(progress({sourceId:'another-fixture',position:300}));expect(library.history()).toHaveLength(1);expect(library.history()[0]).toMatchObject({id,sourceId:'another-fixture',position:300});expect(library.state(101).progress[0].sourceId).toBe('another-fixture');
 });
 it('keeps separate episodes and different titles, newest first, with pagination',()=>{
  const {library,clock}=fixture();library.saveProgress(progress({episode:1}));clock.value++;library.saveProgress(progress({episode:2}));clock.value++;library.saveProgress(progress({media:media(102,'Clockwork Road'),episode:1}));
  expect(library.history().map(row=>[row.media.id,row.episode])).toEqual([[102,1],[101,2],[101,1]]);expect(library.history(1,1).map(row=>row.episode)).toEqual([2]);expect(library.state(101).progress.map(row=>row.episode)).toEqual([1,2]);
 });
 it('round-trips history progress lists favourites scores and Continue through JSON',()=>{
  const {library,clock}=fixture();library.setStatus(media(),'CURRENT');library.setScore(media(),8.5);library.toggleFavourite(media());library.saveProgress(progress());clock.value++;
  const saved=serialized(library),restored=new TabletLibrary(saved,()=>clock.value);
  expect(restored.state(101)).toEqual(library.state(101));expect(restored.history()).toEqual(library.history());expect(restored.favourites()).toEqual(library.favourites());expect(restored.entries(null)).toEqual(library.entries(null));expect(restored.continueWatching()).toEqual(library.continueWatching());expect(serialized(restored)).toEqual(saved);
 });
 it.each([undefined,null,17,false,'invalid JSON',[],{unexpected:true}])('tolerates an unsupported saved payload: %j',saved=>{
  const {library}=fixture(saved);expect(library.history()).toEqual([]);expect(library.state(101).progress).toEqual([]);expect(()=>JSON.stringify(library.exportData())).not.toThrow();
 });
 it('does not mutate exported snapshots when callers change the returned object',()=>{
  const {library}=fixture();library.saveProgress(progress());const exported=library.exportData();const original=JSON.stringify(exported);
  // Mutation protection is tested without depending on the private serialized schema.
  const mutate=(value:unknown):void=>{if(!value||typeof value!=='object')return;for(const [key,child]of Object.entries(value)){if(key==='position'&&typeof child==='number')(value as Record<string,unknown>)[key]=999;else if(key==='title'&&typeof child==='string')(value as Record<string,unknown>)[key]='Changed outside library';else mutate(child);}};
  mutate(exported);expect(library.history()[0].position).toBe(120);expect(library.history()[0].media.title).toBe('Arcadia Story');expect(JSON.stringify(library.exportData())).toBe(original);
 });
});

describe('TabletLibrary completion and Continue watching',()=>{
 it('completes exactly at 90 percent, only once, without losing sticky completion',()=>{
  const {library,clock}=fixture();expect(library.saveProgress(progress({position:539})).completedNow).toBe(false);clock.value++;
  expect(library.saveProgress(progress({position:540})).completedNow).toBe(true);expect(library.state(101).progress[0].completed).toBe(true);expect(library.state(101).entry?.progress).toBe(2);clock.value++;
  expect(library.saveProgress(progress({position:200})).completedNow).toBe(false);expect(library.state(101).progress[0].completed).toBe(true);expect(library.state(101).entry?.progress).toBe(2);
 });
 it('offers the exact in-progress episode and source for each latest series',()=>{
  const {library,clock}=fixture();library.saveProgress(progress({episode:1}));clock.value++;library.saveProgress(progress({episode:4,position:333}));
  expect(library.continueWatching()).toEqual([expect.objectContaining({media:media(),episode:4,position:333,duration:600,completed:false,sourceId:'fixture-library',updatedAt:clock.value})]);
 });
 it('offers the next episode after completion and omits the known final episode',()=>{
  const {library,clock}=fixture();library.saveProgress(progress({episode:2,position:540}));expect(library.continueWatching()).toEqual([expect.objectContaining({episode:3,position:0,duration:0,sourceId:'fixture-library'})]);clock.value++;
  library.saveProgress(progress({episode:12,position:540}));expect(library.continueWatching()).toEqual([]);expect(library.state(101).entry).toMatchObject({status:'COMPLETED',progress:12});
 });
 it('retains a next episode when the series length is unknown',()=>{
  const {library}=fixture();library.saveProgress(progress({media:media(101,'Arcadia Story',null),position:540}));expect(library.continueWatching()[0]).toMatchObject({episode:3,sourceId:'fixture-library'});
 });
 it('dismisses Continue until a subsequent watch and preserves progress/history',()=>{
  const {library,clock}=fixture();library.saveProgress(progress());const before=library.history();library.dismissContinue(101);expect(library.continueWatching()).toEqual([]);expect(library.history()).toEqual(before);expect(library.state(101).progress).toHaveLength(1);clock.value++;
  library.saveProgress(progress({position:200}));expect(library.continueWatching()).toHaveLength(1);
 });
 it('marks an episode watched and reverses completion without deleting its record',()=>{
  const {library}=fixture();library.saveProgress(progress());library.markWatched(media(),2,true);expect(library.state(101).progress[0]).toMatchObject({episode:2,completed:true});expect(library.state(101).entry?.progress).toBe(2);
  library.markWatched(media(),2,false);expect(library.state(101).progress[0]).toMatchObject({episode:2,completed:false});expect(library.state(101).entry?.progress).toBe(0);
 });
 it.each([{position:Number.NaN,duration:600},{position:Number.POSITIVE_INFINITY,duration:600},{position:120,duration:Number.NaN},{position:120,duration:Number.POSITIVE_INFINITY},{position:-4,duration:-3}])('sanitizes nonfinite/negative progress: %j',values=>{
  const {library}=fixture();library.saveProgress(progress(values));const row=library.state(101).progress[0];expect(Number.isFinite(row.position)).toBe(true);expect(Number.isFinite(row.duration)).toBe(true);expect(row.position).toBeGreaterThanOrEqual(0);expect(row.duration).toBeGreaterThanOrEqual(0);expect(()=>JSON.stringify(library.exportData())).not.toThrow();
 });
});

describe('TabletLibrary list and removal semantics',()=>{
 it('toggles favourites and changes status/score independently of watch history',()=>{
  const {library}=fixture();expect(library.toggleFavourite(media())).toEqual({favourite:true});expect(library.state(101).favourite).toBe(true);library.setStatus(media(),'PLANNING');library.setScore(media(),8.5);expect(library.entries('PLANNING')).toEqual([expect.objectContaining({media:media(),status:'PLANNING',progress:0,score:8.5})]);
  library.setStatus(media(),'CURRENT');expect(library.entries('PLANNING')).toEqual([]);expect(library.entries('CURRENT')[0].score).toBe(8.5);library.setScore(media(),null);expect(library.entries(null)[0].score).toBeNull();expect(library.history()).toEqual([]);expect(library.toggleFavourite(media())).toEqual({favourite:false});expect(library.favourites()).toEqual([]);
 });
 it('removes status without removing favourites or episode progress',()=>{
  const {library}=fixture();library.saveProgress(progress());library.toggleFavourite(media());library.setStatus(media(),'CURRENT');library.setStatus(media(),null);expect(library.state(101).entry).toBeNull();expect(library.state(101).favourite).toBe(true);expect(library.state(101).progress).toHaveLength(1);
 });
 it('clear history preserves list favourites and progress while hiding Continue',()=>{
  const {library,clock}=fixture();library.setStatus(media(),'CURRENT');library.setScore(media(),7);library.toggleFavourite(media());library.saveProgress(progress());const before=library.state(101);library.clearHistory(null);
  expect(library.history()).toEqual([]);expect(library.continueWatching()).toEqual([]);expect(library.state(101)).toEqual(before);expect(library.favourites()).toHaveLength(1);expect(library.entries(null)).toHaveLength(1);clock.value++;
  library.saveProgress(progress({position:180}));expect(library.history()).toHaveLength(1);expect(library.continueWatching()).toHaveLength(1);
 });
 it('removes only the selected history id and dismisses only its series from Continue',()=>{
  const {library,clock}=fixture();library.saveProgress(progress({episode:1}));clock.value++;library.saveProgress(progress({episode:2}));clock.value++;library.saveProgress(progress({media:media(102,'Clockwork Road')}));const first=library.history().find(row=>row.media.id===101&&row.episode===1)!;
  library.clearHistory(first.id);expect(library.history()).toHaveLength(2);expect(library.history().some(row=>row.media.id===101&&row.episode===2)).toBe(true);expect(library.state(101).progress).toHaveLength(2);expect(library.continueWatching().map(item=>item.media.id)).toEqual([102]);
 });
 it('ignores unknown removal ids without dismissing another series',()=>{
  const {library}=fixture();library.saveProgress(progress());const before=serialized(library);library.clearHistory(999999);expect(serialized(library)).toEqual(before);expect(library.continueWatching()).toHaveLength(1);
 });
});

describe('TabletLibrary privacy write barriers',()=>{
 const blockedWrites=(library:TabletLibrary)=>{attempt(()=>library.saveProgress(progress({position:444})));attempt(()=>library.toggleFavourite(media()));attempt(()=>library.setStatus(media(),'DROPPED'));attempt(()=>library.setScore(media(),2));attempt(()=>library.markWatched(media(),5,true));};
 it('incognito neither stores new history/progress nor changes saved list/favourites',()=>{
  const {library}=fixture();library.saveProgress(progress());library.setStatus(media(),'CURRENT');library.toggleFavourite(media());library.setPrivacy({incognito:true,privateMediaIds:[]});const before=serialized(library);blockedWrites(library);
  expect(serialized(library)).toEqual(before);expect(library.history()).toEqual([]);expect(library.continueWatching()).toEqual([]);library.setPrivacy({incognito:false,privateMediaIds:[]});expect(library.history()).toHaveLength(1);expect(library.state(101).progress[0].position).toBe(120);expect(library.state(101).entry?.status).toBe('CURRENT');expect(library.state(101).favourite).toBe(true);
 });
 it('private titles suppress writes and discovery rows while public titles still work',()=>{
  const {library,clock}=fixture();library.saveProgress(progress());library.setStatus(media(),'CURRENT');library.toggleFavourite(media());library.setPrivacy({incognito:false,privateMediaIds:[101]});const before=serialized(library);blockedWrites(library);expect(serialized(library)).toEqual(before);expect(library.history()).toEqual([]);expect(library.continueWatching()).toEqual([]);clock.value++;
  library.saveProgress(progress({media:media(102,'Clockwork Road'),episode:3}));expect(library.history().map(row=>row.media.id)).toEqual([102]);expect(library.continueWatching().map(row=>row.media.id)).toEqual([102]);library.setPrivacy({incognito:false,privateMediaIds:[]});expect(library.state(101).progress[0].position).toBe(120);expect(library.state(101).entry?.status).toBe('CURRENT');expect(library.state(101).favourite).toBe(true);
 });
 it('private/incognito playback never appears after exported data is reloaded',()=>{
  const {library,clock}=fixture();library.setPrivacy({incognito:true,privateMediaIds:[]});blockedWrites(library);const first=new TabletLibrary(serialized(library),()=>clock.value);expect(first.history()).toEqual([]);expect(first.state(101).progress).toEqual([]);expect(first.favourites()).toEqual([]);expect(first.entries(null)).toEqual([]);
  library.setPrivacy({incognito:false,privateMediaIds:[101]});blockedWrites(library);const second=new TabletLibrary(serialized(library),()=>clock.value);expect(second.history()).toEqual([]);expect(second.state(101).progress).toEqual([]);expect(second.favourites()).toEqual([]);expect(second.entries(null)).toEqual([]);
 });
});
it('does not silently reset a damaged or newer saved library',()=>{
 const library=new TabletLibrary();library.saveProgress(progress());const saved=library.exportData();
 expect(()=>new TabletLibrary({...saved,version:2})).toThrow();
 expect(()=>new TabletLibrary({...saved,history:[{id:1}]})).toThrow();
 expect(library.history()).toHaveLength(1);
});
