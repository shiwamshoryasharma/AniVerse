import { call, isAniVerse2, onEvent } from './bridge';
export interface PlayerCaptureSession {ticket:string;stream:MediaStream;dispose?:()=>void}
export async function capturePlayer(webContentsId:number,stillRequested:()=>boolean=()=>true):Promise<PlayerCaptureSession>{
  const {ticket}=await call('player.capturePrepare',{webContentsId});
  let revoked=false;
  const detach=onEvent('player.captureEnded',event=>{if(event.ticket===ticket)revoked=true;});
  try{
    if (isAniVerse2) return await previewGuest(ticket, () => !revoked && stillRequested());
    const stream=await navigator.mediaDevices.getDisplayMedia({video:{width:{max:3840},height:{max:2160},frameRate:{ideal:30,max:30}},audio:false});
    if(revoked||!stillRequested()){stream.getTracks().forEach(track=>track.stop());throw new Error('Compatibility capture was cancelled.');}
    return {ticket,stream};
  }catch(error){void call('player.captureStop',{ticket}).catch(()=>undefined);throw error;}
  finally{detach();}
}
interface NativeCaptureEvent {
  event: { listen<T>(name: string, callback: (event: { payload: T }) => void): Promise<() => void> };
}

async function previewGuest(ticket: string, requested: () => boolean): Promise<PlayerCaptureSession> {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The Windows capture preview could not create a video surface.');
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  let busy = false, done = false, started = false;
  let first: () => void = () => undefined;
  let failed: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => { first = resolve; failed = reject; });
  const timer = window.setTimeout(() => failed(new Error('WebView2 did not supply a playable source preview.')), 5000);
  const tauri = (window as Window & { __TAURI__?: NativeCaptureEvent }).__TAURI__;
  if (!tauri) {
    clearTimeout(timer);
    track.stop();
    throw new Error('The Windows source preview bridge is unavailable.');
  }
  const offFrame = tauri.event.listen<{ticket:string;jpeg:string}>('aniverse:player/captureFrame', async ({ payload: event }) => {
    if (done || busy || event.ticket !== ticket || !requested()) return;
    busy = true;
    try {
      const bytes = Uint8Array.from(atob(event.jpeg), (byte) => byte.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      try {
        if (done || !requested()) return;
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        context.drawImage(bitmap, 0, 0);
        track.requestFrame();
        if (!started) {
          started = true;
          first();
        }
      } finally { bitmap.close(); }
    } catch {
      if (started) {
        dispose();
        void call('player.captureStop', { ticket }).catch(() => undefined);
      } else {
        failed(new Error('The Windows source preview could not decode a frame.'));
      }
    } finally { busy = false; }
  });
  const offEnded = onEvent('player.captureEnded', (event) => {
    if (event.ticket !== ticket) return;
    dispose();
    failed(new Error('The source changed before compatibility capture could start.'));
  });
  const dispose = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    void offFrame.then((unlisten) => unlisten()).catch(() => undefined);
    offEnded();
    track.stop();
  };
  try {
    await Promise.all([offFrame, ready]);
    clearTimeout(timer);
    if (done || !requested()) throw new Error('Compatibility capture was cancelled.');
    return { ticket, stream, dispose };
  } catch (error) { dispose(); throw error; }
}
export async function stopPlayerCapture(session:PlayerCaptureSession){
  session.dispose?.();
  session.stream.getTracks().forEach(track=>track.stop());
  await call('player.captureStop',{ticket:session.ticket}).catch(()=>undefined);
}
