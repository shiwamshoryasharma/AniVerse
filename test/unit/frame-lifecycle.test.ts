import {expect,it,vi} from 'vitest';
import {SiteNavigator} from '../../electron/siteNavigator';
it('continues focus setup when a website disposes an iframe between enumeration and URL access',async()=>{
 const root={framesInSubtree:[] as unknown[]};
 const child={get url():string{throw Error('Render frame was disposed before WebFrameMain could be accessed');},executeJavaScript:vi.fn()};
 root.framesInSubtree=[root,child];
 const guest={id:42,isDestroyed:()=>false,mainFrame:root,getURL:()=> 'https://source.test/episode-1',executeJavaScriptInIsolatedWorld:vi.fn(async()=>({found:true})),insertCSS:vi.fn(async()=> 'focus-key'),removeInsertedCSS:vi.fn(async()=>{})};
 const navigator=new SiteNavigator({} as never,{} as never,'test/cache/no-recipes.json',vi.fn(),async()=>null,()=>false);
 await expect(navigator.focus(guest as never,true,null,50)).resolves.toBe(true);
});
