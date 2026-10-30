import type { OpenEpisodeResult } from './types';
export function shouldFallback(result:Pick<OpenEpisodeResult,'ok'|'failure'>):boolean {
  return !result.ok && result.failure === 'not-found';
}
export type SourceFallbackStep={kind:'switch';sourceId:string}|{kind:'exhausted'}|{kind:'ignored'};
/** One bounded pass per title/episode/search choice. Repeated/stale failures cannot skip a source. */
export class SourceFallback {
  private scope='';private failed=new Set<string>();
  reset(scope:string){this.scope=scope;this.failed.clear();}
  unavailable(scope:string,current:string,sources:readonly {id:string;enabled:boolean}[]):SourceFallbackStep {
    if(this.scope!==scope)this.reset(scope);
    const enabled=sources.filter(s=>s.enabled).map(s=>s.id),index=enabled.indexOf(current);
    if(index<0||this.failed.has(current))return {kind:'ignored'};
    this.failed.add(current);
    for(let offset=1;offset<enabled.length;offset++){
      const id=enabled[(index+offset)%enabled.length];
      if(!this.failed.has(id))return {kind:'switch',sourceId:id};
    }
    return {kind:'exhausted'};
  }
}
