import { Monitor, MonitorUp, Settings2, Volume2 } from 'lucide-react';
import { useState } from 'react';
import { call, errorText, platform } from '../lib/bridge';
export function WirelessDisplay() {
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[opened,setOpened]=useState(false);
  if(platform!=='win32')return null;
  const open=async(target:'connect'|'display'|'sound')=>{
    setBusy(true);setError('');
    try {const result=await call('cast.windowsDisplay',{target});setOpened(true);if(result.fallback)setError('Open “Connect to a wireless display” in Display settings, or press Windows + K.');}
    catch(e){setError(errorText(e)+' Press Windows + K to open the Windows chooser.');}
    finally{setBusy(false);}
  };
  return <section className="wireless-display">
    <div className="wireless-heading"><MonitorUp size={22}/><div><strong>Windows wireless display</strong><span>Miracast · TVs found by Windows + K</span></div></div>
    <p>Uses Windows projection, separately from Google Chrome casting. Windows discovers and connects the display.</p>
    <p className="wireless-sharing">Windows projection can change the desktop’s resolution or scaling. Shares your Windows screen and its audio. Other visible apps can appear on the TV. Use Extend and move AniVerse to the TV for a separate screen.</p>
    <button className="btn primary" disabled={busy} onClick={()=>void open('connect')}><Monitor size={16}/>Find wireless displays</button>
    {opened&&<p role="status">Select your TV in Windows, approve the connection on the TV, then play the episode. Use Windows + K to disconnect.</p>}
    <div className="wireless-settings"><button className="btn sm" disabled={busy} onClick={()=>void open('display')}><Settings2 size={13}/>Display settings</button><button className="btn sm" disabled={busy} onClick={()=>void open('sound')}><Volume2 size={13}/>TV audio</button></div>
    <p className="wireless-resolution">For 4K, choose 3840 × 2160 in Windows Display settings if available. Resolution depends on the PC, TV and wireless connection. AniVerse’s Google Cast 4K switch does not configure Miracast.</p>
    {error&&<p className="err" role="alert">{error}</p>}
  </section>;
}
