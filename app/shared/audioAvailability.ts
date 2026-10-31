export type AudioChoice='all'|'dub'|'sub';
export interface AudioAvailability {mediaId:number;audio:('sub'|'dub')[];episodes?:{episode:number;audio:('sub'|'dub')[]}[]}
export function audioMatches(audio:('sub'|'dub')[]|undefined,value:AudioChoice){return value==='all'||!!audio?.includes('sub')&&(value==='sub'||audio.includes('dub'));}
/** Catalogue eligibility is series-wide, independent of which episode aired most recently. */
export function matchesAudio(id:number,value:AudioChoice,known:AudioAvailability[]|undefined,_episode?:number){
 return value==='all'||!!known?.some(row=>row.mediaId===id&&audioMatches(row.audio,value));
}
/** A selected website category can confirm an unnumbered badge; explicit zero never means available. */
export function catalogueMatches(card:{sub:number|null;dub:number|null},audio:AudioChoice,category:AudioChoice='all'){
 if(audio==='all')return true;
 const sub=card.sub===null?category==='sub'||category==='dub':card.sub>0;
 const dub=card.dub===null?category==='dub':card.dub>0;
 return sub&&(audio==='sub'||dub);
}
