// Real CDP touch preparation: avoid Playwright mouse/trial actions on Android WebView.
import assert from 'node:assert/strict';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const inspectTarget=(element,{scroll=false}={})=>{
 const establishesFixedBlock=css=>css.transform!=='none'||css.perspective!=='none'||css.filter!=='none'||(css.backdropFilter&&css.backdropFilter!=='none')||/layout|paint|strict|content/.test(css.contain);
 if(scroll){
  let fixed=false;
  for(let parent=element.parentElement;parent;parent=parent.parentElement){
   const css=getComputedStyle(parent);
   if(fixed){if(establishesFixedBlock(css))fixed=false;else continue;}
   const r=element.getBoundingClientRect(),p=parent.getBoundingClientRect();
   const delta=(a,b,c,d)=>a<c?a-c:b>d?b-d:0;
   const left=/auto|scroll/.test(css.overflowX)&&parent.scrollWidth>parent.clientWidth+1?delta(r.left,r.right,p.left+(parseFloat(css.scrollPaddingLeft)||0),p.right-(parseFloat(css.scrollPaddingRight)||0)):0;
   const top=/auto|scroll/.test(css.overflowY)&&parent.scrollHeight>parent.clientHeight+1?delta(r.top,r.bottom,p.top+(parseFloat(css.scrollPaddingTop)||0),p.bottom-(parseFloat(css.scrollPaddingBottom)||0)):0;
   if(left||top)parent.scrollBy({left,top,behavior:'instant'});
   if(css.position==='fixed')fixed=true;
  }
 }
 const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
 let left=Math.max(0,rect.left),top=Math.max(0,rect.top),right=Math.min(innerWidth,rect.right),bottom=Math.min(innerHeight,rect.bottom),fixed=false;
 const clips=[];
 for(let parent=element.parentElement;parent;parent=parent.parentElement){
  const css=getComputedStyle(parent),r=parent.getBoundingClientRect();
  if(fixed){if(establishesFixedBlock(css))fixed=false;else continue;}
  if(/auto|scroll|hidden|clip/.test(css.overflowX)){left=Math.max(left,r.left);right=Math.min(right,r.right);}
  if(/auto|scroll|hidden|clip/.test(css.overflowY)){top=Math.max(top,r.top);bottom=Math.min(bottom,r.bottom);}
  if(/auto|scroll|hidden|clip/.test(css.overflowX+' '+css.overflowY))clips.push({class:parent.className,top:r.top,bottom:r.bottom,left:r.left,right:r.right});
  if(css.position==='fixed')fixed=true;
 }
 const x=(left+right)/2,y=(top+bottom)/2,hit=document.elementFromPoint(x,y);
 const ready=element.isConnected&&!element.matches(':disabled,[aria-disabled="true"]')&&style.visibility==='visible'&&Number(style.opacity)>0&&right-left>1&&bottom-top>1&&(hit===element||element.contains(hit));
 return {ready,offsetX:x-rect.left,offsetY:y-rect.top,width:rect.width,height:rect.height,hit:hit?.tagName+' '+hit?.className,clips};
};
export async function touchAndroidTarget(locator,{timeout=10000}={}){
 await locator.waitFor({state:'visible',timeout});
 const session=await locator.page().context().newCDPSession(locator.page());
 try{
 let previous,stable=0,last,point,scrolled=false;
 for(const until=Date.now()+timeout;Date.now()<until;){
  const geometry=await locator.evaluate(inspectTarget);
  const box=await locator.boundingBox();
  const viewport=await locator.page().evaluate(()=>({width:innerWidth,height:innerHeight}));
  const candidate=box&&{x:box.x+geometry.offsetX,y:box.y+geometry.offsetY,width:box.width,height:box.height};
  const ready=geometry.ready&&candidate&&candidate.x>0&&candidate.y>0&&candidate.x<viewport.width&&candidate.y<viewport.height;
  last={...geometry,box,viewport};
  if(!ready&&!scrolled){await locator.evaluate(inspectTarget,{scroll:true});scrolled=true;previous=undefined;stable=0;await delay(60);continue;}
  if(ready&&previous&&['x','y','width','height'].every(key=>Math.abs(candidate[key]-previous[key])<.5))stable++;else stable=0;
  if(stable>=2){point=candidate;break;}
  previous=ready?candidate:undefined;await delay(60);
 }
 assert.ok(point,'No stable, unobstructed touch point for '+locator+': '+JSON.stringify(last));
  await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y,radiusX:1,radiusY:1,force:1}]});
  await delay(80);await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 }finally{await session.detach();}
}
