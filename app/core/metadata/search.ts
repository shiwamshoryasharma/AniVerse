import { normalizeTitle } from '../sources/text';

export function broaderSearch(query:string):string|null {
  const words=normalizeTitle(query).split(' ').filter(word=>word.length>=3&&!/^(the|and|season|part)$/.test(word));
  return words.length>1 ? words[0] : null;
}
function wordScore(a:string,b:string):number {
  if(a===b)return 1;
  if(a.length>=3&&b.startsWith(a))return 0.95;
  if(a.length<4||b.length<4||Math.abs(a.length-b.length)>2)return 0;
  // Small typo tolerance, bounded by the input limits and title word length.
  let row=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){
    const next=[i];
    for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]===b[j-1]?0:1));
    row=next;
  }
  const distance=row[b.length];
  return distance<=Math.max(1,Math.floor(Math.max(a.length,b.length)*0.2))?1-distance/Math.max(a.length,b.length):0;
}
/** Broad discovery ranking. Playback separately verifies title, season and episode. */
export function discoveryScore(query:string,aliases:(string|null|undefined)[]):number {
  const q=normalizeTitle(query);
  if(!q)return 0;
  const words=q.split(' ');
  let best=0;
  for(const alias of aliases){
    const title=normalizeTitle(alias??'');
    if(!title)continue;
    if(title===q)return 2;
    if(title.includes(q))best=Math.max(best,1.5);
    const candidates=title.split(' ');
    const scores=words.map(word=>Math.max(0,...candidates.map(candidate=>wordScore(word,candidate))));
    best=Math.max(best,scores.reduce((sum,value)=>sum+value,0)/words.length);
  }
  return best;
}
