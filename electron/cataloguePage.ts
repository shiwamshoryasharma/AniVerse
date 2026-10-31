import type {AudioChoice} from '../app/shared/audioAvailability';
export interface CatalogueRawCard {title:string;url:string;image:string|null;anilistId:number|null;sub:number|null;dub:number|null;total:number|null}
export interface CatalogueSnapshot {items:CatalogueRawCard[];active:string|null;canFilter:boolean;hasNext:boolean;empty:boolean}
type Op={kind:'read'|'filter'|'next';audio?:AudioChoice};
export function catalogueScript(op:Op){return '('+PAGE.toString()+')('+JSON.stringify(op)+')';}
/** Fixed DOM operations only: public catalogue cards and the website's own controls. */
function PAGE(op:Op):unknown{
 const text=(node:Element|null)=>node?.textContent?.replace(/\s+/g,' ').trim()??'';
 const headings=[...document.querySelectorAll('h1,h2,h3')];
 const heading=headings.find(node=>/^(latest episodes?|recently updated|latest updates?|latest releases?)$/i.test(text(node)));
 let scope:Element=heading??document.querySelector('main')??document.body;
 if(heading)while(scope.parentElement&&!scope.querySelector('a[href] img'))scope=scope.parentElement;
 const controls=()=>[...scope.querySelectorAll('button,a,[role="tab"],input[type="radio"]')];
 const label=(node:Element)=>text(node)||node.getAttribute('aria-label')||node.getAttribute('value')||'';
 const active=(node:Element)=>node.getAttribute('aria-pressed')==='true'||node.getAttribute('aria-selected')==='true'||node.getAttribute('data-state')==='active'||/\b(?:active|selected|current|text-primary)\b/.test(node.className);
 const tabs=controls().filter(node=>/^(all|sub|dub)$/i.test(label(node)));
 const next=controls().find(node=>/\b(next|older|next page)\b/i.test(label(node)+' '+node.getAttribute('title'))||!!node.querySelector('svg use[href*="chevron-right"],svg use[href*="arrow-right"],svg.lucide-chevron-right,svg.lucide-arrow-right'));
 const disabled=(node:Element)=>node.hasAttribute('disabled')||node.getAttribute('aria-disabled')==='true';
 if(op.kind==='filter'){const tab=tabs.find(node=>label(node).toLowerCase()===op.audio);if(!tab)return false;if(!active(tab))(tab as HTMLElement).click();return true;}
 if(op.kind==='next'){if(!next||disabled(next))return false;(next as HTMLElement).click();return true;}
 const url=(value:string|null)=>{try{const result=new URL(value??'',location.href);return /^https?:$/.test(result.protocol)&&!result.username&&!result.password?result:null;}catch{return null;}};
 const items=new Map<string,CatalogueRawCard>();
 for(const anchor of scope.querySelectorAll('a[href]')){
  if(items.size>=48)break;
  const image=anchor.querySelector('img'),target=url(anchor.getAttribute('href'));
  if(!image||!target||target.hostname.replace(/^www\./,'')!==location.hostname.replace(/^www\./,'')||/\/(?:search|genre|login|user|schedule)(?:\/|$)/i.test(target.pathname)||target.pathname==='/')continue;
  const title=text(anchor.querySelector('h1,h2,h3,h4,h5,[data-anime-title],[class*="title" i]'))||image.getAttribute('alt')||'';
  if(!title||title.length>300)continue;
  const cover=url(image.getAttribute('data-src')||image.getAttribute('data-original')||(image as HTMLImageElement).currentSrc||image.getAttribute('src'));
  const count=(kind:string):number|null=>{
   const data=anchor.getAttribute('data-'+kind+'-count')||anchor.querySelector('[data-'+kind+'-count]')?.getAttribute('data-'+kind+'-count');
   const parse=(value:string|null)=>value&&/^\d{1,5}$/.test(value.trim())?Number(value.trim()):null;
   if(parse(data??null)!==null)return parse(data!);
   for(const node of anchor.querySelectorAll('[title],[aria-label]')){
    const name=(node.getAttribute('title')||node.getAttribute('aria-label')||'').toLowerCase();
    if((kind==='sub'&&/\bsub(?:bed|titled)?\b/.test(name))||(kind==='dub'&&/\bdub(?:bed)?\b/.test(name))||(kind==='total'&&/\btotal episodes?\b/.test(name))){
     const n=text(node).match(/^\s*(\d{1,5})\s*$/);if(n)return Number(n[1]);
    }
   }
   const label=new RegExp('(^|[\\s_-])'+(kind==='sub'?'sub(?:bed|titled)?':kind==='dub'?'dub(?:bed)?':'total')+'([\\s_-]|$)','i');
   for(const node of anchor.querySelectorAll('[class]'))if(label.test(node.className)){const n=parse(text(node));if(n!==null)return n;}
   const icon=anchor.querySelector(kind==='sub'?'svg use[href*="subtitles"],svg.lucide-subtitles':kind==='dub'?'svg use[href*="mic"],svg.lucide-mic':'svg use[href*="list-video"]');
   if(icon){const box=icon.tagName.toLowerCase()==='use'?icon.parentElement?.parentElement:icon.parentElement;const n=parse(text(box??null));if(n!==null)return n;}
   return null;
  };
  const publicLink=[...anchor.querySelectorAll('[href]')].map(node=>url(node.getAttribute('href'))).find(link=>link?.hostname==='anilist.co'&&/^\/anime\/\d+/.test(link.pathname));
  const explicit=anchor.getAttribute('data-anilist-id')||anchor.querySelector('[data-anilist-id]')?.getAttribute('data-anilist-id');
  const file=cover&&/(^|\.)anilist\.co$/.test(cover.hostname)?cover.pathname.match(/\/media\/anime\/cover\/[^/]+\/[a-z]{0,2}(\d+)(?:[-.]|$)/i)?.[1]:null;
  const anilistId=Number(explicit||publicLink?.pathname.match(/\/anime\/(\d+)/)?.[1]||file)||null;
  items.set(target.href,{title,url:target.href,image:cover?.href??null,anilistId,sub:count('sub'),dub:count('dub'),total:count('total')});
 }
 return {items:[...items.values()],active:tabs.find(active)?label(tabs.find(active)!).toLowerCase():null,canFilter:tabs.some(tab=>label(tab).toLowerCase()==='dub'),hasNext:!!next&&!disabled(next),empty:/\b(no (?:anime|results|episodes|titles)(?: found| match)?|nothing found)\b/i.test(text(scope))} satisfies CatalogueSnapshot;
}
