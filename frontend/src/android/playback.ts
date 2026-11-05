/** Android-only navigation: source observations remain distinct from metadata. */
export function episodeChoices(current:number,confirmed:number[]|null,total:number|null):number[]{
  if(confirmed!==null)return [...new Set(confirmed.filter(value=>Number.isSafeInteger(value)&&value>=1&&value<=100000))].sort((a,b)=>a-b);
  if(total===null||!Number.isSafeInteger(total)||total<1)return [current];
  const end=Math.min(total,Math.max(100,current+49));
  const start=Math.max(1,end-99);
  return Array.from({length:end-start+1},(_,index)=>start+index);
}
export function nextEnabledSource(enabled:string[],attempted:ReadonlySet<string>):string|undefined{
  return enabled.find(id=>!attempted.has(id));
}
