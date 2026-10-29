import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { upscaleSize, type UpscaleSettings } from '../../app/shared/upscale';
const execute = promisify(execFile);
export type Encoder = 'hevc_nvenc' | 'hevc_qsv' | 'hevc_amf' | 'libx265' | 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264';
export interface SenderSession { folder: string; width: number; height: number; duration: number; startAt: number; encoder: Encoder }
export function shaderFiles(options: UpscaleSettings): string[] {
  const files = ['Anime4K_Clamp_Highlights.glsl'];
  if (options.mode[0] !== 'C') files.push(options.mode[0] === 'B' ? 'Anime4K_Restore_CNN_Soft_M.glsl' : 'Anime4K_Restore_CNN_M.glsl');
  files.push(options.mode[0] === 'C' ? 'Anime4K_Upscale_Denoise_CNN_x2_M.glsl' : 'Anime4K_Upscale_CNN_x2_M.glsl');
  if (options.mode.includes('+')) files.push(options.mode === 'B+B' ? 'Anime4K_Restore_CNN_Soft_M.glsl' : 'Anime4K_Restore_CNN_M.glsl');
  if (options.darken) files.push('Anime4K_Darken_Fast.glsl');
  if (options.thin) files.push('Anime4K_Thin_Fast.glsl');
  return files;
}
export function transcodeArgs(file: string, startAt: number, encoder: Encoder, size: { width: number; height: number }): string[] {
  return ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y', '-init_hw_device', 'vulkan=vk:0', '-filter_hw_device', 'vk',
    '-protocol_whitelist', 'file,pipe', '-readrate', '1', '-readrate_initial_burst', '6', '-ss', String(startAt), '-i', file,
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
    '-vf', 'format=yuv420p,hwupload,libplacebo=w=' + size.width + ':h=' + size.height + ':custom_shader_path=shader.glsl,hwdownload,format=yuv420p,pad=3840:2160:(ow-iw)/2:(oh-ih)/2',
    '-c:v', encoder, ...(encoder === 'hevc_nvenc' ? ['-preset', 'p4', '-tune', 'll'] : encoder === 'libx265' ? ['-preset', 'ultrafast', '-x265-params', 'log-level=error:pools=4'] : []),
    '-tag:v', 'hvc1', '-b:v', '18M', '-maxrate', '28M', '-bufsize', '40M', '-g', '48',
    '-force_key_frames', 'expr:gte(t,n_forced*2)', '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '12', '-hls_delete_threshold', '4', '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', 'segment-%06d.m4s',
    '-hls_flags', 'delete_segments+independent_segments+temp_file', 'index.m3u8'];
}

export function mirrorTranscodeArgs(upscale: boolean, encoder: Encoder): string[] {
  const fit = 'scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1920:1080:(ow-iw)/2:(oh-ih)/2';
  return ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y',
    ...(upscale ? ['-init_hw_device', 'vulkan=vk:0', '-filter_hw_device', 'vk'] : []),
    '-protocol_whitelist', 'file,pipe', '-probesize', '1000000', '-analyzeduration', '1000000', '-fflags', '+genpts', '-f', 'webm', '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-vf',
    fit + (upscale ? ',format=yuv420p,hwupload,libplacebo=w=3840:h=2160:custom_shader_path=shader.glsl,hwdownload,format=yuv420p' : ',format=yuv420p'),
    '-c:v', encoder, ...(encoder.endsWith('_nvenc') ? ['-preset', 'p4', '-tune', 'll'] : encoder === 'libx264' ? ['-preset', 'ultrafast', '-tune', 'zerolatency', '-threads', '4'] : encoder === 'libx265' ? ['-preset', 'ultrafast', '-x265-params', 'log-level=error:pools=4'] : []),
    ...(upscale ? ['-tag:v', 'hvc1'] : []), '-b:v', upscale ? '18M' : '7M', '-maxrate', upscale ? '28M' : '10M', '-bufsize', upscale ? '40M' : '14M',
    '-g', '48', '-force_key_frames', 'expr:gte(t,n_forced*2)', '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '12', '-hls_delete_threshold', '4', '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', 'segment-%06d.m4s', '-hls_flags', 'delete_segments+independent_segments+temp_file', 'index.m3u8'];
}

