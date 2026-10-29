import { z } from 'zod';
// Portable protocol: never derive these names from a release version.
export const DRIVE_FOLDER = 'AniVerse Sync';
export const DRIVE_FILE = 'aniverse-backup.v1.json';
export const BACKUP_LIMIT = 25 * 1024 * 1024;
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_SHARED_SCOPE = 'https://www.googleapis.com/auth/drive';
const desktop = z.object({
  client_id: z.string().regex(/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/),
  client_secret: z.string().min(1).max(500).optional(),
  auth_uri: z.literal('https://accounts.google.com/o/oauth2/auth').or(z.literal('https://accounts.google.com/o/oauth2/v2/auth')).optional(),
  token_uri: z.literal('https://oauth2.googleapis.com/token').optional(),
});
export interface DriveCredentials { clientId: string; clientSecret: string }
export function parseDriveCredentials(input: unknown): DriveCredentials {
  const result = z.object({ installed: desktop }).safeParse(input);
  if (!result.success) throw new Error('Choose the Desktop app OAuth client JSON from Google Cloud. API keys and service-account private keys are not supported.');
  return { clientId: result.data.installed.client_id, clientSecret: result.data.installed.client_secret ?? '' };
}
export function parseDriveFolder(value: string): string {
  const text = value.trim();
  if (!text) return '';
  if (/^[\w-]{10,200}$/.test(text)) return text;
  let url: URL;
  try { url = new URL(text); } catch { throw new Error('Enter a Google Drive folder link or folder ID.'); }
  const match = url.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([\w-]{10,200})\/?$/);
  if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com' || !match) throw new Error('Enter a Google Drive folder link or folder ID.');
  return match[1];
}
export interface DriveState {
  configured: boolean; connected: boolean; sharedAccess: boolean; busy: boolean;
  folderId: string | null; folderName: string; fileName: string;
  persistent: boolean; lastExport: number | null; lastImport: number | null;
}
export interface BackupSummary {
  createdAt: string; appVersion: string; library: number; progress: number; favourites: number;
  bookmarks: number; skips: number; history: number; themes: number; hasPlan: boolean;
}
export interface DrivePreview { ticket: string; summary: BackupSummary }
