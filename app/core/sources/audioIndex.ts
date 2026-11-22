import type {SiteEpisodeCard} from '../../shared/types';
/** Session-local source observations; never persisted or included in account/app-data sync. */
export class SourceAudioIndex {
  private entries=new Map<string,{sourceId:string;mediaId:number;cards:SiteEpisodeCard[];updatedAt:number}>();
  observe(sourceId:string,mediaId:number,cards:SiteEpisodeCard[]){
    const observed=cards.filter(card=>card.audio.length).slice(0,500);if(!observed.length)return;
    while(this.entries.size>=256||[...this.entries.values()].reduce((sum,row)=>sum+row.cards.length,0)+observed.length>10000)this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(sourceId+':'+mediaId,{sourceId,mediaId,updatedAt:Date.now(),cards:observed.map(card=>({...card,thumbnail:null}))});
  }
  get(sourceId: string, mediaId: number) {
    const value = this.entries.get(sourceId + ':' + mediaId);
    if (!value || Date.now() - value.updatedAt >= 15 * 60_000) return null;
    const sub = new Set<number>(), dub = new Set<number>();
    for (const card of value.cards) {
      if (card.audio.includes('sub')) sub.add(card.episode);
      if (card.audio.includes('dub')) dub.add(card.episode);
    }
    return { sub: sub.size || null, dub: dub.size || null,
      total: new Set(value.cards.map(card => card.episode)).size };
  }

  list(enabled:Set<string>,privateTitle:(id:number)=>boolean){
    for(const [key,row]of this.entries)if(privateTitle(row.mediaId))this.entries.delete(key);
    const found=new Map<number,Map<number,Set<'sub'|'dub'>>>();
    for(const row of this.entries.values())if(enabled.has(row.sourceId)){
      const episodes=found.get(row.mediaId)??new Map<number,Set<'sub'|'dub'>>();
      for(const card of row.cards){const audio=episodes.get(card.episode)??new Set<'sub'|'dub'>();card.audio.forEach(value=>audio.add(value));episodes.set(card.episode,audio);}
      found.set(row.mediaId,episodes);
    }
    return [...found].map(([mediaId,episodes])=>({mediaId,audio:[...new Set([...episodes.values()].flatMap(audio=>[...audio]))],episodes:[...episodes].map(([episode,audio])=>({episode,audio:[...audio]}))}));
  }
}