export class Sender4K {
  private child: ChildProcess | null = null;
  private folder: string | null = null;
  private active: SenderSession | null = null;
  private encoder: Encoder | null = null;
  private generation = 0;
  constructor(private tools: string, private shaders: string, private cache: string, private error: (message: string) => void) {}
  capabilities() {
    const installed = existsSync(path.join(this.tools, 'ffmpeg.exe')) && existsSync(path.join(this.tools, 'ffprobe.exe'));
    let version: string | null = null;
    try { version = JSON.parse(requireManifest(this.tools)).version; } catch { /* missing preparation */ }
    return { available: installed, version, message: installed ? 'Embedded Anime4K → HEVC 4K · processing on this device' : 'Embedded media tools are missing. Reinstall AniVerse.' };
  }
  private async chooseEncoder(): Promise<Encoder> {
    if (this.encoder) return this.encoder;
    for (const candidate of ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'libx265'] as const) {
      try {
        await execute(path.join(this.tools, 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=3840x2160:r=1',
          '-frames:v', '1', '-c:v', candidate, ...(candidate === 'libx265' ? ['-preset', 'ultrafast', '-x265-params', 'log-level=error:pools=4'] : []), '-f', 'null', '-'],
          { windowsHide: true, timeout: 20000, maxBuffer: 128000 });
        return this.encoder = candidate;
      } catch { /* Listed encoders may not have a compatible installed GPU. */ }
    }
    throw new Error('No working 4K HEVC encoder was found on this device.');
  }
  async start(file: string, startAt: number, options: UpscaleSettings): Promise<SenderSession> {
    await this.stop();
    const generation = ++this.generation;
    if (!this.capabilities().available) throw new Error('Embedded media tools are missing.');
    if (!/\.(mp4|m4v|mkv|webm|mov)$/i.test(file)) throw new Error('Sender-side 4K casting requires an opened local video file.');
    const probe = await execute(path.join(this.tools, 'ffprobe.exe'), ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', file],
      { windowsHide: true, timeout: 15000, maxBuffer: 2000000 });
    const info = z.object({ streams: z.array(z.object({ codec_type: z.string(), width: z.number().optional(), height: z.number().optional() })), format: z.object({ duration: z.coerce.number().positive() }) }).parse(JSON.parse(probe.stdout));
    const video = info.streams.find((s) => s.codec_type === 'video');
    const size = video && upscaleSize(video.width ?? 0, video.height ?? 0, 8192);
    if (!size) throw new Error('The selected video has no supported picture stream.');
    size.width -= size.width % 2; size.height -= size.height % 2;
    const encoder = await this.chooseEncoder();
    await mkdir(this.cache, { recursive: true });
    const folder = await mkdtemp(path.join(this.cache, 'session-'));
    if (generation !== this.generation) { await rm(folder, { recursive: true, force: true }); throw new Error('Casting was cancelled.'); }
    this.folder = folder;
    const shaders = await Promise.all(shaderFiles(options).map((name) => readFile(path.join(this.shaders, name), 'utf8')));
    await writeFile(path.join(folder, 'shader.glsl'), shaders.join('\n\n'));
    const offset = Math.max(0, Math.min(info.format.duration - 1, startAt));
    let stderr = '', exited = false;
    const child = spawn(path.join(this.tools, 'ffmpeg.exe'), transcodeArgs(file, offset, encoder, size),
      { cwd: folder, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16000); });
    child.once('error', () => { exited = true; if (this.active) this.error('The embedded 4K encoder could not start.'); });
    child.once('exit', (code) => {
      exited = true;
      if (generation === this.generation && this.active && code !== 0) this.error('Sender-side 4K encoding stopped. Check GPU/Vulkan support and retry.');
    });
    try {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        if (generation !== this.generation) throw new Error('4K casting was cancelled.');
        if (exited) throw new Error('Embedded Anime4K encoding failed. GPU/Vulkan or HEVC encoding is unavailable. ' + stderr.split('\n').filter((line) => /Error|failed|not support/i.test(line)).slice(-2).map((line) => line.replaceAll(file, '[video]').replaceAll(folder, '[session]')).join(' ').slice(0, 300));
        const playlist = await readFile(path.join(folder, 'index.m3u8'), 'utf8').catch(() => '');
        const segments = playlist.match(/segment-\d+\.m4s/g) ?? [];
        if (segments.length >= 2 && (await stat(path.join(folder, segments[0]!)).catch(() => null))?.size) {
          this.active = { folder, width: 3840, height: 2160, duration: info.format.duration, startAt: offset, encoder };
          return this.active;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error('4K encoder could not prepare the stream in time. This device may be too slow for real-time 4K.');
    } catch (error) { await this.stop(); throw error; }
  }

  async beginMirror(upscale: boolean, options: UpscaleSettings): Promise<{ ready: Promise<SenderSession>; write: (bytes: Uint8Array) => Promise<void> }> {
    await this.stop();
    const generation = ++this.generation;
    if (!this.capabilities().available) throw new Error('Embedded media tools are missing.');
    const selected = await this.chooseEncoder();
    if (generation !== this.generation) throw new Error('Website casting was cancelled.');
    const encoder: Encoder = upscale ? selected : selected === 'libx265' ? 'libx264' : selected.replace('hevc_', 'h264_') as Encoder;
    await mkdir(this.cache, { recursive: true });
    const folder = await mkdtemp(path.join(this.cache, 'session-'));
    if (generation !== this.generation) { await rm(folder, { recursive: true, force: true }); throw new Error('Casting was cancelled.'); }
    this.folder = folder;
    if (upscale) {
      const shaders = await Promise.all(shaderFiles(options).map((name) => readFile(path.join(this.shaders, name), 'utf8')));
      await writeFile(path.join(folder, 'shader.glsl'), shaders.join('\n\n'));
    }
    if (generation !== this.generation) throw new Error('Website casting was cancelled.');
    const child = spawn(path.join(this.tools, 'ffmpeg.exe'), mirrorTranscodeArgs(upscale, encoder), { cwd: folder, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    this.child = child;
    let failed = false;
    child.stdin?.on('error', () => { failed = true; });
    child.once('error', () => { failed = true; });
    child.stderr?.on('data', () => undefined);
    child.once('exit', (code) => { if (generation === this.generation && this.active && code !== 0) this.error('Website capture encoding stopped. Stop casting and retry.'); });
    const ready = (async () => {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        if (generation !== this.generation) throw new Error('Website casting was cancelled.');
        if (failed || child.exitCode !== null) throw new Error('The captured player could not be encoded. Original playback is unchanged.');
        const playlist = await readFile(path.join(folder, 'index.m3u8'), 'utf8').catch(() => '');
        if ((playlist.match(/segment-\d+\.m4s/g) ?? []).length >= 2) {
          this.active = { folder, width: upscale ? 3840 : 1920, height: upscale ? 2160 : 1080, duration: 0, startAt: 0, encoder };
          return this.active;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error('Website mirroring timed out. Check that the episode is playing and try again.');
    })().catch(async (error) => { if (generation === this.generation) await this.stop(); throw error; });
    void ready.catch(() => undefined);
    return { ready, write: (bytes) => new Promise<void>((resolve, reject) => {
      if (generation !== this.generation || !child.stdin?.writable) { reject(new Error('Capture encoder is closed.')); return; }
      child.stdin.write(Buffer.from(bytes), (error) => error ? reject(new Error('The capture encoder stopped accepting frames.')) : resolve());
    }) };
  }

  async stop() {
    this.generation++; this.active = null;
    const child = this.child; this.child = null;
    const folder = this.folder; this.folder = null;
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 2500); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill(); });
    }
    if (folder) {
      const relative = path.relative(path.resolve(this.cache), path.resolve(folder));
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) await rm(folder, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    }
  }
}
import { readFileSync } from 'node:fs';
function requireManifest(tools: string): string { return readFileSync(path.join(tools, 'manifest.json'), 'utf8'); }
