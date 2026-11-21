import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

const helper = path.resolve(process.argv[2]);
const ffmpeg = path.join(path.dirname(helper), 'ffmpeg.exe');
const ffprobe = path.resolve('build/vendor/ffmpeg/ffprobe.exe');
const cache = path.resolve('test/cache/media-transfer');
await mkdir(cache, { recursive: true });
const scratch = await mkdtemp(path.join(cache, 'cli-fixture-'));
const files = new Map();
for (const [kind, options, extension] of [
  ['ts', [], 'ts'], ['fragmented', ['-hls_segment_type', 'fmp4'], 'm4s'],
]) {
  const folder = path.join(scratch, kind);
  await mkdir(folder);
  execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x54:rate=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3',
    '-c:v', 'libx264', '-g', '12', '-c:a', 'aac', '-f', 'hls', '-hls_time', '1',
    '-hls_list_size', '0', ...options, '-hls_segment_filename', 'part-%d.' + extension, 'episode.m3u8'],
  { cwd: folder, windowsHide: true });
  for (const name of await readdir(folder)) files.set('/' + kind + '/' + name, await readFile(path.join(folder, name)));
}

const webm = path.join(scratch, 'source.webm');
execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x54:rate=12',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3',
  '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '6', '-c:a', 'libopus', webm],
{ windowsHide: true });
files.set('/source.webm', await readFile(webm));
files.set('/source.ts', files.get('/ts/part-0.ts'));
files.set('/fake.webm', Buffer.from('#EXTM3U\nhttps://example.test/never.ts\n'));

const requests = [];
let stalled;
const server = createServer((request, response) => {
  const url = request.url;
  requests.push(url);
  assert.equal(request.headers.cookie, undefined);
  assert.equal(request.headers.authorization, undefined);
  if (url === '/protected.m3u8') {
    response.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="never.key"\n#EXTINF:1,\nnever.ts\n#EXT-X-ENDLIST\n');
  } else if (url === '/slow.m3u8') {
    response.end('#EXTM3U\n#EXTINF:1,\nslow.ts\n#EXT-X-ENDLIST\n');
  } else if (url === '/slow.ts') {
    stalled?.();
  } else if (files.has(url)) {
    response.setHeader('content-type', url.endsWith('.mp4') && url === '/direct.mp4' ? 'video/mp4' : 'application/octet-stream');
    response.end(files.get(url));
  } else {
    response.writeHead(404).end();
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
const children = new Set();

function start(url, destination, observed) {
  const child = spawn(helper, [], {
    env: { ...process.env, ANIVERSE_TEST_MEDIA_ORIGIN: origin },
    windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'],
  });
  children.add(child);
  child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify({ url: origin + url, destination, observed: observed && origin + observed }) + '\n');
  const events = [];
  const reader = createInterface({ input: child.stdout });
  reader.on('line', line => events.push(JSON.parse(line)));
  const done = once(child, 'close').then(([code]) => {
    children.delete(child);
    reader.close();
    return { events, code };
  });
  return { child, done };
}

try {
  for (const [kind, ext] of [['ts', 'ts'], ['fragmented', 'm4s']]) {
    const destination = path.join(scratch, kind + '.mp4');
    const { code, events } = await start('/' + kind + '/episode.m3u8', destination, '/' + kind + '/part-0.' + ext).done;
    assert.equal(code, 0, JSON.stringify(events));
    assert.equal(events.at(-1).done, true);
    assert.ok(events.some(event => event.total > 1 && event.received === event.total));
    const { streams } = JSON.parse(execFileSync(ffprobe, [
      '-v', 'error', '-show_entries', 'stream=codec_name,start_time,duration', '-of', 'json', destination,
    ], { windowsHide: true, encoding: 'utf8' }));
    assert.deepEqual(streams.map(stream => stream.codec_name), ['h264', 'aac']);
    assert.ok(Math.abs(streams[0].start_time - streams[1].start_time) < 0.15);
    assert.ok(streams.every(stream => Math.abs(stream.duration - 3) < 0.15));
  }

  for (const extension of ['ts', 'webm']) {
    const output = path.join(scratch, 'converted-' + extension + '.mp4');
    const result = await start('/source.' + extension, output).done;
    assert.equal(result.code, 0, JSON.stringify(result.events));
    const { streams } = JSON.parse(execFileSync(ffprobe, [
      '-v', 'error', '-show_entries', 'stream=codec_name,start_time', '-of', 'json', output,
    ], { windowsHide: true, encoding: 'utf8' }));
    assert.deepEqual(streams.map(stream => stream.codec_name), ['h264', 'aac']);
    assert.ok(Math.abs(streams[0].start_time - streams[1].start_time) < 0.15);
  }

  const wrongContainer = path.join(scratch, 'wrong-container.mp4');
  assert.notEqual((await start('/fake.webm', wrongContainer).done).code, 0);
  await assert.rejects(stat(wrongContainer), { code: 'ENOENT' });

  const reference = await readFile(path.join(scratch, 'ts.mp4'));
  files.set('/direct.mp4', reference);
  const destination = path.join(scratch, 'direct.mp4');
  assert.equal((await start('/direct.mp4', destination).done).code, 0);
  assert.deepEqual(await readFile(destination), reference);
  assert.equal((await start('/direct.mp4', destination).done).code, 1);
  assert.deepEqual(await readFile(destination), reference);

  for (const [manifest, observed, wording] of [
    ['/protected.m3u8', undefined, /protected/],
    ['/ts/episode.m3u8', '/fragmented/part-0.m4s', /does not match/],
  ]) {
    const index = requests.length;
    const missing = path.join(scratch, 'refused.mp4');
    const { code, events } = await start(manifest, missing, observed).done;
    assert.equal(code, 1);
    assert.match(events.at(-1).error, wording);
    assert.deepEqual(requests.slice(index), [manifest]);
    await assert.rejects(stat(missing), { code: 'ENOENT' });
  }

  const waiting = new Promise(resolve => { stalled = resolve; });
  const cancelled = path.join(scratch, 'cancelled.mp4');
  const slow = start('/slow.m3u8', cancelled);
  await waiting;
  slow.child.stdin.end();
  const result = await slow.done;
  assert.equal(result.code, 1);
  assert.match(result.events.at(-1).error, /interrupted/);
  await assert.rejects(stat(cancelled), { code: 'ENOENT' });
  assert.ok(!(await readdir(scratch)).some(name => name.startsWith('.aniverse-')));

  console.log(JSON.stringify({ passed: true, transportStream: true, fragmented: true,
    audioVideoSync: true, directTs: true, webmToMp4: true, disguisedPlaylistRejected: true, directExactBytes: true, existingFilePreserved: true,
    changedPlaylistRejected: true, encryptedRejected: true, cooperativeCancellation: true }, null, 2));
} finally {
  for (const child of children) child.stdin.end();
  server.closeAllConnections();
  server.close();
}
