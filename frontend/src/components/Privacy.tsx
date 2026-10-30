import {EyeOff,ShieldCheck} from 'lucide-react';
import {useState} from 'react';
import {useNavigate} from 'react-router';
import {call,errorText} from '../lib/bridge';
import {usePrivacy} from '../lib/privacy';
import {useToast} from '../lib/useToast';
export function IncognitoButton(){
 const privacy=usePrivacy(),toast=useToast(),navigate=useNavigate();const [busy,setBusy]=useState(false);
 const on=privacy.data?.incognito??false;
 const toggle=async()=>{setBusy(true);try{if(on)navigate('/');await call('privacy.incognito',{on:!on});}catch(e){toast.push({level:'error',message:errorText(e)});}finally{setBusy(false);}};
 return <button className={'btn sm incognito-button '+(on?'on':'')} aria-label={on?'Exit incognito':'Start incognito'} aria-pressed={on} disabled={busy||!privacy.data} onClick={()=>void toggle()} title="Private playback skips new history, progress, insights and account sync. Changing mode reloads website players."><EyeOff size={16}/><span>{on?'Incognito on':'Incognito'}</span></button>;
}
export function PrivateTitleButton({mediaId}:{mediaId:number}){
 const privacy=usePrivacy(),toast=useToast();const [busy,setBusy]=useState(false);
 const on=privacy.data?.privateMediaIds.includes(mediaId)??false;
 const toggle=async()=>{setBusy(true);try{await call('privacy.title',{mediaId,on:!on});}catch(e){toast.push({level:'error',message:errorText(e)});}finally{setBusy(false);}};
 return <button className={'btn sm private-title-button '+(on?'on':'')} aria-label="Keep title private" aria-pressed={on} disabled={busy||!privacy.data} onClick={()=>void toggle()} title="Keep this title out of playback history, progress and future sync. Existing remote entries are not removed. Changing privacy reloads website players.">{on?<EyeOff size={15}/>:<ShieldCheck size={15}/>} {on?'Private title':'Keep private'}</button>;
}
