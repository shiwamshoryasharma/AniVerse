import {trustedAppUrl} from '../app/shared/trustedOrigin';
import {seasonalVisuals} from '../app/shared/seasonal';
import {SourceCatalogue} from './sourceCatalogue';
import {SourceAudioIndex} from '../app/core/sources/audioIndex';
import {RustPolicy} from '../app/core/security/rustPolicy';
import { app, BrowserWindow, Menu, dialog, safeStorage, session, shell, webContents, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Store, type SecretCodec } from '../app/core/db/store';
import { CommentsService } from '../app/core/comments';
import { AniListClient } from '../app/core/metadata/anilist';
import type { FetchFn } from '../app/core/net/http';
import { SettingsService } from '../app/core/settings';
import { SourceRegistry, WebSiteAdapter } from '../app/core/sources/registry';
import { YouTubeAdapter } from '../app/core/sources/youtube';
import { AniListSync, MalSync } from '../app/core/sync/providers';
import { SyncService } from '../app/core/sync/syncService';
import { AppError } from '../app/core/util';
import { EVENT_CHANNEL, type EventContract, type EventName } from '../app/shared/rpc';
import type { Provider } from '../app/shared/types';
import { Adblocker } from './adblock';
import { CloudflareSolver } from './cloudflare';
import { SitesConfigWatcher } from './configWatcher';
import { registerRpc, type Handlers } from './ipc';
import { MediaProbe, MediaProtocols, registerSchemes } from './media';
import { AccountManager } from './accounts';
import { deepLinkFromArgv, registerDeepLinks } from './deepLink';
import { OAuthBroker, parseCallback, redactLink } from './oauth';
import { isDev, resolvePaths } from './paths';
import { browserUserAgent, SessionManager } from './sessions';
import { SiteNavigator } from './siteNavigator';
import { CastService } from './cast/castService';
import { CastClient } from './cast/castv2';
import { ChromeCast } from './cast/chromeCast';
import { Sender4K } from './cast/sender4k';
import { isPlayerCapturePermission } from './cast/capturePermission';
import { PlayerCapture } from './playerCapture';
import { WindowsDisplay } from './cast/windowsDisplay';
import { WebsiteMirror } from './cast/websiteMirror';
import { UpdateService } from './updater';
import { WorkspaceService } from '../app/core/workspace';
import { buildWatchPlan, type WatchPlan } from '../app/shared/workspace';
import { pendingRelease } from '../app/shared/release';
import { subtitleTextToVtt } from '../app/shared/subtitles';
import { LocalCollection } from './collection';
import { GoogleDriveService } from './googleDrive';
import { ChangelogService } from '../app/core/changelog';
import { UiRenderingPreferences } from './uiRendering';
import { summarizeGraphics, type GpuPreference } from '../app/shared/graphics';

// Ask Chromium for the discrete adapter on hybrid laptops before GPU initialization.
// Explicit low-power/system choices remain available for battery use or driver troubleshooting.
const gpuPreference: GpuPreference = process.env.ANIVERSE_GPU_PREFERENCE === 'system' || app.commandLine.hasSwitch('force_low_power_gpu') ? 'system' : 'high-performance';
if (gpuPreference === 'high-performance') app.commandLine.appendSwitch('force_high_performance_gpu');

registerSchemes();
app.setName('AniVerse');
// Must precede the single-instance lock, which lives in the userData folder:
// a test profile then never collides with (or focuses) the user's running app.
if (process.env.ANIVERSE_DATA_DIR) app.setPath('userData', path.resolve(process.env.ANIVERSE_DATA_DIR));
// Keep Windows UI composition off the driver's presentation path. GPU video decoding,
// WebGL Anime4K and embedded encoders remain available; this is not disableHardwareAcceleration().
const uiRendering = new UiRenderingPreferences(path.join(app.getPath('userData'), 'graphics.json'), process.platform, app.commandLine.hasSwitch('disable-gpu-compositing'));
if (uiRendering.snapshot().active === 'stable') app.commandLine.appendSwitch('disable-gpu-compositing');

// Background work (sync, discovery, filter downloads) must never surface as a
// main-process error dialog; log it instead.
process.on('unhandledRejection', (reason) => console.error('[main] unhandled rejection:', reason));
process.on('uncaughtException', (err) => console.error('[main] uncaught exception:', err));
app.setAppUserModelId('app.aniverse.desktop');

// aniverse:// links (OAuth redirects) arrive before the app is ready on macOS and
// through a second instance's command line on Windows/Linux: buffer until bootstrap.
const pendingLinks: string[] = [];
let onDeepLink: ((url: string) => void) | null = null;
const deliverDeepLink = (url: string) => (onDeepLink ? onDeepLink(url) : pendingLinks.push(url));
app.on('open-url', (event, url) => {
  event.preventDefault();
  deliverDeepLink(url);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    focusMainWindow();
    const link = deepLinkFromArgv(argv);
    const mentions = argv.filter((a) => /aniverse:/i.test(a)).map(redactLink);
    accountsLog(`second instance: ${argv.length} args, link ${link ? redactLink(link) : 'none'}${!link && mentions.length ? ` (args mentioning aniverse: ${mentions.join(' | ')})` : ''}`);
    if (link) deliverDeepLink(link);
  });
  const startLink = deepLinkFromArgv(process.argv);
  if (startLink) deliverDeepLink(startLink);
  app.whenReady().then(bootstrap).catch((err) => {
    console.error('[main] failed to start:', err);
    app.exit(1);
  });
}

