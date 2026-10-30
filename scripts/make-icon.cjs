// Render the existing vector mark or its temporary variant; keep generator state under test/.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),cache=path.join(root,'test/cache/icon-render');
fs.mkdirSync(cache,{recursive:true});app.setPath('userData',path.join(cache,'profile'));
const seasonal=process.argv.includes('--seasonal');
app.whenReady().then(async()=>{
 const svg=fs.readFileSync(path.join(root,'frontend/public',seasonal?'festival-icon.svg':'favicon.svg'),'utf8');
 const win=new BrowserWindow({width:512,height:512,show:false,frame:false,transparent:true,useContentSize:true,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false}});
 try{
  await win.loadURL('data:text/html;base64,'+Buffer.from('<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64')+'" width="512" height="512"></body></html>').toString('base64'));
  await new Promise(resolve=>setTimeout(resolve,300));
  const image=await win.webContents.capturePage({x:0,y:0,width:512,height:512});
  fs.writeFileSync(path.join(root,'build',seasonal?'seasonal-icon.png':'icon.png'),image.toPNG());
  console.log('Rendered '+(seasonal?'seasonal':'standard')+' icon');
 }finally{win.destroy();app.quit();}
});
