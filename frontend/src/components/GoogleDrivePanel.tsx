import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, Download, Upload, FileJson, Link2, LogOut, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import type { DrivePreview } from '../../../app/shared/drive';
import { DRIVE_FOLDER, DRIVE_FILE } from '../../../app/shared/drive';
import { call, errorText } from '../lib/bridge';
import { Switch, ErrorState } from './common';
import { useToast } from '../lib/useToast';

export function GoogleDrivePanel() {
  const state = useQuery({ queryKey: ['drive'], queryFn: () => call('drive.state') });
  const qc = useQueryClient(), toast = useToast();
  const [busy, setBusy] = useState<string | null>(null), [shared, setShared] = useState(false), [folder, setFolder] = useState('');
  const [preview, setPreview] = useState<DrivePreview | null>(null), [applySettings, setApplySettings] = useState(false);
  const run = async (name: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(name);
    try { await action(); } catch (error) { toast.push({ level: 'error', message: errorText(error) }); }
    finally { setBusy(null); await state.refetch(); }
  };
  const s = state.data;
  return <section className="settings-group"><h3>Google Drive sync</h3><div className="card card-pad stack drive-panel">
    <div className="workspace-banner"><Cloud size={30} /><div><h2>Your library, wherever you watch</h2>
      <p>Manually export or import library, progress, history, favourites, scene notes, skip maps, themes and your weekly plan. Videos, credentials, source lists, local file paths and watch insights stay on this device.</p></div></div>
    <ol className="drive-setup"><li>In your Google Cloud project, enable the Google Drive API.</li>
      <li>Configure the OAuth consent screen. While in Testing, add your Google account as a test user.</li>
      <li>Create an OAuth client of type <b>Desktop app</b>, download its JSON and upload it below. Then sign in with Google.</li></ol>
    <div className="row wrap">
      <button className="btn" onClick={() => void call('app.openExternal', { url: 'https://console.cloud.google.com/apis/credentials' })}><ExternalLink size={14} />Google Cloud credentials</button>
      <button className="btn primary" disabled={!!busy} onClick={() => void run('credentials', async () => { await call('drive.configure'); setPreview(null); })}><FileJson size={15} />{s?.configured ? 'Replace OAuth JSON' : 'Upload OAuth JSON'}</button>
      <span className="chip">{s?.connected ? 'Connected' : s?.configured ? 'JSON ready' : 'Not configured'}</span>
    </div>
    <p className="faint">Use your own Desktop OAuth JSON, not an API key or a service-account private key. Credentials remain in the main process and are protected by the OS credential store{ s && !s.persistent ? ' (unavailable here; this connection lasts only until AniVerse closes)' : ''}.</p>
    <label className="row wrap"><Switch label="Shared-folder access" on={shared} onChange={setShared} /><span>Enable shared-folder access on next sign-in</span></label>
    <p className="faint">Default access is limited to files created with your OAuth app. Shared folders across different OAuth clients require Google's broader Drive permission; Google will explicitly ask you to consent. AniVerse still operates only inside the fixed sync folder. Sharing permissions are managed in Google Drive.</p>
    <div className="row wrap"><button className="btn" disabled={!!busy || !s?.configured} onClick={() => void run('connect', async () => { await call('drive.connect', { shared }); setPreview(null); })}><Cloud size={15} />{s?.connected ? 'Reconnect Google' : 'Connect Google'}</button>
      {busy === 'connect' && <button className="btn" onClick={() => void call('drive.cancel')}>Cancel sign-in</button>}
      {s?.connected && <button className="btn" disabled={!!busy} onClick={() => void run('disconnect', async () => { await call('drive.disconnect'); setPreview(null); })}><LogOut size={14} />Disconnect</button>}
    </div>
    <div className="drive-contract"><strong>Keep this folder and format unchanged</strong><code>{DRIVE_FOLDER}/{DRIVE_FILE}</code><p>Folder name and schema version stay stable across AniVerse releases. Export replaces this backup file. Import previews the file, then merges records; newer local library/progress records are retained. Imported skip maps start disabled.</p></div>
    <label className="stack">Shared or existing folder link / ID<input className="input" aria-label="Drive folder link or ID" value={folder} maxLength={500} onChange={(e) => setFolder(e.target.value)} placeholder={s?.folderId ?? 'Leave blank to use your own AniVerse Sync folder'} /></label>
    <div className="row wrap"><button className="btn" disabled={!!busy || !s?.connected} onClick={() => void run('folder', async () => { await call('drive.folder', { value: folder }); setPreview(null); })}><Link2 size={14} />Use folder</button>
      {s?.folderId && <button className="btn" onClick={() => void call('app.openExternal', { url: 'https://drive.google.com/drive/folders/' + s.folderId })}><ExternalLink size={14} />Open selected folder</button>}
      <span className="faint">{s?.sharedAccess ? 'Shared-folder permission' : 'App-created files only'}</span></div>
    <div className="row wrap"><button className="btn primary" disabled={!!busy || !s?.connected} onClick={() => void run('export', async () => { await call('drive.export'); toast.push({ level: 'success', message: 'App data exported to Google Drive.' }); })}><Upload size={15} />EXPORT</button>
      <button className="btn" disabled={!!busy || !s?.connected} onClick={() => void run('preview', async () => setPreview(await call('drive.preview')))}><Download size={15} />IMPORT · preview</button>
      {busy && <span role="status" className="faint">Working: {busy}…</span>}</div>
    {preview && <div className="drive-preview stack"><h3>Review import</h3><p>Backup from AniVerse {preview.summary.appVersion} · {new Date(preview.summary.createdAt).toLocaleString()}</p>
      <div className="row wrap">{(['library', 'progress', 'favourites', 'bookmarks', 'skips', 'history', 'themes'] as const).map((key) => <span className="chip" key={key}>{preview.summary[key]} {key}</span>)}</div>
      <label className="row"><Switch label="Import appearance and player settings" on={applySettings} onChange={setApplySettings} />Also apply appearance and player settings</label>
      <div className="row"><button className="btn primary" disabled={!!busy} onClick={() => void run('import', async () => { await call('drive.import', { ticket: preview.ticket, applySettings }); setPreview(null); await qc.invalidateQueries(); toast.push({ level: 'success', message: 'Google Drive backup merged into AniVerse.' }); })}>Confirm import</button>
        <button className="btn" disabled={!!busy} onClick={() => setPreview(null)}>Cancel</button></div></div>}
    {s?.lastExport && <p className="faint">Last export: {new Date(s.lastExport).toLocaleString()}</p>}
    {s?.lastImport && <p className="faint">Last import: {new Date(s.lastImport).toLocaleString()}</p>}
    {state.error && <ErrorState error={state.error} onRetry={() => void state.refetch()} />}
  </div></section>;
}