let mainWindow: BrowserWindow | null = null;
/** Set by the E2E harness: run without ever showing windows. */
const HEADLESS = process.env.ANIVERSE_HEADLESS === '1';
/** Test runs use their own profile and must not take over the user's aniverse:// handler. */
const TEST_RUN = HEADLESS || !!process.env.ANIVERSE_DATA_DIR || !!process.env.ANIVERSE_TEST_DRIVER;

/** AniVerse's OAuth client IDs, compiled in from config/oauth.json (scripts/oauthConfig.mjs). */
declare const __ANIVERSE_OAUTH__: { anilistClientId: string; malClientId: string } | undefined;
const BUILT_CLIENT_IDS: Record<Provider, string> =
  typeof __ANIVERSE_OAUTH__ === 'undefined' ? { anilist: '', mal: '' } : { anilist: __ANIVERSE_OAUTH__.anilistClientId, mal: __ANIVERSE_OAUTH__.malClientId };

/**
 * Packaged builds use the compiled-in IDs only. Development reads config/oauth.json
 * (and the ANIVERSE_*_CLIENT_ID variables) live, so new IDs work without restarting `npm run dev`.
 */
function oauthClientIds(): Record<Provider, string> {
  if (!isDev) return BUILT_CLIENT_IDS;
  let file: { anilist?: { clientId?: string }; myanimelist?: { clientId?: string } } = {};
  try {
    file = JSON.parse(readFileSync(path.join(app.getAppPath(), 'config', 'oauth.json'), 'utf8'));
  } catch {
    // no file: fall back to the compiled values
  }
  const anilist = String(process.env.ANIVERSE_ANILIST_CLIENT_ID ?? file.anilist?.clientId ?? '').trim();
  const mal = String(process.env.ANIVERSE_MAL_CLIENT_ID ?? file.myanimelist?.clientId ?? '').trim();
  return {
    anilist: /^\d{1,12}$/.test(anilist) ? anilist : BUILT_CLIENT_IDS.anilist,
    mal: /^[a-f0-9]{16,64}$/i.test(mal) ? mal : BUILT_CLIENT_IDS.mal,
  };
}

function emit<E extends EventName>(event: E, payload: EventContract[E]) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(EVENT_CHANNEL, event, payload);
}

/** Diagnostics without secrets: <userData>/logs/<name>.log, restarted past 256 KB. */
function logTo(name: 'accounts' | 'updates', message: string) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.log`);
    if (existsSync(file) && statSync(file).size > 256 * 1024) writeFileSync(file, '');
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // diagnostics must never break the feature they describe
  }
}

/** Sign-in diagnostics (no tokens, codes or state values). */
const accountsLog = (message: string) => logTo('accounts', message);

function focusMainWindow() {
  const win = mainWindow;
  if (!win || win.isDestroyed() || HEADLESS) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (!win.isFocused()) win.flashFrame(true);
}

/** A random id per AniVerse profile (data folder): credentials are bound to it. */
function profileId(dir: string): string {
  const file = path.join(dir, 'profile.id');
  try {
    const id = readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{32}$/.test(id)) return id;
  } catch {
    // first run
  }
  const id = randomBytes(16).toString('hex');
  writeFileSync(file, id);
  return id;
}

/**
 * Encrypts account tokens with the OS credential store (Windows DPAPI, macOS
 * Keychain, Linux Secret Service/KWallet via safeStorage) and binds them to this
 * profile, so a database copied to another profile or user can't use them.
 * Without an OS store, tokens are kept for this session only (memory key).
 */
function secretCodec(profile: string): { codec: SecretCodec; secure: boolean } {
  const bind = (s: string) => `${profile}\n${s}`;
  const unbind = (s: string) => {
    const at = s.indexOf('\n');
    if (at < 0 || s.slice(0, at) !== profile) throw new Error('credential belongs to another profile');
    return s.slice(at + 1);
  };
  const weakLinux = process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text';
  if (!safeStorage.isEncryptionAvailable() || weakLinux) {
    console.warn('[main] no OS credential store; account sessions last until AniVerse quits.');
    const key = randomBytes(32);
    return {
      secure: false,
      codec: {
        encrypt: (s) => {
          const iv = randomBytes(12);
          const cipher = createCipheriv('aes-256-gcm', key, iv);
          const body = Buffer.concat([cipher.update(bind(s), 'utf8'), cipher.final()]);
          return `mem:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
        },
        decrypt: (s) => {
          if (!s.startsWith('mem:')) throw new Error('credential needs the OS store');
          const raw = Buffer.from(s.slice(4), 'base64');
          const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
          decipher.setAuthTag(raw.subarray(12, 28));
          return unbind(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
        },
      },
    };
  }
  return {
    secure: true,
    codec: {
      encrypt: (s) => `enc2:${safeStorage.encryptString(bind(s)).toString('base64')}`,
      decrypt: (s) => {
        if (s.startsWith('enc2:')) return unbind(safeStorage.decryptString(Buffer.from(s.slice(5), 'base64')));
        if (s.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')); // earlier versions
        throw new Error('unencrypted credential');
      },
    },
  };
}

