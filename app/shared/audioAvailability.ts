export type AudioChoice='all'|'dub'|'sub';
export interface AudioAvailability {mediaId:number;audio:('sub'|'dub')[];episodes?:{episode:number;audio:('sub'|'dub')[]}[]}
/** Unknown is visible in ALL; a numbered latest episode requires its own confirmed badge. */
export function matchesAudio(id:number,value:AudioChoice,known:AudioAvailability[]|undefined,episode?:number){
 return value==='all'||!!known?.some(row=>row.mediaId===id&&(episode===undefined?row.audio.includes(value):!!row.episodes?.some(card=>card.episode===episode&&card.audio.includes(value))));
}
