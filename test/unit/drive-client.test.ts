import { describe, expect, it } from 'vitest';
import { DriveClient, boundedText } from '../../app/core/driveClient';
import { DRIVE_FOLDER } from '../../app/shared/drive';
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
describe('fixed Drive folder and file operations', () => {
  it('fails on ambiguous folders without creating or mutating anything', async () => {
    const calls: string[] = [];
    const client = new DriveClient(async (_url, init) => { calls.push(init?.method ?? 'GET'); return json({ files: [{ id: 'a', name: DRIVE_FOLDER }, { id: 'b', name: DRIVE_FOLDER }] }); }, async () => 'fixture-token');
    await expect(client.folder(null, true)).rejects.toThrow(/Multiple/);
    expect(calls).toEqual(['GET']);
  });
  it('will not create a folder during import', async () => {
    const calls: string[] = [];
    const client = new DriveClient(async (_url, init) => { calls.push(init?.method ?? 'GET'); return json({ files: [] }); }, async () => 'fixture-token');
    await expect(client.folder(null, false)).rejects.toThrow(/No AniVerse/);
    expect(calls).toEqual(['GET']);
  });
  it('rejects a shared folder with a changed name', async () => {
    const client = new DriveClient(async () => json({ id: 'abc', name: 'Renamed folder', mimeType: 'application/vnd.google-apps.folder' }), async () => 'fixture-token');
    await expect(client.folder('abc', false)).rejects.toThrow(/named/);
  });
  it('bounds downloaded bodies even without content-length', async () => {
    await expect(boundedText(new Response('123456'), 5)).rejects.toThrow(/size/);
  });
  it('never overwrites an unrelated file merely because its name matches', async () => {
    let writes = 0;
    const client = new DriveClient(async (_url, init) => {
      if (init?.method) writes++;
      return json({ files: [{ id: 'abc', name: 'aniverse-backup.v1.json', mimeType: 'text/plain' }] });
    }, async () => 'fixture-token');
    await expect(client.upload('folder', '{}', () => undefined)).rejects.toThrow(/another file type/);
    expect(writes).toBe(0);
  });
});
