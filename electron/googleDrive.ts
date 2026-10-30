import { dialog, type BrowserWindow } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Store, SecretCodec } from '../app/core/db/store';
import type { FetchFn } from '../app/core/net/http';
import { BackupService } from '../app/core/backup';
import { DriveClient } from '../app/core/driveClient';
import { parseDriveCredentials, parseDriveFolder, DRIVE_FOLDER, DRIVE_FILE, type DriveCredentials, type DriveState, type DrivePreview } from '../app/shared/drive';
import type { AppBackup } from '../app/shared/backup';
import { authorizeGoogle, googleTokens, type GoogleTokens } from './driveOAuth';

interface StoredDrive { credentials: DriveCredentials; tokens: GoogleTokens | null; shared: boolean; folderId: string | null }
export class GoogleDriveService {
  private data: StoredDrive | null = null;
  private busy = false;
  private auth: AbortController | null = null;
  private refresh: Promise<string> | null = null;
  private pending: { ticket: string; backup: AppBackup; expires: number } | null = null;
  private client: DriveClient;
  private backups: BackupService;
  constructor(private store: Store, private codec: SecretCodec, private persistent: boolean, private fetchFn: FetchFn,
    private version: string, private window: () => BrowserWindow | null, private open: (url: string) => Promise<void>) {
    if (persistent) {
      const secret = store.getKv<string | null>('drive:secret', null);
      try {
        if (secret) {
          const parsed = JSON.parse(codec.decrypt(secret)) as StoredDrive;
          parseDriveCredentials({ installed: { client_id: parsed.credentials.clientId, client_secret: parsed.credentials.clientSecret || undefined } });
          this.data = parsed;
        }
      } catch { this.data = null; }
    }
    this.client = new DriveClient(fetchFn, () => this.token());
    this.backups = new BackupService(store);
  }
  private save() { this.store.setKv('drive:secret', this.persistent && this.data ? this.codec.encrypt(JSON.stringify(this.data)) : null); }
  snapshot(): DriveState {
    return { configured: !!this.data, connected: !!this.data?.tokens, sharedAccess: this.data?.shared ?? false, busy: this.busy,
      folderId: this.data?.folderId ?? null, folderName: DRIVE_FOLDER, fileName: DRIVE_FILE, persistent: this.persistent,
      lastExport: this.store.getKv('drive:lastExport', null), lastImport: this.store.getKv('drive:lastImport', null) };
  }
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('A Google Drive operation is already running.');
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }
  async configure(): Promise<DriveState> {
    return this.run(async () => {
      const win = this.window();
      const options = { title: 'Choose Google Desktop OAuth client JSON', filters: [{ name: 'JSON credentials', extensions: ['json'] }], properties: ['openFile' as const] };
      const selection = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (selection.canceled || !selection.filePaths[0]) return this.snapshot();
      const file = selection.filePaths[0];
      if ((await stat(file)).size > 64000) throw new Error('The OAuth client JSON is too large.');
      const credentials = parseDriveCredentials(JSON.parse(await readFile(file, 'utf8')));
      this.data = { credentials, tokens: null, shared: false, folderId: null };
      this.pending = null; this.save();
      return this.snapshot();
    });
  }
  async connect(shared: boolean): Promise<DriveState> {
    return this.run(async () => {
      if (!this.data) throw new Error('Upload your Desktop OAuth client JSON first.');
      const controller = new AbortController(); this.auth = controller;
      try {
        const tokens = await authorizeGoogle(this.data.credentials, shared, this.fetchFn, this.open, controller.signal);
        this.data = { ...this.data, tokens, shared, folderId: null };
        this.pending = null; this.save(); return this.snapshot();
      } finally { this.auth = null; }
    });
  }
  cancel() { this.auth?.abort(); }
  async disconnect(): Promise<DriveState> {
    return this.run(async () => {
      const tokens = this.data?.tokens;
      if (this.data) this.data = { ...this.data, tokens: null, folderId: null };
      this.pending = null; this.save();
      if (tokens) {
        try {
          const response = await this.fetchFn('https://oauth2.googleapis.com/revoke', { method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokens.refreshToken || tokens.accessToken }).toString(),
            redirect: 'error', signal: AbortSignal.timeout(10000) });
          await response.body?.cancel();
        } catch { /* Local disconnect remains effective when Google is unreachable. */ }
      }
      return this.snapshot();
    });
  }
  private async token(): Promise<string> {
    const data = this.data;
    if (!data?.tokens) throw new Error('Connect your Google account first.');
    if (data.tokens.expiresAt > Date.now() + 60000) return data.tokens.accessToken;
    if (!data.tokens.refreshToken) throw new Error('Google sign-in expired. Reconnect your account.');
    if (this.refresh) return this.refresh;
    this.refresh = googleTokens(this.fetchFn, { client_id: data.credentials.clientId, client_secret: data.credentials.clientSecret,
      grant_type: 'refresh_token', refresh_token: data.tokens.refreshToken }, data.tokens.refreshToken).then((tokens) => {
      data.tokens = tokens; this.save(); return tokens.accessToken;
    }).finally(() => { this.refresh = null; });
    return this.refresh;
  }
  async selectFolder(value: string): Promise<DriveState> {
    return this.run(async () => {
      if (!this.data?.tokens) throw new Error('Connect Google Drive first.');
      const id = parseDriveFolder(value);
      if (id) await this.client.folder(id, false);
      this.data.folderId = id || null;
      this.pending = null; this.save(); return this.snapshot();
    });
  }
  async export(): Promise<DriveState> {
    return this.run(async () => {
      if (!this.data?.tokens) throw new Error('Connect Google Drive first.');
      const folder = await this.client.folder(this.data.folderId, true);
      if (folder.capabilities?.canEdit === false) throw new Error('This Drive folder is read-only.');
      const privacyContext=this.store.cacheContext();
      const backup=this.backups.create(this.version);
      await this.client.upload(folder.id, JSON.stringify(backup), (data) => { this.backups.validate(data); },()=>{
        if(this.store.cacheContext()!==privacyContext||this.store.isIncognito())throw new Error('Privacy settings changed during export. Export again to build a fresh backup.');
      });
      this.data.folderId = folder.id; this.store.setKv('drive:lastExport', Date.now()); this.save();
      return this.snapshot();
    });
  }
  async preview(): Promise<DrivePreview> {
    return this.run(async () => {
      if (!this.data?.tokens) throw new Error('Connect Google Drive first.');
      const folder = await this.client.folder(this.data.folderId, false);
      const file = await this.client.download(folder.id);
      const backup = this.backups.validate(JSON.parse(file.text));
      const ticket = randomUUID();
      this.pending = { ticket, backup, expires: Date.now() + 600000 };
      return { ticket, summary: this.backups.summary(backup) };
    });
  }
  async import(ticket: string, applySettings: boolean) {
    return this.run(async () => {
      const pending = this.pending;
      if (!pending || pending.ticket !== ticket || pending.expires < Date.now()) throw new Error('The import preview expired. Preview the Drive backup again.');
      this.pending = null;
      const summary = this.backups.restore(pending.backup, applySettings);
      this.store.setKv('drive:lastImport', Date.now());
      return summary;
    });
  }
}
