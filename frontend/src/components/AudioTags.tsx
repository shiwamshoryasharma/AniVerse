import {useQuery} from '@tanstack/react-query';
import {Mic,Subtitles} from 'lucide-react';
import {useEffect,useState} from 'react';
import {audioBadgeState,type AudioChoice,type AudioCounts} from '../../../app/shared/audioAvailability';
import type {MediaCard} from '../../../app/shared/types';
import {call} from '../lib/bridge';
import {usePrivacy} from '../lib/privacy';
import {useSources} from '../lib/queries';
export interface HoverAudioProps {audioCounts?:AudioCounts;audioCategory?:AudioChoice;audioSource?:string}
/** Unknown is distinct from an explicit source count of zero. Only an open preview checks a title. */
export function AudioTags({media,audioCounts,audioCategory='all',audioSource}:HoverAudioProps&{media:MediaCard}){
 const sources=useSources(),privacy=usePrivacy(),[ready,setReady]=useState(false);
 useEffect(()=>{const timer=setTimeout(()=>setReady(true),700);return ()=>clearTimeout(timer);},[]);
 const source=sources.data?.find(source=>source.enabled&&source.kind==='web');
 const privateTitle=privacy.data?.privateMediaIds.includes(media.id)??false;
 const mayCheck=!!privacy.data&&(!privateTitle||privacy.data.incognito);
 const result=useQuery({
  queryKey:['hover-audio',source?.partition,source?.url,media.id,privacy.data?.incognito,privateTitle],
  enabled:ready&&!audioCounts&&!!source&&mayCheck,
  gcTime:0,staleTime:60000,retry:false,
  queryFn:async()=>{
   const titles=[...new Set([media.title.english,media.title.romaji,media.title.userPreferred].filter((title):title is string=>!!title))].slice(0,2);
   for(const title of titles){
    const page=await call('sources.catalogue',{sourceId:source!.id,audio:'all',page:1,query:{search:title}});
    const match=page.items.find(item=>item.media?.id===media.id);
    if(match)return {counts:{sub:match.sub,dub:match.dub,total:match.total},name:page.sourceName};
   }
   return null;
  },
 });
 const counts=audioCounts??result.data?.counts,name=audioSource??result.data?.name??source?.name;
 return <div className="hover-audio">
  <div className="row wrap" role="group" aria-label="Audio availability" style={{gap:6}}>
   {(['sub','dub'] as const).map(audio=>{
    const state=audioBadgeState(counts?.[audio],audioCategory===audio||(audio==='sub'&&audioCategory==='dub'));
    const Icon=audio==='sub'?Subtitles:Mic,label=audio.toUpperCase();
    return <span key={audio} className={'chip audio-tag '+(state==='available'?(audio==='sub'?'ok':'accent'):'faint')} data-audio={audio} data-state={state} aria-label={label+' '+state} title={state==='available'?label+' available'+(counts?.[audio]?': '+counts[audio]+' episodes':''):state==='unavailable'?'No '+label+' episodes listed on this source':label+' availability has not been verified'}>
     <Icon size={12}/>{label}{state==='unknown'?' ?':state==='unavailable'?' —':''}
    </span>;
   })}
  </div>
  <span className="faint" style={{fontSize:'var(--fs-xs)'}} role="status">{audioCounts?name:result.isFetching?'Checking audio…':counts?name:privateTitle&&!privacy.data?.incognito?'Use incognito to check audio privately.':source?'Audio not confirmed on '+source.name:'Add a source to check audio.'}</span>
 </div>;
}
