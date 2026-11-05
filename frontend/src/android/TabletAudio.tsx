import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { nativeCall } from './native';

export type SourceAudio = 'sub'|'dub';
export type AudioFilter = 'all'|SourceAudio|'unknown';
interface AudioState { available:SourceAudio[];selected:SourceAudio|null }
export function AudioBadge({value}:{value:SourceAudio|null|undefined}) {
  return <span className="chip" data-audio={value??'unknown'}>{value?value.toUpperCase():'Audio unknown'}</span>;
}
export function AudioFilters({value,onChange,label}:{value:AudioFilter;onChange:(value:AudioFilter)=>void;label:string}) {
  return <div className="row tablet-audio-filters" role="group" aria-label={label}>{(['all','sub','dub','unknown'] as const).map(audio=><button key={audio} className={'btn sm '+(value===audio?'primary':'ghost')} aria-pressed={value===audio} data-audio-filter={audio} onClick={()=>onChange(audio)}>{audio==='all'?'All audio':audio==='unknown'?'Unknown audio':audio.toUpperCase()}</button>)}</div>;
}
export function TabletAudio({session,active,onChange,onBusyChange}:{session:string;active:boolean;onChange?:(value:SourceAudio|null)=>void;onBusyChange?:(busy:boolean)=>void}) {
  const [state,setState]=useState<AudioState>({available:[],selected:null});
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const callbacks=useRef({onChange,onBusyChange});callbacks.current={onChange,onBusyChange};
  const sequence=useRef(0),current=useRef<SourceAudio|null>(null);
  const read=useCallback(async(value?:SourceAudio)=>{
    if(!session||!active)return;
    const ticket=++sequence.current;setBusy(true);setError('');callbacks.current.onBusyChange?.(true);
    try{
      const next=await nativeCall<AudioState>('playback.audio',{session,...(value?{value}:{})});
      if(ticket!==sequence.current)return;
      setState(next);
      if(current.current!==next.selected){current.current=next.selected;callbacks.current.onChange?.(next.selected);}
    }catch(reason){if(ticket===sequence.current)setError(reason instanceof Error?reason.message:String(reason));}
    finally{if(ticket===sequence.current){setBusy(false);callbacks.current.onBusyChange?.(false);}}
  },[session,active]);
  useEffect(()=>{
    sequence.current++;current.current=null;setState({available:[],selected:null});setError('');setBusy(false);
    if(active)void read();
    return()=>{sequence.current++;callbacks.current.onBusyChange?.(false);};
  },[read,active]);
  return <div className="tablet-audio-selector" data-selected-audio={state.selected??'unknown'}>
    <div className="row" role="group" aria-label="Source audio">
      <span className="faint">Audio</span>
      {state.available.map(audio=><button type="button" key={audio} className={'btn sm '+(state.selected===audio?'primary':'ghost')} disabled={!active||busy} aria-pressed={state.selected===audio} aria-label={'Play '+audio.toUpperCase()} onClick={()=>void read(audio)}>{audio.toUpperCase()}</button>)}
      <button type="button" className="icon-btn" aria-label="Refresh source audio options" title="Read audio options from the source" disabled={!active||busy} onClick={()=>void read()}><RefreshCw size={15}/></button>
      {busy&&<small role="status">Checking source…</small>}
      {!busy&&!state.available.length&&<small className="faint">Use the website's audio controls</small>}
    </div>
    {error&&<small className="tablet-error" role="alert">{error}</small>}
  </div>;
}
