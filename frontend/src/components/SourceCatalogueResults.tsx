import {useQuery} from '@tanstack/react-query';
import {useState} from 'react';
import {useNavigate} from 'react-router';
import {ChevronLeft,ChevronRight,ExternalLink,Mic,Subtitles} from 'lucide-react';
import type {AudioChoice} from '../../../app/shared/audioAvailability';
import type {BrowseQuery} from '../../../app/shared/types';
import {call} from '../lib/bridge';
import {useSources} from '../lib/queries';
import {usePrivacy} from '../lib/privacy';
import {ErrorState} from './common';
import {MediaCard,SkeletonCards} from './MediaCard';
import {Select} from './controls';
/** Catalogue pages come from the selected website, not this device's viewing history. */
export function SourceCatalogueResults({audio,query={}}:{audio:AudioChoice;query?:BrowseQuery}){
 const sources=useSources(),privacy=usePrivacy(),navigate=useNavigate();
 const enabled=sources.data?.filter(source=>source.enabled&&source.kind==='web')??[];
 const [chosen,setChosen]=useState('');
 const source=enabled.find(source=>source.id===chosen)??enabled[0];
 const scope=source?.partition+':'+source?.url+':'+audio+':'+JSON.stringify(query)+':'+privacy.data?.incognito;
 const [position,setPosition]=useState({scope:'',page:1});
 const page=position.scope===scope?position.page:1;
 const result=useQuery({queryKey:['source-catalogue',scope,page],queryFn:()=>call('sources.catalogue',{sourceId:source!.id,audio,page,query}),enabled:!!source&&!!privacy.data,staleTime:0,gcTime:0,refetchInterval:60000,retry:false});
 if(sources.isLoading||privacy.isLoading)return <div className="grid six"><SkeletonCards count={12}/></div>;
 if(!source)return <p className="muted">Add or enable a website source to browse its SUB/DUB catalogue.</p>;
 const step=(n:number)=>setPosition({scope,page:n});
 return <div className="source-catalogue" aria-busy={result.isFetching}>
  <div className="row wrap" style={{marginBottom:12}}>
   <label className="row faint">Catalogue <Select ariaLabel="Catalogue source" value={source.id} onChange={setChosen} options={enabled.map(source=>({value:source.id,label:source.name}))}/></label>
   {result.data&&<span className="faint">{result.data.items.length} series</span>}
   <span className="faint" style={{fontSize:'var(--fs-xs)'}}>DUB: SUB + DUB · SUB: mixed and sub-only series</span>
  </div>
  {result.error?<><ErrorState error={result.error} onRetry={()=>void result.refetch()}/><button className="btn sm" onClick={()=>navigate('/sources/'+source.id)}><ExternalLink size={13}/> Open source</button></>:<>
   {result.data?.metadataError&&<p className="faint">Some titles could not be matched to AniList. You can open them on the source.</p>}
   <div className="grid six">{result.isLoading?<SkeletonCards count={12}/>:result.data?.items.map(card=>{
    const counts={sub:card.sub,dub:card.dub,total:card.total};
    return card.media?<MediaCard key={card.url} media={{...card.media,cover:card.cover??card.media.cover}} audioCounts={counts} audioCategory={audio} audioSource={source.name} to={'/watch/'+card.media.id+'/1?source='+source.id} subtitle={source.name}/>:<div key={card.url} className="mcard" role="link" tabIndex={0} onClick={()=>navigate('/sources/'+source.id+'?page='+encodeURIComponent(card.url))} onKeyDown={event=>event.key==='Enter'&&navigate('/sources/'+source.id+'?page='+encodeURIComponent(card.url))}>
     <div className="mcard-poster">{card.cover&&<img key={card.cover} src={card.cover} alt="" loading="lazy" onLoad={event=>event.currentTarget.style.removeProperty('display')} onError={event=>event.currentTarget.style.display='none'}/>}<div className="bottom"><span className="chip glass"><Subtitles size={11}/>{card.sub??'?'} <Mic size={11}/>{card.dub??'?'}</span></div></div>
     <strong className="clamp-2">{card.title}</strong><span className="faint" style={{fontSize:'var(--fs-xs)'}}>Open source page</span>
    </div>;
   })}</div>
   {result.data&&!result.data.items.length&&<p className="muted">No {audio.toUpperCase()} series match on this source page. Try the next page or another source.</p>}
  </>}
  <div className="row" style={{justifyContent:'center',marginTop:16}}>
   <button className="icon-btn bordered" aria-label="Previous catalogue page" disabled={page<=1||result.isFetching} onClick={()=>step(page-1)}><ChevronLeft size={16}/></button>
   <span className="faint">Source page {result.data?.page??page}</span>
   <button className="icon-btn bordered" aria-label="Next catalogue page" disabled={!result.data?.hasNext||result.isFetching||page>=20} onClick={()=>step(page+1)}><ChevronRight size={16}/></button>
  </div>
 </div>;
}
