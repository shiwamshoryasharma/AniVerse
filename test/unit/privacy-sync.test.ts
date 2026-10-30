import {expect,it,vi} from 'vitest';
import {Store} from '../../app/core/db/store';
import {SettingsService} from '../../app/core/settings';
import {SyncService,type TokenSource} from '../../app/core/sync/syncService';
import type {SyncProvider} from '../../app/core/sync/providers';
const media={id:17,idMal:27,title:'Private fixture',cover:'',banner:null,format:'TV' as const,episodes:3};
function setup(token?:()=>Promise<string>){
 const store=new Store(':memory:'),settings=new SettingsService(store);
 store.saveAccount({provider:'anilist',token:'fixture',refreshToken:null,expiresAt:null,userId:1,userName:'Fixture',avatar:null,lastSyncAt:null,lastError:null});
 const provider:SyncProvider={profile:async()=>({userId:1,userName:'Fixture',avatar:null}),pushEntry:vi.fn(async()=>'done' as const),pushFavourite:vi.fn(async()=>'done' as const),pull:vi.fn(async()=>({entries:[{media,status:'CURRENT' as const,progress:2,score:null,updatedAt:100}],favourites:[media]}))};
 const tokens:TokenSource={token:token??(async()=>'fixture'),rejected:async()=>null,status:()=>({configured:true,signingIn:false,secureStorage:true})};
 return {store,provider,sync:new SyncService(store,{anilist:provider,mal:provider},()=>settings.get(),()=>undefined,tokens)};
}
it('never pulls or pushes while incognito is active',async()=>{
 const {store,provider,sync}=setup();store.enqueueSync('anilist','entry',{mediaId:17,idMal:27});store.setIncognito(true);
 await sync.sync();expect(provider.pull).not.toHaveBeenCalled();expect(provider.pushEntry).not.toHaveBeenCalled();
 expect(store.dueSyncJobs('anilist')).toHaveLength(1);store.close();
});
it('does not import a private title or favourite during two-way sync',async()=>{
 const {store,provider,sync}=setup();store.setTitlePrivate(17,true);await sync.sync();
 expect(provider.pull).toHaveBeenCalled();expect(store.getLibraryEntry(17)).toBe(null);expect(store.isFavourite(17)).toBe(false);expect(provider.pushEntry).not.toHaveBeenCalled();store.close();
});
it('rechecks privacy after waiting for a token before sending any title data',async()=>{
 let release!:(token:string)=>void,entered!:()=>void;
 const ready=new Promise<void>(r=>entered=r),waiting=new Promise<string>(r=>release=r);
 const {store,provider,sync}=setup(()=>{entered();return waiting;});
 store.enqueueSync('anilist','entry',{mediaId:17,idMal:27});
 const flush=sync.flush('anilist');await ready;store.setTitlePrivate(17,true);release('fixture');await flush;
 expect(provider.pushEntry).not.toHaveBeenCalled();store.close();
});
