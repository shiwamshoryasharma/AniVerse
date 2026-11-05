/** Safe native/browser-menu canvas; HTML may continue beneath floating chrome. */
export function tabletSafeBounds(main: Pick<DOMRect, 'left'|'top'|'right'|'bottom'>) {
  let left=main.left,top=main.top,right=main.right,bottom=main.bottom;
  const app=document.querySelector<HTMLElement>('.tablet-app');
  const header=document.querySelector<HTMLElement>('.tablet-topbar')?.getBoundingClientRect();
  if(header)top=Math.max(top,header.bottom);
  const search=document.querySelector<HTMLElement>('.tablet-search-dock')?.getBoundingClientRect();
  if(search&&search.width>0&&search.height>0)bottom=Math.min(bottom,search.top-8);
  const nav=document.querySelector<HTMLElement>('#tablet-main-navigation');
  if(nav&&!nav.hidden){
    const r=nav.getBoundingClientRect();
    if(r.width>0&&r.height>0){if(app?.dataset.navigation==='rail')left=Math.max(left,r.right+8);else bottom=Math.min(bottom,r.top-8);}
  }
  return {left,top,right,bottom};
}
