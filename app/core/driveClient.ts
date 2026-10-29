import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { FetchFn } from './net/http';
import { BACKUP_LIMIT, DRIVE_FILE, DRIVE_FOLDER } from '../shared/drive';

const resource = z.object({ id: z.string().regex(/^[\w-]{1,200}$/), name: z.string(), mimeType: z.string().optional(), capabilities: z.object({ canEdit: z.boolean().optional() }).optional() });
type DriveFile = z.infer<typeof resource>;
const folderMime = 'application/vnd.google-apps.folder';
const base = 'https://www.googleapis.com/drive/v3/files';
export async function boundedText(response: Response, limit: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('Drive response exceeds the allowed size.'); }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('Drive response exceeds the allowed size.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
export class DriveClient {
  constructor(private fetchFn: FetchFn, private accessToken: () => Promise<string>) {}
  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer ' + await this.accessToken());
    const response = await this.fetchFn(url, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(45000) });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new Error('Google Drive sign-in expired. Reconnect your Google account.');
      if (response.status === 403) throw new Error('Drive access denied. Check folder sharing, Drive API setup and the selected access mode.');
      if (response.status === 412) throw new Error('The Drive backup changed during export. Refresh before exporting again.');
      throw new Error('Google Drive request failed (' + response.status + '). Try again later.');
    }
    return response;
  }
  private async list(q: string): Promise<DriveFile[]> {
    const url = new URL(base);
    url.search = new URLSearchParams({ q, fields: 'files(id,name,mimeType,capabilities(canEdit)),nextPageToken', pageSize: '100', spaces: 'drive', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' }).toString();
    const result = z.object({ files: z.array(resource), nextPageToken: z.string().optional() }).parse(JSON.parse(await boundedText(await this.request(url.href), 256000)));
    if (result.nextPageToken) throw new Error('Too many matching Drive items. Select the exact sync folder by its link.');
    return result.files;
  }
  async folder(id: string | null, create: boolean): Promise<DriveFile> {
    if (id) {
      const data = resource.parse(JSON.parse(await boundedText(await this.request(base + '/' + id + '?fields=id,name,mimeType,capabilities(canEdit)&supportsAllDrives=true'), 32000)));
      if (data.name !== DRIVE_FOLDER || data.mimeType !== folderMime) throw new Error('The selected folder must be named "' + DRIVE_FOLDER + '". Keep that name unchanged.');
      return data;
    }
    const matches = await this.list("trashed=false and 'me' in owners and mimeType='" + folderMime + "' and name='" + DRIVE_FOLDER + "'");
    if (matches.length > 1) throw new Error('Multiple "' + DRIVE_FOLDER + '" folders exist. Select the exact folder link; no folder was changed.');
    if (matches[0]) return matches[0];
    if (!create) throw new Error('No AniVerse sync folder found. Export first or select a shared folder link.');
    return resource.parse(JSON.parse(await boundedText(await this.request(base + '?fields=id,name,mimeType,capabilities(canEdit)', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: DRIVE_FOLDER, mimeType: folderMime }),
    }), 32000)));
  }
  private async file(folderId: string): Promise<DriveFile | null> {
    const matches = await this.list("trashed=false and '" + folderId + "' in parents and name='" + DRIVE_FILE + "'");
    if (matches.length > 1) throw new Error('Multiple backup files exist in this folder. Resolve duplicates in Drive before syncing.');
    const file = matches[0] ?? null;
    if (file && file.mimeType !== 'application/json') throw new Error('The fixed backup filename is occupied by another file type.');
    return file;
  }
  async download(folderId: string): Promise<{ text: string; etag: string | null; file: DriveFile }> {
    const file = await this.file(folderId);
    if (!file) throw new Error('No "' + DRIVE_FILE + '" backup exists in this folder.');
    const response = await this.request(base + '/' + file.id + '?alt=media&supportsAllDrives=true');
    return { text: await boundedText(response, BACKUP_LIMIT), etag: response.headers.get('etag'), file };
  }
  async upload(folderId: string, text: string, validateExisting: (data: unknown) => void): Promise<void> {
    if (Buffer.byteLength(text) > BACKUP_LIMIT) throw new Error('Backup exceeds the 25 MB limit.');
    const existing = await this.file(folderId);
    let etag: string | null = null;
    if (existing) {
      if (existing.capabilities?.canEdit === false) throw new Error('This shared backup is read-only.');
      const response = await this.request(base + '/' + existing.id + '?alt=media&supportsAllDrives=true');
      validateExisting(JSON.parse(await boundedText(response, BACKUP_LIMIT)));
      etag = response.headers.get('etag');
    }
    const boundary = 'aniverse_' + randomBytes(16).toString('hex');
    const metadata = existing ? { name: DRIVE_FILE } : { name: DRIVE_FILE, parents: [folderId], mimeType: 'application/json', appProperties: { aniverseSchema: '1' } };
    const body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata)
      + '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + text + '\r\n--' + boundary + '--';
    const response = await this.request('https://www.googleapis.com/upload/drive/v3/files' + (existing ? '/' + existing.id : '') + '?uploadType=multipart&supportsAllDrives=true', {
      method: existing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary, ...(etag ? { 'If-Match': etag } : {}) }, body,
    });
    await response.body?.cancel();
  }
}
