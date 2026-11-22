import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RustPolicy } from '../../app/core/security/rustPolicy';
import { SourceMp4Download } from '../../electron/sourceMp4Download';

const mocks = vi.hoisted(() => ({ showSaveDialog: vi.fn(), fetch: vi.fn(), inspect: vi.fn(), spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => 'windows-downloads', getAppPath: () => '.' },
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showSaveDialog: mocks.showSaveDialog },
  session: { fromPartition: () => ({ fetch: mocks.fetch, protocol: { isProtocolHandled: async () => true } }) },
}));
vi.mock('../../electron/ownedPlayerFrame', () => ({ readOwnedPlayer: mocks.inspect }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
const policy = new RustPolicy(readFileSync('dist/electron/security.wasm'));
const mp4 = Buffer.from('000000146674797069736f6d000000006d703432', 'hex');
const url = 'https://media.test/clip.mp4';
let folder: string;
let output: string;
beforeEach(() => {
  vi.stubGlobal('__ANIVERSE_DOWNLOAD_SCRIPT__', 'owned readonly player inspection');
  folder = mkdtempSync(path.join('test/cache/', 'windows-mp4-'));
  output = path.join(folder, 'saved.mp4');
  mocks.showSaveDialog.mockReset().mockResolvedValue({ canceled: false, filePath: output });
  mocks.fetch.mockReset();
  mocks.inspect.mockReset();
  mocks.spawn.mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); rmSync(folder, { recursive: true, force: true }); });

function save(bytes: Buffer, length = bytes.length) {
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(bytes.subarray(0, 5)));
    controller.enqueue(new Uint8Array(bytes.subarray(5)));
    controller.close();
  } });
  mocks.fetch.mockResolvedValueOnce(new Response(body, { headers: { 'content-type': 'video/mp4', 'content-length': String(length) } }));
  const guest = Object.assign(new EventEmitter(), { hostWebContents: {} });
  return new SourceMp4Download(policy, () => folder).save(guest as never, url);
}
it('starts the save dialog in the configured folder and publishes the exact bytes', async () => {
  await expect(save(mp4)).resolves.toBe(true);
  expect(mocks.showSaveDialog).toHaveBeenCalledWith(expect.anything(),
    expect.objectContaining({ defaultPath: path.join(folder, 'AniVerse - clip.mp4') }));
  expect(readFileSync(output)).toEqual(mp4);
  expect(mocks.fetch).toHaveBeenCalledWith(url, expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
});
it('rejects mislabeled and truncated responses without leaving a final file', async () => {
  await expect(save(Buffer.from('<html>not an MP4</html>'))).rejects.toThrow('not an MP4');
  await expect(save(mp4, mp4.length + 100)).rejects.toThrow('ended the transfer early');
  expect(existsSync(output)).toBe(false);
});
it('preserves an existing destination even when the save dialog returns its name', async () => {
  writeFileSync(output, 'existing');
  await expect(save(mp4)).rejects.toThrow('already exists');
  expect(readFileSync(output, 'utf8')).toBe('existing');
});

type CandidateInspector = { inspect(guest: unknown): Promise<Record<string, unknown> | null> };
it('validates bounded HLS observations while preserving opaque queries and a selected public subtitle', async () => {
  const offered = { identity:'document-1:video-1', media: 'blob:https://player.test/playing', url: 'https://media.test/video.m3u8?opaque=1', expectedDuration: 120,
    playlists: ['https://media.test/video.m3u8?opaque=1'], observations: ['https://media.test/part.png?opaque=2'],
    subtitle: { url: 'https://captions.test/en.vtt?opaque=3', language: 'en', label: 'English' } };
  mocks.inspect.mockResolvedValue(offered);
  const inspector = new SourceMp4Download(policy, () => folder) as unknown as CandidateInspector;
  await expect(inspector.inspect({})).resolves.toEqual(offered);
  mocks.inspect.mockResolvedValue({ ...offered, media: offered.url });
  await expect(inspector.inspect({})).resolves.toEqual({ ...offered, media: offered.url });
  mocks.inspect.mockResolvedValue({ ...offered, observations: ['https://user:password@media.test/private.png'] });
  await expect(inspector.inspect({})).resolves.toBeNull();
  mocks.inspect.mockResolvedValue({ ...offered, observations: Array(33).fill(offered.observations[0]) });
  await expect(inspector.inspect({})).resolves.toBeNull();
  mocks.inspect.mockResolvedValue({ ...offered, media: 'https://media.test/different.m3u8' });
  await expect(inspector.inspect({})).resolves.toBeNull();
});
it('cancels its owned worker when the playing episode scope changes during a transfer', async () => {
  vi.useFakeTimers();
  const stdout = new PassThrough(), stdin = new PassThrough();
  const worker = Object.assign(new EventEmitter(), { stdout, stdin });
  mocks.spawn.mockReturnValue(worker);
  stdin.once('finish', () => { stdout.end(); worker.emit('close', 1); });
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  let current = true;
  const service = new SourceMp4Download(policy, () => folder) as unknown as {
    transfer(owner: unknown, request: unknown, current: () => boolean): Promise<boolean>;
  };
  const result = service.transfer(owner, { media: url, url, destination: output }, () => current);
  expect(JSON.parse(String(stdin.read())).media).toBe(url);
  current = false;
  await vi.advanceTimersByTimeAsync(251);
  await expect(result).resolves.toBe(false);
  expect(stdin.writableEnded).toBe(true);
});

it('keeps generic public URL actions queryless while the owned player uses scoped references', () => {
  const service = new SourceMp4Download(policy, () => folder);
  expect(() => service.saveDirect({} as never, url + '?opaque=not-an-owned-selection')).toThrow('supported public HTTPS video');
});

it('keeps a same-video download valid while Save As is open and observations advance', async () => {
  const selected = {identity:'document-1:video-1',media:'blob:https://player.test/playing',url:'https://media.test/video.m3u8',expectedDuration:120,playlists:['https://media.test/video.m3u8','https://media.test/master.m3u8'],observations:['https://media.test/video-1.png']};
  let submit!: (result:{canceled:boolean;filePath:string}) => void;
  mocks.showSaveDialog.mockImplementation(() => new Promise(resolve => {submit=resolve;}));
  mocks.inspect.mockResolvedValueOnce(selected).mockResolvedValueOnce({...selected,url:'https://media.test/audio.m3u8',playlists:['https://media.test/audio.m3u8',...selected.playlists],observations:['https://media.test/audio-2.webp','https://media.test/video-2.png'],expectedDuration:120.02,subtitle:{language:'en',label:'English CC'}});
  const guest=Object.assign(new EventEmitter(),{hostWebContents:{},isDestroyed:()=>false});
  const service=new SourceMp4Download(policy,()=>folder);
  const transfer=vi.spyOn(service as unknown as { transfer: (...args: unknown[]) => Promise<boolean> }, 'transfer').mockResolvedValue(true);
  const result=service.saveActive(guest as never,()=>true,{title:'Synthetic Series 世界',season:2,episode:7});
  await vi.waitFor(()=>expect(mocks.showSaveDialog).toHaveBeenCalled());
  expect(mocks.showSaveDialog).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({defaultPath:path.join(folder,'Synthetic Series 世界 - S02E07.mp4')}));
  submit({canceled:false,filePath:output});
  await expect(result).resolves.toBe(true);
  expect(transfer).toHaveBeenCalledWith(guest,expect.objectContaining({url:selected.url,observations:selected.observations}),expect.any(Function));
});

