import {useSyncExternalStore} from 'react';
import {seasonalVisuals} from '../../../app/shared/seasonal';
import {useSettings} from './queries';
const listeners=new Set<()=>void>();let timer:ReturnType<typeof setInterval>|undefined;
function subscribe(listener:()=>void){listeners.add(listener);timer??=setInterval(()=>{for(const fn of listeners)fn();},1000);return()=>{listeners.delete(listener);if(!listeners.size){clearInterval(timer);timer=undefined;}};}
const snapshot=()=>seasonalVisuals(new Date(),'festival');
export function useSeasonalVisuals(){
 const active=useSyncExternalStore(subscribe,snapshot,()=>false);
 const accent=useSettings().appearance.accent;
 return active&&accent==='festival';
}
