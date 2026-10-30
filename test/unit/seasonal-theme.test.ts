import {expect,it,vi} from 'vitest';
import {Store} from '../../app/core/db/store';
import {SettingsService} from '../../app/core/settings';
it('applies the seasonal dark palette once and restores the previous choice after December',()=>{
 const store=new Store(':memory:');const settings=new SettingsService(store);
 settings.update({appearance:{accent:'violet'}});
 // A real update has no rollout marker from an older version.
 store.db.prepare("DELETE FROM kv WHERE key=?").run('theme:festival-2026');
 settings.applySeasonalTheme(new Date(2026,10,1));expect(settings.get().appearance.accent).toBe('festival');
 settings.applySeasonalTheme(new Date(2026,11,31,23,59));expect(settings.get().appearance.accent).toBe('festival');
 settings.applySeasonalTheme(new Date(2027,0,1));expect(settings.get().appearance.accent).toBe('violet');
 settings.applySeasonalTheme(new Date(2027,0,2));expect(settings.get().appearance.accent).toBe('violet');store.close();
});
it('honours an early opt-out and permits manual selection after the promotion ends',()=>{
 const store=new Store(':memory:');const settings=new SettingsService(store);
 settings.applySeasonalTheme(new Date(2026,10,1));settings.update({appearance:{accent:'aqua'}});
 settings.applySeasonalTheme(new Date(2026,10,2));expect(settings.get().appearance.accent).toBe('aqua');
 settings.applySeasonalTheme(new Date(2027,0,1));expect(settings.get().appearance.accent).toBe('aqua');
 const clock=vi.spyOn(Date,'now').mockReturnValue(new Date(2027,0,2).getTime());
 try{settings.update({appearance:{accent:'festival'}});settings.applySeasonalTheme(new Date(2027,0,2));expect(settings.get().appearance.accent).toBe('festival');}finally{clock.mockRestore();store.close();}
});
