const {app,BrowserWindow,webContents}=require('electron');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');const {createHash}=require('node:crypto');
const {SourceMp4Download}=require('../../../electron/sourceMp4Download');
const {RustPolicy}=require('../../../app/core/security/rustPolicy');
const run=process.env.AV_STREAM_RUN,root=process.env.AV_STREAM_ROOT,report={passed:false,checks:{}};
app.setPath('userData',path.join(run,'profile'));app.disableHardwareAcceleration();app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(fn,label){for(let i=0;i<120;i++){const result=await fn();if(result)return result;await delay(100);}throw Error(label);}
let window,chooser;
(async()=>{await app.whenReady();window=new BrowserWindow({width:800,height:600,show:false,webPreferences:{webviewTag:true,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
await window.loadURL('data:text/html,<body style="margin:0"></body>');
const id=await window.webContents.executeJavaScript(`new Promise(resolve=>{const v=document.createElement('webview');v.style='width:780px;height:560px';v.setAttribute('webpreferences','backgroundThrottling=no,contextIsolation=yes,sandbox=yes');v.src=${JSON.stringify(process.env.AV_STREAM_URL)};v.addEventListener('dom-ready',()=>resolve(v.getWebContentsId()),{once:true});document.body.appendChild(v);})`);
const guest=webContents.fromId(id);let lease=true;
const probe=()=>guest.executeJavaScript('(()=>{const v=document.querySelector("video");return {ready:v.readyState,frames:v.getVideoPlaybackQuality().totalVideoFrames,time:v.currentTime}})()');
await wait(async()=>{const state=await probe();return state.ready>=2&&state.frames>2;},'Video did not decode');
const policy=new RustPolicy(fs.readFileSync(path.join(root,'dist/electron/security.wasm')));
let downloadFolder=path.join(run,'downloads');const service=new SourceMp4Download(policy,()=>downloadFolder);
const selected=await wait(()=>service.inspect(guest),'No selected HLS offer');
await guest.executeJavaScript('window.startChurn()');const before=await probe();
async function saveDialog({cancel=false,revoke=false}={}){
 const stateFile=path.join(run,cancel?'cancel-dialog.json':revoke?'revoke-dialog.json':'dialog.json');
 chooser=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'test/e2e/fixtures/electron-submit-save.ps1'),'-AppPid',String(process.pid),'-Destination',path.join(run,'downloads','Stream Fixture - S02E07.mp4'),'-DelayMilliseconds',cancel?'0':'3500','-StateFile',stateFile,...(cancel?['-Cancel']:[])],{cwd:root,windowsHide:true,stdio:['ignore','ignore','inherit']});
 const closed=once(chooser,'exit');if(revoke)setTimeout(()=>{lease=false;},600);
 let result,error;try{result=await service.saveActive(guest,()=>lease,{title:'Stream Fixture',season:2,episode:7});}catch(value){error=value.message;}
 assert.equal((await closed)[0],0,'Real Save As helper failed');return{result,error,state:JSON.parse(fs.readFileSync(stateFile,'utf8'))};
}
const saved=await saveDialog();assert.equal(saved.error,undefined);assert.equal(saved.result,true);report.dialog=saved.state;
const after=await probe();assert.ok(after.frames>before.frames,'Video stopped decoding');
const refreshed=await service.inspect(guest);report.offers={selected,refreshed};report.pageChurn=await guest.executeJavaScript('performance.getEntriesByType("resource").filter(e=>e.name.includes("inspection=")).map(e=>({name:e.name,type:e.initiatorType}))');assert.equal(refreshed.identity,selected.identity);assert.equal(refreshed.media,selected.media);assert.notEqual(refreshed.url,selected.url,'Audio playlist did not churn');
const file=path.join(run,'downloads','Stream Fixture - S02E07.mp4');const hash=()=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');const beforeHash=hash();
const canceled=await saveDialog({cancel:true});assert.equal(canceled.result,false);assert.equal(hash(),beforeHash);
downloadFolder=path.join(run,'rejected');fs.mkdirSync(downloadFolder);const revoked=await saveDialog({revoke:true});assert.match(revoked.error,/active video changed/);assert.equal(hash(),beforeHash);
report.checks={decodedVideoAdvanced:true,stableVideoIdentity:true,rollingPlaylistChanged:true,realDialogCancel:true,episodeScopeRevalidation:true};report.passed=true;
})().catch(error=>{report.error=error.stack??String(error);}).finally(()=>{if(chooser?.exitCode===null)chooser.kill();window?.destroy();fs.writeFileSync(process.env.AV_STREAM_REPORT,JSON.stringify(report,null,2));app.exit(report.passed?0:1);});