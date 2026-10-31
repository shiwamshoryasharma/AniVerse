import type {AudioChoice} from '../../../app/shared/audioAvailability';
export type {AudioChoice} from '../../../app/shared/audioAvailability';
export function AudioFilter({value,onChange,label='Audio availability'}:{value:AudioChoice;onChange:(value:AudioChoice)=>void;label?:string}){
 return <div className="audio-filter" role="group" aria-label={label}>{(['all','dub','sub'] as const).map(audio=><button key={audio} type="button" aria-pressed={value===audio} className={value===audio?'active':''} onClick={()=>onChange(audio)}>{audio.toUpperCase()}</button>)}</div>;
}
export function AudioCoverageNote({value}:{value:AudioChoice}){
 return value==='all'?null:<p className="faint audio-coverage">{value==='dub'?'Series with both SUB and DUB.':'All series with SUB, including series that also have DUB.'}</p>;
}
