import { Check, ChevronRight, Cpu, ExternalLink, Info, Monitor, RefreshCw, Settings2, ShieldCheck, Sparkles, Zap } from 'lucide-react';
import { useState } from 'react';
import windowsGuide from '../assets/graphics/windows-graphics.svg';
import rtxGuide from '../assets/graphics/rtx-video.svg';
import { useAppInfo } from '../lib/queries';
import { call, errorText } from '../lib/bridge';
import { useToast } from '../lib/useToast';
import { Select } from './controls';
import type { UiRenderingMode } from '../../../app/shared/graphics';

const TABS = [
  { id: 'overview', label: 'Overview', icon: Monitor },
  { id: 'laptop', label: 'Laptop GPU setup', icon: Settings2 },
  { id: 'rtx', label: 'NVIDIA RTX Video', icon: Sparkles },
] as const;

export function GraphicsPanel() {
  const { data, error, refetch, isFetching } = useAppInfo();
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('overview');
  const graphics = data?.graphics;
  const [savingRendering, setSavingRendering] = useState(false);
  const saveRendering = async (mode: UiRenderingMode) => {
    setSavingRendering(true);
    try { await call('app.setUiRendering', { mode }); await refetch(); }
    catch (e) { toast.push({ level: 'error', message: errorText(e) }); }
    finally { setSavingRendering(false); }
  };
  const toast = useToast();
  const openSettings = () => void call('app.openGraphicsSettings').catch((e) => toast.push({ level: 'error', message: errorText(e) }));
  return (
    <section className="graphics-panel">
      <div className="gpu-title"><span className="gpu-emblem"><Cpu size={25} /></span><div><h2>Graphics & GPU</h2><p>GPU status, laptop setup and video enhancement.</p></div></div>
      <div className="gpu-tabs" role="tablist" aria-label="Graphics sections">
        {TABS.map((item) => <button key={item.id} role="tab" aria-selected={tab === item.id} aria-controls={'gpu-' + item.id} id={'gpu-tab-' + item.id} className={'gpu-tab ' + item.id + (tab === item.id ? ' active' : '')} onClick={() => setTab(item.id)}>
          <item.icon size={17} /> {item.label}
        </button>)}
      </div>
      {error ? <div className="card gpu-content" role="alert">{errorText(error)}</div> : !graphics ? <div className="card gpu-content">Detecting graphics adapters…</div> : (
        <div className="card gpu-content" role="tabpanel" id={'gpu-' + tab} aria-labelledby={'gpu-tab-' + tab}>
          {tab === 'overview' && <>
            <div className="gpu-active"><span className="gpu-chip"><Monitor size={28} /></span><div><span className="gpu-eyebrow">ACTIVE GRAPHICS</span><h3>{graphics.activeAdapter ?? 'Not confirmed'}</h3><div className="gpu-badges">
              <span className={graphics.hardwareDecode ? 'gpu-badge success' : 'gpu-badge warning'}><ShieldCheck size={13} /> Hardware video decoding {graphics.hardwareDecode ? 'available' : 'unavailable'}</span>
              <span className="gpu-badge purple"><Zap size={13} /> {graphics.preference === 'high-performance' ? 'Dedicated GPU preferred' : 'System preference'}</span>
            </div></div></div>
            {graphics.warning && <p className="gpu-notice"><Info size={18} />{graphics.warning}</p>}
            <section className="gpu-rendering">
              <h3>Interface rendering</h3>
              <p>Stable UI avoids GPU composition of text, buttons and menus. Video decoding, Anime4K and sender encoding can still use the GPU.</p>
              <Select<UiRenderingMode> ariaLabel="Interface rendering" width={250} disabled={savingRendering} value={graphics.uiRendering.preferred} onChange={mode=>void saveRendering(mode)}
                options={[{value:'stable',label:'Stable UI · recommended'},{value:'accelerated',label:'Accelerated UI'}]} />
              <p className="faint">Active: {graphics.uiRendering.active === 'stable' ? 'Stable UI' : 'Accelerated UI'}. This device only. Stable composition may use more CPU.</p>
              {graphics.uiRendering.restartRequired && <div className="row" role="status"><span>Restart AniVerse to apply this change.</span><button className="btn sm" onClick={()=>void call('app.restart').catch(e=>toast.push({level:'error',message:errorText(e)}))}><RefreshCw size={14}/>Restart AniVerse</button></div>}
            </section>
            <div className="gpu-list-label">Detected adapters</div>
            <div className="gpu-devices">{graphics.adapters.map((gpu) => <div className={'gpu-device ' + gpu.kind} key={gpu.vendorId + ':' + gpu.deviceId + ':' + gpu.name}>
              <span className="gpu-device-icon"><Cpu size={21} /></span><div><b>{gpu.name}</b><span>{gpu.kind === 'dedicated' ? 'Dedicated graphics' : gpu.kind === 'integrated' ? 'Integrated graphics' : gpu.kind === 'software' ? 'Software fallback' : 'Adapter type unconfirmed'}</span></div>
              {gpu.active && <span className="gpu-active-tag"><Check size={13} /> In use</span>}
            </div>)}</div>
            <div className="gpu-footer"><p>Adapter selection is reported by Chromium. Each video format may use a different decode path.</p><button className="btn ghost sm" disabled={isFetching} onClick={() => void refetch()}><RefreshCw size={14} /> Refresh detection</button></div>
          </>}
          {tab === 'laptop' && <>
            <div className="gpu-guide-heading"><Settings2 size={22} /><div><h3>Choose your dedicated GPU</h3><p>A quick setup for hybrid and gaming laptops.</p></div></div>
            <img className="gpu-guide-image" src={windowsGuide} alt="Illustrated Windows graphics setup: open Graphics settings, select AniVerse, choose High performance and save." />
            <ol className="gpu-steps">
              <li><span>1</span><div><b>Open graphics settings</b><p>In Windows, go to Settings <ChevronRight size={12} /> System <ChevronRight size={12} /> Display <ChevronRight size={12} /> Graphics.</p></div></li>
              <li><span>2</span><div><b>Select AniVerse</b><p>Choose AniVerse from the app list. If it is missing, add a desktop app and select AniVerse.exe from its installation folder.</p></div></li>
              <li><span>3</span><div><b>Choose High performance</b><p>Open the app's graphics options, select the dedicated GPU and save. Close and reopen AniVerse, then check Overview.</p></div></li>
            </ol>
            {data.platform.startsWith('win32') ? <button className="btn gpu-action" onClick={openSettings}><Settings2 size={16} /> Open Windows graphics settings <ExternalLink size={14} /></button> : <p className="gpu-notice"><Info size={18} />These illustrated steps are for Windows. On other systems, use your operating system's GPU selection controls.</p>}
          </>}
          {tab === 'rtx' && <>
            <div className="gpu-guide-heading nvidia"><Sparkles size={23} /><div><h3>Sharper video with NVIDIA RTX</h3><p>Set up the driver's optional video enhancements.</p></div></div>
            <img className="gpu-guide-image" src={rtxGuide} alt="Illustrated RTX Video setup: update the NVIDIA driver, enable Video Super Resolution, then play a supported video." />
            <ol className="gpu-steps nvidia">
              <li><span>1</span><div><b>Update your NVIDIA driver</b><p>Use NVIDIA's official app to keep the driver current. RTX Video needs compatible hardware and software.</p></div></li>
              <li><span>2</span><div><b>Enable RTX Video Super Resolution</b><p>Open NVIDIA's video settings and enable the enhancement. Available controls vary with your driver version.</p></div></li>
              <li><span>3</span><div><b>Play and check</b><p>Start a supported video and check the enhancement status in NVIDIA's app. Source resolution and playback conditions affect eligibility.</p></div></li>
            </ol>
            <p className="gpu-notice"><Info size={18} />Hardware decoding does not prove AI upscaling is active. AniVerse reports GPU selection; NVIDIA's driver controls RTX enhancement.</p>
            <button className="btn gpu-action nvidia" onClick={() => void call('app.openExternal', { url: 'https://developer.nvidia.com/rtx-video-sdk' }).catch((e) => toast.push({ level: 'error', message: errorText(e) }))}><ExternalLink size={15} /> Official NVIDIA RTX Video information</button>
          </>}
        </div>
      )}
    </section>
  );
}
