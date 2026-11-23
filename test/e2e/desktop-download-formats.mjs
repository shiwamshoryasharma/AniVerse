import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

const helper = path.resolve(process.argv[2]);
const cache = path.resolve('test/cache/media-transfer');
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, 'formats-'));
const tools = path.resolve('build/vendor/ffmpeg');
const mediaTool = (name, args) => execFileSync(path.join(tools, name + '.exe'), args, {
  cwd: fixture, windowsHide: true, timeout: 45_000, encoding: 'utf8',
});

mediaTool('ffmpeg', [
  '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=12',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-filter_complex', '[0:v]split=2[main][low];[low]scale=320:180[small]',
  '-map', '[main]', '-map', '[small]', '-map', '1:a', '-t', '3',
  '-c:v', 'libx264', '-threads', '2', '-bf', '0', '-g', '12', '-keyint_min', '12', '-sc_threshold', '0',
  '-b:v:0', '320k', '-b:v:1', '160k', '-c:a', 'aac', '-f', 'dash',
  '-seg_duration', '1', '-use_template', '1', '-use_timeline', '1',
  '-adaptation_sets', 'id=0,streams=v id=1,streams=a', 'fixture.mpd',
]);

mediaTool('ffmpeg', [
  '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12',
  '-t', '3', '-c:v', 'libvpx-vp9', '-threads', '2', 'direct.webm',
]);

const manifest = (await readFile(path.join(fixture, 'fixture.mpd'), 'utf8'))
  .replaceAll('.m4s', '')
  .replace('</Period>', '<AdaptationSet mimeType="text/vtt" lang="en"><Representation id="captions"><BaseURL>caption</BaseURL></Representation></AdaptationSet></Period>');
const mediaParts = new Map();
for (const part of (await readdir(fixture)).filter(file => file.endsWith('.m4s'))) {
  mediaParts.set('/media/' + part.slice(0, -4), await readFile(path.join(fixture, part)));
}
mediaParts.set('/media/caption', Buffer.from('WEBVTT\n\n00:00:00.250 --> 00:00:01.750\nSynthetic DASH subtitle\n\n'));
const webm = await readFile(path.join(fixture, 'direct.webm'));
const mpd = '/media/manifest?ticket=two%2Bdigits';
const protectedMpd = '/media/protected?ticket=fixture';
const direct = '/media/resource?ticket=fixture';
const requests = [];
const server = createServer((request, response) => {
  requests.push({ url: request.url, authorization: request.headers.authorization, cookie: request.headers.cookie });
  const send = (mime, bytes) => response.writeHead(200, {
    'Content-Type': mime, 'Content-Length': Buffer.byteLength(bytes), 'Cache-Control': 'no-store',
  }).end(bytes);
  if (request.url === mpd || request.url === protectedMpd || request.url === direct) {
    if (request.headers.authorization !== 'Bearer offline-fixture') {
      response.writeHead(403).end();
      return;
    }
    if (request.url === direct) {
      send('application/octet-stream', webm);
    } else {
      const text = request.url === protectedMpd
        ? manifest.replace(/(<Period\b[^>]*>)/, '$1<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"/>')
        : manifest;
      send('application/dash+xml', text);
    }
    return;
  }
  const part = mediaParts.get(request.url);
  if (!part) {
    response.writeHead(404).end();
    return;
  }
  send(request.url.endsWith('/caption') ? 'text/vtt' : 'application/octet-stream', part);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;

async function download(route, name, details) {
  const url = origin + route;
  const destination = path.join(fixture, name);
  const child = spawn(helper, [], {
    env: { ...process.env, ANIVERSE_TEST_MEDIA_ORIGIN: origin, TEMP: fixture, TMP: fixture },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const events = [];
  const lines = createInterface({ input: child.stdout });
  child.stdin.on('error', () => {});
  lines.on('line', line => events.push(JSON.parse(line)));
  child.stderr.resume();
  const timer = setTimeout(() => child.kill(), 45_000);
  child.stdin.write(JSON.stringify({ url, destination, ...details(url) }) + '\n');
  try {
    const [code] = await once(child, 'close');
    return { code, events, destination };
  } finally {
    clearTimeout(timer);
    lines.close();
  }
}

const auth = url => [{ url, headers: { authorization: 'Bearer offline-fixture' } }];
const selectedSegment = [...mediaParts.keys()].find(route => route.startsWith('/media/chunk-stream0'));
assert.ok(selectedSegment, 'The DASH generator did not create the observed video fragment.');
const selection = (url, headersByUrl = auth(url)) => ({
  media: 'blob:fixture', kind: 'dash', owned: true, playlists: [url],
  observations: [origin + selectedSegment], expectedDuration: 3, maxHeight: 180, headersByUrl,
});
const probe = file => JSON.parse(mediaTool('ffprobe', [
  '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,height', '-of', 'json', file,
]));

try {
  const dash = await download(mpd, 'split-dash.mp4', selection);
  assert.equal(dash.code, 0, JSON.stringify(dash.events.at(-1)));
  const { streams } = probe(dash.destination);
  assert.ok(streams.some(stream => stream.codec_type === 'video' && stream.height === 180));
  assert.ok(streams.some(stream => stream.codec_name === 'aac'));
  assert.ok(streams.some(stream => stream.codec_name === 'mov_text'));
  const titles = mediaTool('ffmpeg', ['-nostdin', '-v', 'error', '-i', dash.destination, '-map', '0:s:0', '-f', 'srt', '-']);
  assert.match(titles, /Synthetic DASH subtitle/);
  assert.equal(requests.filter(request => request.url === mpd && request.authorization === 'Bearer offline-fixture').length, 1);
  assert.ok(requests.every(request => request.url === mpd || !request.authorization));
  assert.ok(requests.every(request => !request.cookie));

  const prior = requests.length;
  const blocked = await download(protectedMpd, 'must-not-exist.mp4', selection);
  assert.notEqual(blocked.code, 0);
  assert.match(JSON.stringify(blocked.events.at(-1)), /protected/i);
  assert.deepEqual(requests.slice(prior).map(request => request.url), [protectedMpd]);
  await assert.rejects(stat(blocked.destination), { code: 'ENOENT' });

  const clear = await download(direct, 'extensionless.mp4', url => ({
    media: url, owned: true, headersByUrl: auth(url),
  }));
  assert.equal(clear.code, 0, JSON.stringify(clear.events.at(-1)));
  assert.ok(probe(clear.destination).streams.some(stream => stream.codec_type === 'video' && stream.height === 180));
  assert.equal((await readFile(clear.destination)).subarray(4, 8).toString('ascii'), 'ftyp');

  const unauthorized = await download(direct, 'expired.mp4', url => ({ media: url, owned: true }));
  assert.notEqual(unauthorized.code, 0);
  assert.match(JSON.stringify(unauthorized.events.at(-1)), /expired|sign in|denied|authoriz/i);
  await assert.rejects(stat(unauthorized.destination), { code: 'ENOENT' });
  console.log('Passed: signed extensionless DASH, requested quality, audio, timed subtitles, exact-URL auth, protected DASH rejection, and direct WebM byte validation.');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
