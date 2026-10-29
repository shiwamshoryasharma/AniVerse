// Real embedded FFmpeg/Anime4K encode verification; no physical TV is controlled.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cache = path.join(root, 'test/cache/cast-4k');
mkdirSync(cache, { recursive: true });
const run = mkdtempSync(path.join(cache, 'run-'));
await build({ entryPoints: [path.join(root, 'electron/cast/sender4k.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(run, 'sender.cjs'), logLevel: 'warning' });
const { Sender4K } = createRequire(import.meta.url)(path.join(run, 'sender.cjs'));
const tools = process.env.E2E_MEDIA_RESOURCES ? path.join(process.env.E2E_MEDIA_RESOURCES, 'ffmpeg') : path.join(root, 'build/vendor/ffmpeg');
const shaders = process.env.E2E_MEDIA_RESOURCES ? path.join(process.env.E2E_MEDIA_RESOURCES, 'anime4k') : path.join(root, 'assets/anime4k');
const errors = [], report = { passed: false, physicalTVTested: false, errors };
const sender = new Sender4K(tools, shaders, run, (error) => errors.push(error));
const started = Date.now();
try {
  const session = await sender.start(path.join(root, 'test/cache/release-1.5.2-ui/sintel-trailer.mp4'), 3, { enabled: true, mode: 'A', darken: false, thin: false });
  const files = await readdir(session.folder), segment = files.filter((f) => /segment-\d+\.m4s$/.test(f)).sort()[0];
  assert.ok(segment, 'Encoded media segment exists');
  const sample = path.join(run, 'encoded-sample.mp4');
  writeFileSync(sample, Buffer.concat([readFileSync(path.join(session.folder, 'init.mp4')), readFileSync(path.join(session.folder, segment))]));
  const { stdout } = await promisify(execFile)(path.join(tools, 'ffprobe.exe'), ['-v','error','-show_streams','-of','json',sample], { windowsHide: true, timeout: 15000 });
  const info = JSON.parse(stdout), video = info.streams.find((s) => s.codec_type === 'video'), audio = info.streams.find((s) => s.codec_type === 'audio');
  assert.equal(video.codec_name, 'hevc'); assert.equal(video.width, 3840); assert.equal(video.height, 2160);
  assert.equal(audio.codec_name, 'aac');
  assert.deepEqual(errors, []);
  Object.assign(report, { passed: true, ffmpegVersion: sender.capabilities().version, encoder: session.encoder, width: video.width, height: video.height, videoCodec: video.codec_name, audioCodec: audio.codec_name, seconds: (Date.now() - started) / 1000 });
  await build({ entryPoints: [path.join(root, 'electron/cast/castService.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(run, 'cast.cjs'), logLevel: 'warning' });
  const { CastService } = createRequire(import.meta.url)(path.join(run, 'cast.cjs'));
  let loaded;
  class ReceiverFixture extends EventEmitter {
    async connect() {} async launch() {} async stopApp() {} close() {} async media() {} async volume() {}
    async load(media) { loaded = media; this.emit('media', { playerState: 'PLAYING', currentTime: 0, mediaSessionId: 1 }); }
  }
  const token = 'media://local/' + 'a'.repeat(32) + '.mp4';
  const cast = new CastService(() => undefined, (url) => url === token ? path.join(root, 'test/cache/release-1.5.2-ui/sintel-trailer.mp4') : null, sender, () => new ReceiverFixture());
  cast.devices.set('fixture', { id: 'fixture', name: 'Receiver fixture', model: '4K receiver fixture', host: '127.0.0.1', port: 8009 });
  try {
    await cast.start('fixture', { url: token, kind: 'mp4', title: 'Fixture', startAt: 3, upscale4k: true }, { enabled: true, mode: 'A', darken: false, thin: false });
    assert.equal(cast.snapshot().processing.width, 3840);
    const playlist = await fetch(loaded.contentId), text = await playlist.text();
    assert.ok(playlist.ok); assert.match(text, /#EXTM3U/);
    const chunk = text.match(/segment-\d{6}\.m4s/)[0];
    const partial = await fetch(new URL(chunk, loaded.contentId), { headers: { Range: 'bytes=0-31' } });
    assert.equal(partial.status, 206); assert.equal((await partial.arrayBuffer()).byteLength, 32);
    const invalid = new URL(loaded.contentId); invalid.pathname = invalid.pathname.replace(/\/processed\/[^/]+\//, '/processed/' + '0'.repeat(48) + '/');
    assert.equal((await fetch(invalid)).status, 404);
    Object.assign(report, { hlsServing: true, tokenGuard: true, rangeServing: true, receiverTransport: 'Fixture; no physical TV controlled' });
  } finally { await cast.stop(); }
  console.log(JSON.stringify(report, null, 2));
} catch (error) { errors.push(String(error)); throw error; }
finally {
  await sender.stop();
  writeFileSync(path.join(root, 'test/artifacts/release-' + JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version + '-cast-4k.json'), JSON.stringify(report, null, 2) + '\n');
}
