// Create local HLS test media from the existing public fixture; no network traffic.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const assets=path.join(root,'test/cache/android-0.1.0/fixture-assets'),cache=path.join(root,'test/cache/android-0.4.6');
mkdirSync(assets,{recursive:true});mkdirSync(cache,{recursive:true});
const tool=process.argv.find(value=>value.startsWith('--ffmpeg='))?.slice(9)??path.join(root,'build/vendor/ffmpeg/ffmpeg.exe');
const clip=path.join(assets,'clip.mp4');assert.ok(existsSync(clip),'Prepare the existing clip.mp4 fixture first');assert.ok(existsSync(tool),'Pass the bundled verified FFmpeg executable with --ffmpeg=');
const key=path.join(assets,'hls-aes.key');writeFileSync(key,randomBytes(16));
const info=path.join(cache,'hls-fixture-key-info.txt');writeFileSync(info,'hls-aes.key\n'+key.replaceAll('\\','/')+'\n'+randomBytes(16).toString('hex')+'\n');
for(const kind of ['clear','aes']){
 const args=['-hide_banner','-loglevel','error','-y','-i',clip,'-t','12','-c','copy','-hls_time','3','-hls_playlist_type','vod'];
 if(kind==='aes')args.push('-hls_key_info_file',info);
 args.push('-hls_segment_filename',path.join(assets,'hls-'+kind+'-%03d.ts'),path.join(assets,'hls-'+kind+'.m3u8'));
 execFileSync(tool,args,{cwd:root,windowsHide:true,stdio:'pipe'});
}
writeFileSync(path.join(assets,'hls-master.m3u8'),'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nhls-aes.m3u8\n');
const names=readdirSync(assets).filter(name=>/^hls-(?:clear|aes)(?:-\d+\.ts|\.m3u8|\.key)$/.test(name)||name==='hls-master.m3u8').sort();
const manifest=Object.fromEntries(names.map(name=>[name,createHash('sha256').update(readFileSync(path.join(assets,name))).digest('hex')]));
writeFileSync(path.join(assets,'hls-fixtures.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({prepared:true,files:names.length,clearSegments:names.filter(n=>/^hls-clear-\d+/.test(n)).length,aesSegments:names.filter(n=>/^hls-aes-\d+/.test(n)).length,assets},null,2));
