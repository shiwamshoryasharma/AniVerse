// Neutral test names; configured source identities remain in the ignored user config.
const {mkdirSync,writeFileSync}=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../..'),artifacts=path.join(root,'test/artifacts');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
module.exports=async({window,webContents})=>{
 mkdirSync(artifacts,{recursive:true});
 const ui=code=>window.webContents.executeJavaScript(code,true);
 const rpc=(method,input)=>ui('window.aniverse.invoke('+JSON.stringify(method)+','+JSON.stringify(input??null)+').catch(e=>({error:e.message}))');
 const until=async(fn,ms)=>{const end=Date.now()+ms;while(Date.now()<end){const value=await fn().catch(()=>null);if(value)return value;await sleep(200);}return null;};
 await until(()=>ui('!!document.querySelector(".app")'),30000);
 await rpc('settings.set',{player:{autoplay:false,upscale:{enabled:false}},updates:{autoCheck:false,autoDownload:false}});
 const details=await rpc('meta.details',{id:Number(process.env.SURVEY_ID??1)});
 if(!details.title)throw Error('Live metadata setup failed: '+(details.error??'No title'));
 const titles=[...new Set([details.title.english,details.title.romaji,details.title.native,...(details.synonyms??[]).slice(0,2)].filter(Boolean))];
 const only=new Set((process.env.SURVEY_SOURCES??'').split(',').filter(Boolean));
 const allSources=(await rpc('sources.list')).filter(source=>source.enabled&&source.kind==='web');
 const indices=new Set((process.env.SURVEY_INDICES??'').split(',').filter(Boolean).map(Number));
 const sources=allSources.filter((source,index)=>(!only.size||only.has(source.id))&&(!indices.size||indices.has(index+1)));
 const results=[];
 for(const source of sources){
  const result={source:allSources.findIndex(item=>item.id===source.id)+1,navigation:false,decodedPlayback:false};let muteTimer;
  const before=(await rpc('adblock.stats')).securityBlocked?.[source.id]??0;
  try{
   await ui('location.hash="#/sources"');await until(()=>ui('!document.querySelector("webview")'),10000);
   await ui('location.hash='+JSON.stringify('#/sources/'+source.id));
   const id=await until(()=>ui('(()=>{try{return document.querySelector("webview")?.getWebContentsId();}catch{return null;}})()'),20000);
   const guest=id&&webContents.fromId(id);if(!guest)throw Error('Source view unavailable');
   result.webdriver=await guest.executeJavaScript('navigator.webdriver');
   muteTimer=setInterval(()=>{if(!guest.isDestroyed())guest.setAudioMuted(true);},50);muteTimer.unref();
   await sleep(1200);
   const nav=await Promise.race([rpc('site.openEpisode',{webContentsId:id,sourceId:source.id,mediaId:details.id,titles,episode:1,focus:true}),sleep(Number(process.env.SURVEY_TIMEOUT??45000)).then(()=>({failure:'timeout'}))]);
   result.navigation=!!nav.ok;result.failure=nav.failure??(nav.ok?null:'unavailable');
   result.episodeCards=nav.episodes?.length??0;result.episodeArtwork=nav.episodes?.filter(card=>card.thumbnail).length??0;
   result.confirmedAudio=[...new Set((nav.episodes??[]).flatMap(card=>card.audio))];
   if(nav.ok){
    await rpc('player.control',{webContentsId:id,action:'play'});
    for(let attempt=0;attempt<2;attempt++){
     const state=await rpc('player.probe',{webContentsId:id});if(state&&!state.paused)break;
     const box=await guest.executeJavaScript('({width:innerWidth,height:innerHeight})');
     guest.sendInputEvent({type:'mouseDown',x:Math.round(box.width/2),y:Math.round(box.height/2),button:'left',clickCount:1});
     guest.sendInputEvent({type:'mouseUp',x:Math.round(box.width/2),y:Math.round(box.height/2),button:'left',clickCount:1});await sleep(1500);
    }
    const first=await until(async()=>{const p=await rpc('player.probe',{webContentsId:id});return p?.video?.readyState>=2?p:null;},15000);
    if(first){await sleep(2000);const second=await rpc('player.probe',{webContentsId:id});result.decodedPlayback=!!second&&!second.paused&&second.currentTime>first.currentTime+.2&&second.video?.width>0;result.media={width:second?.video?.width,height:second?.video?.height,advancedSeconds:second?.currentTime-first.currentTime};}
   }
  }catch(error){result.failure=String(error.message??error).replace(/https?:\/\/\S+/g,'[url]').slice(0,200);}
  finally{clearInterval(muteTimer);}
  result.securityDenied=((await rpc('adblock.stats')).securityBlocked?.[source.id]??0)-before;
  results.push(result);console.log('[live] '+JSON.stringify(result));
 }
 await ui('location.hash="#/sources"');
 const report={version:(await rpc('app.info')).version,metadataId:details.id,episode:1,mutedDuringTest:true,results,physicalAudioChecked:false};
 writeFileSync(path.join(artifacts,/^[a-z0-9-]+\.json$/.test(process.env.SURVEY_REPORT??'')?process.env.SURVEY_REPORT:'security-live-playback.json'),JSON.stringify(report,null,2)+'\n');
};
