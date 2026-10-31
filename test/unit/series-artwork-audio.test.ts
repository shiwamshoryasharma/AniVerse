import {describe,it,expect,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import type {WebContents} from 'electron';
import {RustPolicy} from '../../app/core/security/rustPolicy';
import {EpisodeArtwork} from '../../electron/episodeArtwork';
import {seriesMarkers} from '../../app/core/sources/text';
import {SourceAudioIndex} from '../../app/core/sources/audioIndex';
import {matchesAudio} from '../../app/shared/audioAvailability';
const policy=()=>new RustPolicy(readFileSync('dist/electron/security.wasm'));
function owner(fetch=vi.fn(async(_url:string,_options?:RequestInit)=>new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/webp'}}))){
 const value=Object.assign(new EventEmitter(),{id:7,isDestroyed:()=>false,getURL:()=> 'https://stream-one.test/watch/series/1',session:{fetch}});
 return {value:value as unknown as WebContents,fetch};
}
describe('generic series identity',()=>{
 it.each([
  ['Skybound Season II',{title:'Skybound',season:2,part:null}],
  ['Skybound 2nd Season',{title:'Skybound',season:2,part:null}],
  ['Skybound S2E03',{title:'Skybound',season:2,part:null}],
  ['星の旅 第２期',{title:'星の旅',season:2,part:null}],
  ['Skybound Season IV Part II',{title:'Skybound',season:4,part:2}],
  ['Skybound 2nd Cour',{title:'Skybound',season:null,part:2}],
  ['星の旅 第2クール',{title:'星の旅',season:null,part:2}],
  ['Skybound: The River Arc',{title:'Skybound: The River Arc',season:null,part:null}],
 ] as const)('reads separate season/part axes: %s',(title,expected)=>expect(seriesMarkers(title)).toEqual(expected));
});
it('keeps unknown and private observations out of source-confirmed filters and distinguishes latest episode audio',()=>{
 const index=new SourceAudioIndex();
 index.observe('one',8,[{episode:1,thumbnail:null,audio:['dub','sub']},{episode:2,thumbnail:null,audio:['sub']}]);
 index.observe('disabled',9,[{episode:1,thumbnail:null,audio:['dub']}]);
 const rows=index.list(new Set(['one']),()=>false);
 expect(matchesAudio(8,'dub',rows)).toBe(true);
 expect(matchesAudio(8,'dub',rows,2)).toBe(false);
 expect(matchesAudio(8,'sub',rows,2)).toBe(true);
 expect(matchesAudio(99,'dub',rows)).toBe(false);
 expect(matchesAudio(99,'all',rows)).toBe(true);
 expect(matchesAudio(9,'dub',rows)).toBe(false);
 expect(index.list(new Set(['one']),id=>id===8)).toEqual([]);
 expect(index.list(new Set(['one']),()=>false)).toEqual([]);
});
describe('isolated episode artwork grants',()=>{
 it('uses source-session image fetches with opaque, revoked, nonpersistent grants',async()=>{
  const service=new EpisodeArtwork(policy()),{value,fetch}=owner();
  const grant=service.grant(value,'https://images.test/episode-1.webp')!;
  expect(grant).toMatch(/^media:\/\/episode\/[a-f0-9]{48}$/);
  expect(service.grant(value,'https://images.test/episode-1.webp')).toBe(grant);
  const response=await service.serve(grant.split('/').at(-1)!);
  expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1,2,3]);
  expect(fetch.mock.calls[0][0]).toBe('https://images.test/episode-1.webp');
  expect(fetch.mock.calls[0][1]?.headers).toEqual({Referer:'https://stream-one.test/'});
  value.emit('destroyed');
  expect((await service.serve(grant.split('/').at(-1)!)).status).toBe(404);
 });
 it('rejects privileged and unrelated local URLs before any fetch',()=>{
  const service=new EpisodeArtwork(policy()),{value,fetch}=owner();
  for(const url of ['file:///C:/private.png','http://127.0.0.1/private.png','https://user:secret@images.test/a.png','javascript:alert(1)'])expect(service.grant(value,url)).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
 });
 it('ignores artwork from an unloaded source document without throwing or fetching',()=>{
  const service=new EpisodeArtwork(policy()),{value,fetch}=owner();
  value.getURL=()=> 'about:blank';expect(service.grant(value,'https://images.test/a.png')).toBeNull();expect(fetch).not.toHaveBeenCalled();
 });
 it('rejects non-image content and bounds streamed images without a trusted length header',async()=>{
  const fetch=vi.fn(async(url:string)=>url.endsWith('.html')?new Response('<html/>',{headers:{'Content-Type':'text/html'}}):new Response(new Uint8Array(2097153),{headers:{'Content-Type':'image/png'}}));
  const {value}=owner(fetch as ReturnType<typeof owner>['fetch']),service=new EpisodeArtwork(policy());
  for(const [url,status]of [['https://images.test/a.html',404],['https://images.test/a.png',413]] as const){
   const token=service.grant(value,url)!.split('/').at(-1)!;expect((await service.serve(token)).status).toBe(status);
  }
 });
});
