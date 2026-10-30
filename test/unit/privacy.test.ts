import { expect,it } from 'vitest';
import { Store } from '../../app/core/db/store';
import { BackupService } from '../../app/core/backup';
const media={id:17,idMal:27,title:'Private fixture',cover:'',banner:null,format:'TV' as const,episodes:3};
const save={media,episode:1,position:90,duration:100,sourceId:'fixture'};
it('incognito never writes new progress, history, learned links or outbox jobs',()=>{
 const store=new Store(':memory:');store.setIncognito(true);
 expect(store.saveProgress(save,0.85).completedNow).toBe(false);
 store.setWatched(media,1,true);store.setSiteLink('fixture',17,1,'https://source.test/episode-1');
 store.enqueueSync('anilist','entry',{mediaId:17,idMal:27});
 expect(store.getProgress(17)).toEqual([]);expect(store.listHistory(20,0)).toEqual([]);
 expect(store.getSiteLinks('fixture',17)).toEqual({});expect(store.dueSyncJobs('anilist')).toEqual([]);
 store.setIncognito(false);expect(store.getProgress(17)).toEqual([]);store.close();
});
it('private title rules persist, hide prior history and cancel pending pushes without deleting old progress',()=>{
 const store=new Store(':memory:');store.saveProgress(save,0.85);store.enqueueSync('anilist','entry',{mediaId:17,idMal:27});
 store.setTitlePrivate(17,true);
 expect(store.privacyState().privateMediaIds).toEqual([17]);expect(store.isPrivate(17)).toBe(true);
 expect(store.listHistory(20,0)).toEqual([]);expect(store.dueSyncJobs('anilist')).toEqual([]);
 const before=store.getProgress(17);store.saveProgress({...save,episode:2},0.85);expect(store.getProgress(17)).toEqual(before);
 store.setTitlePrivate(17,false);expect(store.listHistory(20,0)).toHaveLength(1);store.close();
});
it('incognito metadata/cache writes stay in memory and disappear when the session ends',()=>{
 const store=new Store(':memory:');store.setIncognito(true);store.upsertSnapshot(media);store.cacheSet('private-key',{title:media.title},60);
 expect(store.getSnapshot(17)?.title).toBe(media.title);expect(store.cacheGet('private-key')).toEqual({title:media.title});
 expect(store.db.prepare('SELECT COUNT(*) AS n FROM http_cache').get()?.n).toBe(0);
 expect(store.db.prepare('SELECT COUNT(*) AS n FROM media_snapshot').get()?.n).toBe(0);
 store.setIncognito(false);expect(store.cacheGet('private-key')).toBe(null);expect(store.getSnapshot(17)).toBe(null);store.close();
});
it('portable backups exclude private titles and reject exports during incognito',()=>{
 const store=new Store(':memory:');store.saveProgress(save,0.85);store.setLibraryEntry(media,'CURRENT',1);
 store.setTitlePrivate(17,true);const backup=new BackupService(store).create('1.5.8');
 expect(backup.media).toEqual([]);expect(backup.library).toEqual([]);expect(backup.progress).toEqual([]);expect(backup.history).toEqual([]);
 expect(backup.format).toBe('aniverse.backup');expect(backup.version).toBe(1);
 store.setIncognito(true);expect(()=>new BackupService(store).create('1.5.8')).toThrow(/incognito/i);store.close();
});

it('drops cache responses from an earlier privacy context',()=>{
 const store=new Store(':memory:');
 store.setIncognito(true);const context=store.cacheContext();store.setIncognito(false);
 store.cacheSet('late-private',{title:'Private'},60,context);expect(store.cacheGet('late-private')).toBe(null);
 const publicContext=store.cacheContext();store.setTitlePrivate(17,true);
 store.cacheSet('late-public',{title:'Private'},60,publicContext);expect(store.cacheGet('late-public')).toBe(null);store.close();
});
