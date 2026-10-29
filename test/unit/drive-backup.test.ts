import { describe, expect, it } from 'vitest';
import { Store } from '../../app/core/db/store';
import { SettingsService } from '../../app/core/settings';
import { WorkspaceService } from '../../app/core/workspace';
import { BackupService } from '../../app/core/backup';
import { DRIVE_FOLDER, DRIVE_FILE, parseDriveCredentials, parseDriveFolder } from '../../app/shared/drive';

const media = { id: 7, idMal: null, title: 'Fixture series', cover: '', banner: null, format: 'TV' as const, episodes: 12 };

describe('Google Drive setup and portable contract', () => {
  it('keeps the folder and filename independent of release version', () => {
    expect(DRIVE_FOLDER).toBe('AniVerse Sync');
    expect(DRIVE_FILE).toBe('aniverse-backup.v1.json');
  });
  it('accepts desktop OAuth JSON and rejects service-account private keys or custom endpoints', () => {
    expect(parseDriveCredentials({ installed: { client_id: '123-fixture.apps.googleusercontent.com', client_secret: 'fixture' } }).clientId).toContain('apps.googleusercontent.com');
    expect(() => parseDriveCredentials({ type: 'service_account', private_key: 'never-import' })).toThrow(/Desktop|OAuth/i);
    expect(() => parseDriveCredentials({ installed: { client_id: '123-fixture.apps.googleusercontent.com', token_uri: 'https://attacker.test/token' } })).toThrow();
  });
  it('validates shared folder IDs and rejects arbitrary URLs', () => {
    expect(parseDriveFolder('https://drive.google.com/drive/folders/abcdefghijklmno')).toBe('abcdefghijklmno');
    expect(() => parseDriveFolder('https://attacker.test/abcdefghijklmno')).toThrow();
  });
});

describe('app-data backup merge', () => {
  it('roundtrips library, progress and scenes without credentials, source identities or local paths', () => {
    const source = new Store(':memory:');
    const settings = new SettingsService(source);
    settings.update({ appearance: { style: 'aurora' }, accounts: { youtubeApiKey: 'private-fixture-key' } });
    source.setKv('collection:roots', ['C:/private-videos']);
    source.setKv('drive:secret', 'private-oauth-fixture');
    source.saveProgress({ media, episode: 2, position: 90, duration: 1440, sourceId: 'private-source' }, 0.85);
    source.setLibraryEntry(media, 'CURRENT', 1, 8);
    source.setFavourite(media, true);
    new WorkspaceService(source).saveBookmark({ media, episode: 2, position: 90, duration: 1440, sourceId: 'private-source', note: 'A scene', tags: ['favourite'] });
    const backup = new BackupService(source).create('1.5.2');
    const text = JSON.stringify(backup);
    expect(text).not.toMatch(/private-fixture|private-oauth|private-source|private-videos|youtubeApiKey|collection:roots/);
    const destination = new Store(':memory:');
    const service = new BackupService(destination);
    service.restore(backup, true);
    service.restore(backup, true);
    expect(destination.getLibraryEntry(7)).toMatchObject({ progress: 1, score: 8 });
    expect(destination.getProgress(7)[0]).toMatchObject({ position: 90, sourceId: null });
    expect(destination.isFavourite(7)).toBe(true);
    expect(new WorkspaceService(destination).bookmarks({})).toHaveLength(1);
    expect(new SettingsService(destination).get().appearance.style).toBe('aurora');
    source.close(); destination.close();
  });
  it('does not replace newer local progress or remove unrelated local records', () => {
    const source = new Store(':memory:');
    source.setLibraryEntry(media, 'CURRENT', 1, null, 100);
    const backup = new BackupService(source).create('1.5.2');
    const destination = new Store(':memory:');
    destination.setLibraryEntry(media, 'CURRENT', 6, 9, 200);
    destination.setLibraryEntry({ ...media, id: 8 }, 'PLANNING', 0);
    new BackupService(destination).restore(backup, false);
    expect(destination.getLibraryEntry(7)).toMatchObject({ progress: 6, score: 9 });
    expect(destination.getLibraryEntry(8)).not.toBeNull();
    source.close(); destination.close();
  });
  it('rejects incompatible or unsafe backups before modifying the database', () => {
    const store = new Store(':memory:');
    const service = new BackupService(store);
    const backup = service.create('1.5.2');
    expect(() => service.restore({ ...backup, version: 999 }, false)).toThrow();
    expect(() => service.restore({ ...backup, credentials: 'injected' }, false)).toThrow();
    expect(store.listLibrary(null)).toEqual([]);
    store.close();
  });
});