it.each(['identity','media','duration','lease'])('rejects a real %s change while Save As is open before starting the worker', async kind => {
  const selected={identity:'document-1:video-1',media:'blob:https://player.test/playing',url:'https://media.test/video.m3u8',expectedDuration:120,playlists:['https://media.test/video.m3u8'],observations:['https://media.test/video-1.png']};
  let submit!: (result:{canceled:boolean;filePath:string})=>void;
  let current=true;
  mocks.showSaveDialog.mockImplementation(()=>new Promise(resolve=>{submit=resolve;}));
  mocks.inspect.mockResolvedValueOnce(selected).mockResolvedValueOnce({...selected,...(kind==='identity'?{identity:'document-2:video-1'}:kind==='media'?{media:'blob:https://player.test/another'}:kind==='duration'?{expectedDuration:240}:{})});
  const guest=Object.assign(new EventEmitter(),{hostWebContents:{},isDestroyed:()=>false});
  const service=new SourceMp4Download(policy,()=>folder);
  const transfer=vi.spyOn(service as unknown as { transfer: (...args: unknown[]) => Promise<boolean> }, 'transfer').mockResolvedValue(true);
  const result=service.saveActive(guest as never,()=>current);
  await vi.waitFor(()=>expect(mocks.showSaveDialog).toHaveBeenCalled());
  if(kind==='lease')current=false;
  submit({canceled:false,filePath:output});
  await expect(result).rejects.toThrow('active video changed');
  expect(transfer).not.toHaveBeenCalled();
});
it('canceling Save As performs no worker transfer or stale revalidation', async()=>{
  mocks.inspect.mockResolvedValue({identity:'document-1:video-1',media:url,url});
  mocks.showSaveDialog.mockResolvedValue({canceled:true});
  const guest=Object.assign(new EventEmitter(),{hostWebContents:{},isDestroyed:()=>false});
  const service=new SourceMp4Download(policy,()=>folder);
  const transfer=vi.spyOn(service as unknown as { transfer: (...args: unknown[]) => Promise<boolean> }, 'transfer').mockResolvedValue(true);
  await expect(service.saveActive(guest as never,()=>true)).resolves.toBe(false);
  expect(transfer).not.toHaveBeenCalled();
});
