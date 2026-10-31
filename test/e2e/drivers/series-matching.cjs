const {app,BrowserWindow,session}=require('electron');
const {mkdirSync,writeFileSync}=require('node:fs');
const path=require('node:path');
const root=process.env.ANIVERSE_MATCH_ROOT,cache=path.join(root,'test/cache/series-matching'),artifacts=path.join(root,'test/artifacts');
mkdirSync(artifacts,{recursive:true});app.setPath('userData',path.join(cache,'profile'));
const {pageScript,SiteNavigator,Store}=require(path.join(cache,'runtime.cjs'));
const titles=['Tougen Anki: Nikko・Kegon no Taki-hen','TOUGEN ANKI: Nikko Kegon Falls Arc','桃源暗鬼 2期','Tougen Anki Season 2'];
const checks=[],errors=[];
function check(name,condition,actual){checks.push({name,passed:!!condition,actual});console.log('['+(condition?'PASS':'FAIL')+'] '+name+' '+JSON.stringify(actual));}
app.whenReady().then(async()=>{
 let win;
 try{
  const ses=session.fromPartition('series-matching-fixture');
  let body='';
  await ses.protocol.handle('https',request=>new Response('<!doctype html><meta charset="utf-8"><style>a{display:inline-block;margin:16px;padding:16px}h3{font:18px sans-serif}</style>'+body,{headers:{'Content-Type':'text/html'}}));
  win=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{session:ses,sandbox:true,contextIsolation:true,nodeIntegration:false}});
  const load=async html=>{body=html;await win.loadURL('https://stream-one.test/search');};
  const op=args=>win.webContents.executeJavaScriptInIsolatedWorld(1017,[{code:pageScript(args)}]);
  const card=(slug,title)=>'<a href="/anime/'+slug+'"><span>7.2 · TV · 24m</span><h3>'+title+'</h3><span>SUB 5 · DUB 4</span></a>';
  await load('<h1>Search</h1>'+card('original','TOUGEN ANKI')+card('mini','TOUGEN ANKI Mini Anime')+card('arc','TOUGEN ANKI: Nikko Kegon Falls Arc'));
  const hits=await op({op:'findTitle',titles,season:2});
  check('An arc alias without a season marker resolves ahead of its parent and mini series',hits?.[0]?.href==='https://stream-one.test/anime/arc',hits);
  await load('<title>TOUGEN ANKI: Nikko Kegon Falls Arc</title><h1>TOUGEN ANKI: Nikko Kegon Falls Arc</h1>');
  const heading=await op({op:'titleCheck',titles,season:2});
  check('The arc landing page passes validation even when only a metadata alias says Season 2',heading.score>=.72,heading);
  await load(card('first','My Hero Academia')+card('second','My Hero Academia Season 2')+card('third','My Hero Academia Season 3'));
  const seasons=await op({op:'findTitle',titles:['My Hero Academia Season 2'],season:2});
  check('Explicit seasons remain distinct and the unqualified parent is not accepted for Season 2',seasons?.length===1&&seasons[0].href.endsWith('/second'),seasons);
  await load(card('native','桃源暗鬼 日光・華厳の滝編')+card('parent','桃源暗鬼'));
  const native=await op({op:'findTitle',titles:[...titles,'桃源暗鬼 日光・華厳の滝編'],season:2});
  check('A Japanese arc alias works without confusing the Japanese parent title',native?.[0]?.href.endsWith('/native'),native);
  await load(card('first','Frieren: Beyond Journey’s End')+card('other','Frieren Mini Anime'));
  const first=await op({op:'findTitle',titles:['Frieren: Beyond Journey’s End','Sousou no Frieren'],season:1});
  check('Unnumbered first-series matching is preserved',first?.[0]?.href.endsWith('/first'),first);
  await load(card('part-one','Skybound Chronicle Season 4 Part 1')+card('part-two','Skybound Chronicle 4th Season Part II')+card('part-three','Skybound Chronicle S4 Part 3'));
  const parts=await op({op:'findTitle',titles:['Skybound Chronicle Season IV Part 2'],season:4});
  check('Ordinal, shorthand and Roman season aliases normalize while different parts stay separate',parts?.length===1&&parts[0].href.endsWith('/part-two'),parts);
  await load(card('jp-second','星の旅 第2期')+card('jp-third','星の旅 第3期'));
  const jp=await op({op:'findTitle',titles:['星の旅 2期'],season:2});
  check('Japanese season markers reject the explicitly different Japanese season',jp?.length===1&&jp[0].href.endsWith('/jp-second'),jp);
  await load('<div class="episodes"><a href="/watch/arc/1" data-episode="1"><img src="/stills/one.webp"><span>Episode 1</span></a><a href="/watch/arc/2" data-episode="2"><img data-src="/stills/two.webp"><span>Episode 2</span></a><a href="/episode/opaque-id"><img data-src="/stills/three.webp"><span>EP 03</span><b>SUB</b></a></div><aside><a href="/watch/unrelated/1"><img src="/posters/unrelated.webp">Episode 1</a></aside>');
  const cards=await op({op:'episodeCards',slug:'arc'});
  check('Episode artwork is read from each episode card including lazy images, not related series',cards?.length===3&&cards[2].episode===3&&cards[2].audio.includes('sub')&&cards[0].episode===1&&cards[0].thumbnail==='https://stream-one.test/stills/one.webp'&&cards[1].thumbnail==='https://stream-one.test/stills/two.webp',cards);
 }catch(error){errors.push(String(error.stack||error));console.error(error);}
 finally{if(win&&!win.isDestroyed())win.destroy();writeFileSync(path.join(artifacts,'series-matching.json'),JSON.stringify({passed:!errors.length&&checks.every(row=>row.passed),checks,errors},null,2)+'\n');app.exit(!errors.length&&checks.every(row=>row.passed)?0:1);}
});