async function bootstrap() {
  const paths = resolvePaths();
  const securityManifest=JSON.parse(readFileSync(path.join(__dirname,'security-manifest.json'),'utf8')) as {sha256:string};
  if(!/^[a-f0-9]{64}$/.test(securityManifest.sha256))throw new Error('Invalid security manifest.');
  const security=new RustPolicy(readFileSync(path.join(__dirname,'security.wasm')),securityManifest.sha256);
  // No default app menu in production: it would add reload/devtools accelerators.
  if (!isDev) Menu.setApplicationMenu(null);
  app.userAgentFallback = browserUserAgent();

  const credentials = secretCodec(profileId(path.dirname(paths.db)));
  const store = new Store(paths.db, credentials.codec);
  store.cachePurge();
  const settings = new SettingsService(store);
  settings.applySeasonalTheme();
  setInterval(()=>settings.applySeasonalTheme(),60_000).unref();
  const changelog = new ChangelogService(store, app.getVersion());
  const workspace = new WorkspaceService(store);
  const apiFetch: FetchFn = (url, init) => session.defaultSession.fetch(url, init);
  const drive = new GoogleDriveService(store, credentials.codec, credentials.secure, apiFetch, app.getVersion(), () => mainWindow, (url) => shell.openExternal(url));

  const adblock = new Adblocker(paths.adblockCache, paths.filtersFile, (stats) => emit('adblock.stats', stats));
  const cloudflare = new CloudflareSolver(
    () => mainWindow,
    (e) => emit('cloudflare.status', e),
    !HEADLESS,
  );

  // The registry needs a fetcher and the fetcher needs the registry: wire lazily.
  let sessions!: SessionManager;
  const fetcher = { get: (id: string, url: string, opts?: { accept?: string; timeoutMs?: number }) => sessions.get(id, url, opts) };
  const anilist = new AniListClient(apiFetch, store, {
    showAdult: () => settings.get().appearance.showAdult,
    token: () => store.getAccount('anilist')?.token ?? null,
  });
  const youtube = new YouTubeAdapter(apiFetch, fetcher, store, () => settings.get().accounts.youtubeApiKey);
  const sourceAudio=new SourceAudioIndex();
  let navigator!: SiteNavigator;
  const registry = new SourceRegistry(store, fetcher, [new WebSiteAdapter(), youtube], () => navigator.book());
  navigator = new SiteNavigator(
    store,
    registry,
    paths.recipesFile,
    (e) => emit('site.status', e),
    (wc) => probe.probe(wc.id),
    () => settings.get().player.autoplay,
    (wc, action, value) => probe.control(wc.id, action, value),
    (wc,url)=>protocols.artwork.grant(wc,url),
    (sourceId,mediaId,cards)=>sourceAudio.observe(sourceId,mediaId,cards),
  );
  sessions = new SessionManager(
    registry,
    adblock,
    cloudflare,
    () => settings.get(),
    (n) => emit('app.notice', n),
    (e) => emit('cloudflare.status', e),
    security,
    () => store.isIncognito(),
  );
  const comments = new CommentsService(anilist, apiFetch, store, () => settings.get(), youtube, () => oauthClientIds().mal);
  const providers = { anilist: new AniListSync(anilist), mal: new MalSync(apiFetch, anilist) };

  // Accounts: sign-in in the system browser, back through aniverse:// deep links.
  const broker = new OAuthBroker(oauthClientIds, (url) => shell.openExternal(url, { activate: true }));
  const accounts = new AccountManager(store, broker, providers, apiFetch, oauthClientIds, credentials.secure);
  const sync = new SyncService(store, providers, () => settings.get(), (e) => emit('sync.status', e), accounts);
  if (!TEST_RUN) registerDeepLinks();
  onDeepLink = (url) => {
    const cb = parseCallback(url);
    const outcome = broker.handleUrl(url);
    accountsLog(`link ${redactLink(url)} → ${outcome}${cb ? ` (${cb.provider}: token=${!!cb.token} code=${!!cb.code} state=${!!cb.state} error=${cb.error ?? '-'})` : ''}`);
    if (outcome !== 'unknown') focusMainWindow();
    if (outcome !== 'accepted') console.warn(`[deep-link] ${outcome === 'ignored' ? 'no matching sign-in for' : 'unhandled'} ${redactLink(url)}`);
  };
  for (const url of pendingLinks.splice(0)) onDeepLink(url);

  const config = new SitesConfigWatcher(paths.sitesFile, (parsed) => {
    registry.setEntries(parsed.entries);
    sessions.refresh();
    emit('sources.changed', sessions.sourceList());
    if (parsed.warnings.length) emit('app.notice', { level: 'warn', message: `streaming-sites.txt: ${parsed.warnings[0]}` });
  });
  registry.setEntries(config.load().entries);
  config.start();
  const updates = new UpdateService(
    () => settings.get(),
    (s) => emit('update.status', s),
    (m) => logTo('updates', m),
  );
  settings.onChange((s) => {
    sessions.refresh();
    updates.applySettings(s);
  });

  const protocols = new MediaProtocols(paths.renderer, paths.profileDir,security);
  protocols.install();
  const catalogue=new SourceCatalogue(()=>sessions.sourceList(),sessions,security,protocols.artwork,anilist);
  const collection = new LocalCollection(store,protocols,()=>mainWindow);
  const mediaResources = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'build/vendor');
  const chromeCast = new ChromeCast(path.join(paths.dataDir, 'cast-chrome'), undefined, undefined, (message) => emit('app.notice', { level: 'info', message }));
  let cast!: CastService;
  let mirror: WebsiteMirror | null = null;
  const sender4k = new Sender4K(path.join(mediaResources, 'ffmpeg'), app.isPackaged ? path.join(process.resourcesPath, 'anime4k') : path.join(app.getAppPath(), 'assets/anime4k'), path.join(paths.dataDir, 'cast-4k'), () => { void cast.stop(); emit('app.notice', { level: 'error', message: 'Sender-side 4K encoding stopped. Check GPU support and retry.' }); });
  cast = new CastService(
    (s) => { emit('cast.status', s); mirror?.onCastState(s); },
    (u) => protocols.localPath(u),
    sender4k,
    (device) => device.transport === 'chrome' ? chromeCast.client(device.id) : new CastClient(),
  );
  const probe = new MediaProbe(
    () => mainWindow?.webContents ?? null,
    (wc) => sessions.isGuestOf(wc) !== null,
  );

  /** Resolves a source webview hosted by the main window (and, optionally, owned by `sourceId`). */
  const guestFor = (webContentsId: number, sourceId?: string): WebContents => {
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed() || wc.getType() !== 'webview' || wc.hostWebContents !== mainWindow?.webContents) {
      throw new AppError('not-found', 'That page is no longer open.');
    }
    const owner = sessions.isGuestOf(wc);
    if (!owner || (sourceId && registry.get(owner).partition !== registry.get(sourceId).partition)) {
      throw new AppError('unauthorised', 'That page does not belong to this source.');
    }
    return wc;
  };

  const saveProfileImage = async (kind: 'avatar' | 'banner', dataUrl: string | null) => {
    await mkdir(paths.profileDir, { recursive: true });
    for (const ext of ['png', 'jpg', 'webp']) await rm(path.join(paths.profileDir, `${kind}.${ext}`), { force: true });
    if (!dataUrl) return settings.update({ profile: { [kind]: null } });
    const [, mime, data] = dataUrl.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/)!;
    const ext = mime === 'jpeg' ? 'jpg' : mime;
    await writeFile(path.join(paths.profileDir, `${kind}.${ext}`), Buffer.from(data, 'base64'));
    return settings.update({ profile: { [kind]: `media://profile/${kind}.${ext}?v=${Date.now()}` } });
  };

  const captures = new PlayerCapture(() => mainWindow, (id) => guestFor(id), (event) => emit('player.captureEnded', event));
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => captures.handle(request, callback));
  const windowsDisplay = new WindowsDisplay(process.platform, (uri) => shell.openExternal(uri, { activate: true }));
  mirror = new WebsiteMirror(cast, sender4k, captures, (id) => guestFor(id), (message) => emit('app.notice', { level: 'error', message }));
  hardenDefaultSession((wc) => captures.canCapture(wc));

  const handlers: Handlers = {
    'changelog.state': () => changelog.state(),
    'changelog.markSeen': ({ version }) => changelog.markSeen(version),
    'drive.state': () => drive.snapshot(),
    'drive.configure': () => drive.configure(),
    'drive.connect': ({ shared }) => drive.connect(shared),
    'drive.cancel': () => drive.cancel(),
    'drive.disconnect': () => drive.disconnect(),
    'drive.folder': ({ value }) => drive.selectFolder(value),
    'drive.export': () => drive.export(),
    'drive.preview': () => drive.preview(),
    'drive.import': async ({ ticket, applySettings }) => { const result = await drive.import(ticket, applySettings); settings.reload(); return result; },
    'meta.home': () => anilist.home(),
    'meta.browse': (q) => anilist.browse(q),
    'meta.details': ({ id }) => anilist.details(id),
    'meta.search': ({ q }) => anilist.search(q),
    'meta.schedule': ({ from, to }) => anilist.schedule(from, to),
    'meta.genres': () => anilist.genres(),
    'meta.latest': ({ page }) => anilist.latest(page),
    'meta.hover': ({ id }) => anilist.hoverInfo(id),

    'sources.list': () => sessions.sourceList(),
    'sources.catalogue':request=>catalogue.list(request),
    'sources.audio':()=>sourceAudio.list(new Set(registry.list().filter(source=>source.enabled).map(source=>source.id)),id=>store.isPrivate(id)),
    'sources.reload': () => {
      config.reload(true);
      return sessions.sourceList();
    },
    'sources.update': ({ id, patch }) => {
      const source = registry.update(id, patch);
      sessions.refresh();
      emit('sources.changed', sessions.sourceList());
      return source;
    },
    'sources.openConfig': async () => {
      const error = await shell.openPath(paths.sitesFile);
      if (error) throw new AppError('config', error);
      return { path: paths.sitesFile };
    },
    'sources.match': ({ sourceId, media }) => registry.match(sourceId, media),
    'sources.streams': ({ sourceId, ref }) => registry.streams(sourceId, ref),
    'sources.discover': async ({ id }) => {
      const source = await registry.discover(id, true);
      emit('sources.changed', sessions.sourceList());
      return source;
    },
    'sources.session': ({ id }) => sessions.sessionInfo(id),
    'sources.clearSession': ({ id }) => sessions.clear(id),
    'sources.pin': ({ sourceId, mediaId, url }) => {
      registry.get(sourceId);
      store.setPin(sourceId, mediaId, url);
    },

    'site.openEpisode': (req) => {const guest=guestFor(req.webContentsId,req.sourceId);return navigator.openEpisode(guest,sessions.sourceForSession(guest.session)??registry.get(req.sourceId),req);},
    'site.focus': async ({ webContentsId, on }) => ({ focused: await navigator.focus(guestFor(webContentsId), on, null) }),
    'site.options': ({ webContentsId }) => navigator.options(guestFor(webContentsId)),
    'site.episodes':({webContentsId})=>navigator.episodeCards(guestFor(webContentsId)),
    'site.choose': ({ webContentsId, sourceId, kind, value }) => navigator.choose(guestFor(webContentsId, sourceId), registry.get(sourceId), kind, value),
    'site.forget': ({ sourceId, mediaId }) => {
      registry.get(sourceId);
      store.clearSiteLinks(sourceId, mediaId);
      store.setPin(sourceId, mediaId, null);
    },


    'toolkit.bookmarks': (input) => workspace.bookmarks(input),
    'toolkit.saveBookmark': (input) => {if(store.isPrivate(input.media.id))throw new AppError('invalid-input','Scene saving is disabled during private playback.');return workspace.saveBookmark(input);},
    'toolkit.deleteBookmark': ({id}) => workspace.deleteBookmark(id),
    'toolkit.skips': ({mediaId}) => workspace.skips(mediaId),
    'toolkit.saveSkip': (range) => {if(store.isPrivate(range.mediaId))throw new AppError('invalid-input','Skip-map saving is disabled during private playback.');return workspace.saveSkip(range);},
    'toolkit.deleteSkip': ({mediaId,kind}) => workspace.deleteSkip(mediaId,kind),
    'toolkit.record': (point) => { if(settings.get().privacy.watchInsights) workspace.record(point); },
    'toolkit.insights': () => workspace.insights(),
    'toolkit.clearInsights': () => workspace.clearInsights(),
    'planner.get': () => store.getKv<WatchPlan|null>('planner:v1',null),
    'planner.build': async ({budget,startDate}) => {
      const entries=store.listLibrary(null).filter((entry)=>['CURRENT','PLANNING','REPEATING'].includes(entry.status)).slice(0,20);
      const candidates=await Promise.all(entries.map(async(entry)=>{
        const details=await anilist.details(entry.media.id).catch(()=>null);
        if(!details || pendingRelease(details,entry.progress+1)?.title)return null;
        const available=details.status==='FINISHED' ? (details.episodes??entry.progress) : details.nextAiring ? Math.max(0,details.nextAiring.episode-1) : entry.progress;
        return {media:entry.media,progress:entry.progress,available,minutes:details.duration??24,estimated:details.duration===null};
      }));
      const plan=buildWatchPlan(candidates.filter((entry)=>entry!==null),budget,startDate);
      store.setKv('planner:v1',plan); return plan;
    },
    'collection.list': () => collection.list(),
    'collection.scan': ({choose}) => collection.scan(choose),
    'collection.match': ({id,media,episode}) => collection.match(id,media,episode),
    'collection.remove': ({id}) => collection.remove(id),
    'collection.open': ({id}) => collection.open(id),
    'themes.list': () => workspace.themes(),
    'themes.save': ({name}) => workspace.saveTheme(name,settings.get()),
    'themes.apply': ({id}) => { const preset=workspace.theme(id); return settings.update({appearance:preset.appearance,player:preset.player}); },
    'themes.delete': ({id}) => workspace.deleteTheme(id),
    'themes.import': async () => {
      const options={title:'Import an AniVerse theme',properties:['openFile' as const],filters:[{name:'AniVerse theme',extensions:['json']}]};
      const result=mainWindow?await dialog.showOpenDialog(mainWindow,options):await dialog.showOpenDialog(options);
      if(result.canceled || !result.filePaths[0])return null;
      const info=await stat(result.filePaths[0]); if(info.size>20000)throw new AppError('invalid-input','Theme files must be smaller than 20 KB.');
      let parsed:unknown; try {parsed=JSON.parse(await readFile(result.filePaths[0],'utf8'));}catch{throw new AppError('invalid-input','Choose a valid theme JSON file.');}
      return workspace.importTheme(parsed);
    },
    'themes.export': async ({id}) => {
      const preset=workspace.theme(id);
      const options={title:'Export visual theme',defaultPath:preset.name.replace(/[^a-zA-Z0-9 _-]/g,'')+'.aniverse-theme.json',filters:[{name:'Theme JSON',extensions:['json']}]};
      const result=mainWindow?await dialog.showSaveDialog(mainWindow,options):await dialog.showSaveDialog(options);
      if(result.canceled || !result.filePath)return {saved:false};
      await writeFile(result.filePath,JSON.stringify(preset,null,2)+'\n','utf8'); return {saved:true};
    },
    'player.openSubtitles': async () => {
      const options={title:'Import subtitles',properties:['openFile' as const],filters:[{name:'Subtitle files',extensions:['vtt','srt']}]};
      const result=mainWindow?await dialog.showOpenDialog(mainWindow,options):await dialog.showOpenDialog(options);
      if(result.canceled || !result.filePaths[0])return null;
      const file=result.filePaths[0]; const info=await stat(file);
      if(info.size>2000000)throw new AppError('invalid-input','Subtitle files must be smaller than 2 MB.');
      try {return {name:path.basename(file),text:subtitleTextToVtt(await readFile(file,'utf8'))};}
      catch {throw new AppError('invalid-input','Choose a valid UTF-8 WebVTT or SRT subtitle file.');}
    },

    'profile.setImage': ({ kind, dataUrl }) => saveProfileImage(kind, dataUrl),
    'profile.clearImage': ({ kind }) => saveProfileImage(kind, null),

    'library.continue': () => store.continueWatching(24),
    'library.state': ({ mediaId }) => ({
      favourite: store.isFavourite(mediaId),
      entry: store.getLibraryEntry(mediaId),
      progress: store.getProgress(mediaId),
      pinned: store.getPins(mediaId),
    }),
    'library.saveProgress': (save) => {
      const result = store.saveProgress(save, settings.get().player.completeThreshold);
      if (result.completedNow && store.getLibraryEntry(save.media.id)) sync.queue('entry', save.media);
      return { completedNow: result.completedNow };
    },
    'library.markWatched': ({ media, episode, watched }) => {
      store.setWatched(media, episode, watched);
      sync.queue('entry', media);
    },
    'library.history': ({ limit, offset }) => store.listHistory(limit, offset),
    'library.clearHistory': ({ id }) => store.clearHistory(id),
    'library.dismissContinue': ({ mediaId }) => store.dismissContinue(mediaId),
    'library.favourites': () => store.listFavourites(),
    'library.toggleFavourite': ({ media }) => {
      const favourite = store.toggleFavourite(media);
      sync.queue('favourite', media, favourite);
      return { favourite };
    },
    'library.entries': ({ status }) => store.listLibrary(status),
    'library.setStatus': ({ media, status }) => {
      store.setLibraryEntry(media, status);
      sync.queue('entry', media);
    },
    'library.setScore': ({ media, score }) => {
      const entry = store.getLibraryEntry(media.id);
      if (!entry) throw new AppError('invalid-input', 'Add the title to your list before scoring it.');
      store.setLibraryEntry(media, entry.status, entry.progress, score === null ? null : Math.round(score * 10) / 10);
      sync.queue('entry', media);
    },

    'accounts.list': () => sync.accounts(),
    'accounts.connect': async ({ provider }) => {
      accountsLog(`connect ${provider}: opening the sign-in page in the browser`);
      try {
        await accounts.connect(provider);
      } catch (err) {
        accountsLog(`connect ${provider}: failed — ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
      accountsLog(`connect ${provider}: connected as ${store.getAccount(provider)?.userName ?? '?'}`);
      // First sync right away: import the list (two-way) and send changes made while signed out.
      void sync.sync(provider);
      return sync.accounts().find((a) => a.provider === provider)!;
    },
    'accounts.cancel': ({ provider }) => accounts.cancel(provider),
    'accounts.disconnect': ({ provider }) => accounts.disconnect(provider),
    'accounts.sync': ({ provider }) => sync.sync(provider),

    'comments.list': (q) => comments.list(q),
    'comments.post': ({ threadId, body }) => comments.post(threadId, body),

    'settings.get': () => settings.get(),
    'settings.set': (patch) => {
      const next = settings.update(patch);
      emit('sources.changed', sessions.sourceList());
      return next;
    },

    'player.openFile': () => protocols.pick(mainWindow),

    'cast.mirrorPrepare': ({ webContentsId, deviceId, title, upscale }) => mirror!.prepare(webContentsId, deviceId, title, upscale, settings.get().player.upscale),
    'cast.mirrorChunk': ({ ticket, sequence, bytes }) => mirror!.push(ticket, sequence, bytes),
    'cast.mirrorStop': ({ ticket }) => mirror!.stop(ticket),
    'cast.windowsDisplay': ({ target }) => windowsDisplay.open(target),
    'player.capturePrepare': ({ webContentsId }) => captures.prepare(webContentsId, 'upscale'),
    'player.captureStop': ({ ticket }) => captures.stop(ticket),
    'cast.capabilities': () => cast.capabilities(),
    'cast.devices': () => cast.scan(),
    'cast.chromeDevices': async () => { const devices = cast.rememberDevices(await chromeCast.scan()); if (!HEADLESS) mainWindow?.focus(); return devices; },
    'cast.chromeClose': () => chromeCast.closeIfIdle(),
    'cast.start': ({ deviceId, media }) => cast.start(deviceId, media, settings.get().player.upscale),
    'cast.control': ({ action, value }) => cast.control(action, value),
    'cast.stop': () => cast.stop(),
    'cast.state': () => cast.snapshot(),
    'player.upscale': ({ webContentsId, options }) => probe.upscale(webContentsId, options),
    'player.probe': ({ webContentsId }) => probe.probe(webContentsId),
    'player.control': ({ webContentsId, action, value }) => probe.control(webContentsId, action, value),

    'adblock.stats': () => adblock.snapshot(),
    'adblock.update': () => adblock.update(),
    'app.info': async () => {
      const info = await app.getGPUInfo('complete').catch(() => null);
      const aux = (info as { auxAttributes?: { glRenderer?: string } } | null)?.auxAttributes;
      return {
        security:security.snapshot(),
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        platform: `${process.platform} ${process.arch}`,
        configPath: paths.sitesFile,
        dataPath: paths.dataDir,
        graphics: { ...summarizeGraphics(info, app.getGPUFeatureStatus(), gpuPreference), renderer: aux?.glRenderer ?? null, uiRendering: uiRendering.snapshot() },
      };
    },
    'privacy.state': () => store.privacyState(),
    'privacy.incognito': async ({on}) => {
      if(on)store.setIncognito(true);
      catalogue.close();sessions.closeGuests();await sessions.clearPrivate();workspace.resetObservation();
      if(!on)store.setIncognito(false);
      const state=store.privacyState();emit('privacy.changed',state);emit('sources.changed',sessions.sourceList());return state;
    },
    'privacy.title': async ({mediaId,on}) => {
      if(on)store.setTitlePrivate(mediaId,true);
      catalogue.close();sessions.closeGuests();await sessions.clearPrivate();workspace.resetObservation();
      if(!on)store.setTitlePrivate(mediaId,false);
      const state=store.privacyState();emit('privacy.changed',state);emit('sources.changed',sessions.sourceList());return state;
    },
    'privacy.watchSources': ({mediaId}) => store.isIncognito()?{leaseId:null,sources:sessions.sourceList()}:store.isPrivate(mediaId)?sessions.privateLease():{leaseId:null,sources:registry.list()},
    'privacy.releaseSources': ({leaseId}) => sessions.releasePrivate(leaseId),
    'app.setUiRendering': ({ mode }) => uiRendering.set(mode),
    'app.restart': () => { app.relaunch(); app.quit(); },
    'app.openGraphicsSettings': async () => {
      if (process.platform === 'win32') await shell.openExternal('ms-settings:display-advancedgraphics');
    },
    'app.openExternal': async ({ url }) => {
      const source=registry.list().find(source=>{try{return new URL(source.url).origin===new URL(url).origin;}catch{return false;}});
      if(!security.decide({context:'external',url,source:source?.url}).allowed)throw new AppError('unauthorised','This external URL is blocked by source protection.');
      await shell.openExternal(url);
    },
    'app.cacheClear': async () => {
      catalogue.close();store.cachePurge(true);
      await session.defaultSession.clearCache();
    },

    'update.state': () => updates.snapshot(),
    'update.check': () => updates.check(),
    'update.download': () => updates.download(),
    'update.install': () => updates.install(),
  };

  registerRpc(handlers, (event: IpcMainInvokeEvent) => !!mainWindow && event.sender === mainWindow.webContents && event.senderFrame?.parent === null && isAppUrl(event.senderFrame.url));

  adblock.setEnabled(settings.get().privacy.adblock);
  void adblock.load();
  // Automatic sync: retry queued pushes every 5 minutes; in two-way mode also
  // bring in edits made on the services every 30 minutes.
  let ticks = 0;
  setInterval(() => {
    if (!settings.get().accounts.autoSync) return;
    if (settings.get().accounts.twoWay && ++ticks % 6 === 0) void sync.sync(null);
    else {
      void sync.flush('anilist');
      void sync.flush('mal');
    }
  }, 5 * 60 * 1000).unref();

  const onGuest = (guest: WebContents) => navigator.attach(guest);
  mainWindow = createWindow(paths.preload, sessions, onGuest,security,()=>seasonalVisuals(new Date(),settings.get().appearance.accent));
  mainWindow.once('closed',()=>catalogue.close());
  if (isDev && process.env.ANIVERSE_TEST_DRIVER) runTestDriver(process.env.ANIVERSE_TEST_DRIVER, mainWindow);
  updates.start();
  app.on('activate', () => {
    if (!mainWindow||mainWindow.isDestroyed()){mainWindow = createWindow(paths.preload, sessions, onGuest,security,()=>seasonalVisuals(new Date(),settings.get().appearance.accent));mainWindow.once('closed',()=>catalogue.close());}
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    captures.stopAll();
    void mirror?.stop();
    drive.cancel();
    config.stop();
    updates.stop();
    catalogue.close();void cast.stop(); chromeCast.close();void sessions.clearPrivate();
  });
  app.on('will-quit', () => {
    try {
      store.close();
    } catch {
      // already closed
    }
  });

  // Catch up after start: queued pushes from the last session, and (two-way) edits made elsewhere.
  setTimeout(() => {
    if (!settings.get().accounts.autoSync || TEST_RUN) return;
    if (settings.get().accounts.twoWay) void sync.sync(null);
    else {
      void sync.flush('anilist');
      void sync.flush('mal');
    }
  }, 8000);
}

function appUrl(): string {
  return isDev && process.env.ANIVERSE_DEV_URL ? process.env.ANIVERSE_DEV_URL : 'app://aniverse/index.html';
}

function isAppUrl(url: string): boolean {
  return trustedAppUrl(url,appUrl());
}

function hardenDefaultSession(canCapture: (wc: WebContents | null) => boolean = () => false) {
  const ses = session.defaultSession;
  // Display capture additionally requires a fresh owned-player grant. Device media stays denied.
  const allowed = new Set(['fullscreen', 'clipboard-sanitized-write', 'clipboard-read']);
  ses.setPermissionRequestHandler((wc, permission, callback, details) => callback(isAppUrl(wc.getURL()) && (allowed.has(permission) || (isPlayerCapturePermission(permission, details) && canCapture(wc)))));
  ses.setPermissionCheckHandler((wc, permission) => !!wc && isAppUrl(wc.getURL()) && (allowed.has(permission) || (permission === 'display-capture' && canCapture(wc))));
  ses.on('will-download', (event) => event.preventDefault());
}

/**
 * Development only: runs a test script (test/e2e/drivers/*.cjs) inside this process once the UI
 * has loaded, then quits. Site tests need this because remote debugging — how Playwright drives
 * Electron — sets `navigator.webdriver`, which trips sites' anti-bot guards and Cloudflare.
 */
function runTestDriver(file: string, win: BrowserWindow) {
  win.webContents.once('did-finish-load', () => {
    const driver = require(path.resolve(file)) as (ctx: { window: BrowserWindow; webContents: typeof webContents }) => Promise<unknown>;
    Promise.resolve()
      .then(() => driver({ window: win, webContents }))
      .catch((err: unknown) => {
        console.error('[test-driver]', err);
        process.exitCode = 1;
      })
      .finally(() => app.quit());
  });
}

function createWindow(preload: string, sessions: SessionManager, onGuest: (guest: WebContents) => void, security:RustPolicy, seasonal:()=>boolean): BrowserWindow {
  const standardIcon=path.join(__dirname,'..','..','build','icon.png');
  const festiveIcon=path.join(__dirname,'..','..','build','seasonal-icon.png');
  let festive=seasonal();
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    focusable: !HEADLESS,
    skipTaskbar: HEADLESS,
    backgroundColor: '#07080b',
    title: 'AniVerse',
    icon: festive?festiveIcon:standardIcon,
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? true : { color: '#00000000', symbolColor: '#e8e8ec', height: 44 },
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker:false,
      nodeIntegrationInSubFrames:false,
      webviewTag: true,
      spellcheck: false,
      webSecurity: true,
      backgroundThrottling: !HEADLESS,
    },
  });

  const brandingTimer=setInterval(()=>{const next=seasonal();if(!win.isDestroyed()&&next!==festive){festive=next;win.setIcon(next?festiveIcon:standardIcon);}},1000);brandingTimer.unref();
  win.once('closed',()=>clearInterval(brandingTimer));
  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (security.decide({context:'external',url}).allowed) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  wc.on('will-redirect',(event,url,_inPlace,isMainFrame)=>{if(isMainFrame&&!isAppUrl(url))event.preventDefault();});
  wc.on('will-attach-webview', (event, webPreferences, params) => {
    // Webviews may only host configured sources, in their own partition, with no Node or preload access.
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    // Keep video frames/timers running alongside audio when a guest is occluded.
    webPreferences.backgroundThrottling = false;
    if (!sessions.allowAttach(params.partition ?? '', params.src ?? '')) event.preventDefault();
  });
  wc.on('did-attach-webview', (_event, guest: WebContents) => {
    const source = sessions.sourceForSession(guest.session);
    if (source) {
      sessions.manageGuest(guest, source);
      onGuest(guest);
    } else guest.close();
  });

  win.once('ready-to-show', () => {
    if (!HEADLESS) return win.show();
    // Automated runs: render normally (so screenshots work) but stay invisible,
    // click-through and unfocused so tests never get in the user's way.
    win.setOpacity(0);
    win.setIgnoreMouseEvents(true);
    win.showInactive();
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  void win.loadURL(appUrl());
  if (isDev && process.env.ANIVERSE_DEVTOOLS === '1') wc.openDevTools({ mode: 'detach' });
  return win;
}
