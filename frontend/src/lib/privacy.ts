import {useQuery} from '@tanstack/react-query';
import {useEffect} from 'react';
import {call} from './bridge';
export const usePrivacy=()=>useQuery({queryKey:['privacy'],queryFn:()=>call('privacy.state'),staleTime:Infinity});
export function useWatchSources(mediaId:number){
 const privacy=usePrivacy();
 const privateTitle=privacy.data?.privateMediaIds.includes(mediaId)??false;
 const query=useQuery({queryKey:['watch-sources',mediaId,privacy.data?.incognito,privateTitle],queryFn:()=>call('privacy.watchSources',{mediaId}),enabled:mediaId>0&&!!privacy.data,staleTime:0,gcTime:0,refetchOnMount:'always'});
 const leaseId=query.data?.leaseId;
 useEffect(()=>()=>{if(leaseId)void call('privacy.releaseSources',{leaseId}).catch(()=>undefined);},[leaseId]);
 return query;
}
