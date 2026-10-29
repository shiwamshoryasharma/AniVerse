import { call,onEvent } from './bridge';
export interface PlayerCaptureSession {ticket:string;stream:MediaStream}
export async function capturePlayer(webContentsId:number,stillRequested:()=>boolean=()=>true):Promise<PlayerCaptureSession>{
  const {ticket}=await call('player.capturePrepare',{webContentsId});
  let revoked=false;
  const detach=onEvent('player.captureEnded',event=>{if(event.ticket===ticket)revoked=true;});
  try{
    const stream=await navigator.mediaDevices.getDisplayMedia({video:{width:{max:3840},height:{max:2160},frameRate:{ideal:30,max:30}},audio:false});
    if(revoked||!stillRequested()){stream.getTracks().forEach(track=>track.stop());throw new Error('Compatibility capture was cancelled.');}
    return {ticket,stream};
  }catch(error){void call('player.captureStop',{ticket}).catch(()=>undefined);throw error;}
  finally{detach();}
}
export async function stopPlayerCapture(session:PlayerCaptureSession){
  session.stream.getTracks().forEach(track=>track.stop());
  await call('player.captureStop',{ticket:session.ticket}).catch(()=>undefined);
}
