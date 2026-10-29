import { session, type WebContents, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { MirrorIngress } from '../../app/core/mirrorIngress';
import type { UpscaleSettings } from '../../app/shared/upscale';
import type { CastState } from '../../app/shared/types';
import type { CastService } from './castService';
import type { Sender4K } from './sender4k';

interface Capture {
  id: string; guest: WebContents; expires: number; consumed: boolean; ingress: MirrorIngress | null;
  lastChunk: number; watchdog: NodeJS.Timeout; release: () => void;
}
export class WebsiteMirror {
  private capture: Capture | null = null;
  constructor(private cast: CastService, private sender: Sender4K, private host: () => BrowserWindow | null,
    private guest: (id: number) => WebContents, private notice: (message: string) => void) {
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      const capture = this.capture, host = this.host();
      if (!capture || capture.consumed || capture.expires < Date.now() || !request.videoRequested ||
        !host || request.frame !== host.webContents.mainFrame || !request.userGesture || capture.guest.isDestroyed()) { callback(null); return; }
      try {
        if (this.guest(capture.guest.id) !== capture.guest) { callback(null); return; }
        capture.consumed = true;
        callback({ video: capture.guest.mainFrame, ...(request.audioRequested ? { audio: capture.guest.mainFrame } : {}), enableLocalEcho: false });
      } catch { callback(null); }
    });
  }
  canCapture(wc: WebContents | null) {
    return !!this.capture && this.capture.expires >= Date.now() && wc === this.host()?.webContents;
  }
  async prepare(webContentsId: number, deviceId: string, title: string, upscale: boolean, options: UpscaleSettings) {
    const target = this.guest(webContentsId);
    await this.stop();
    await this.cast.stop();
    const id = randomUUID();
    const release = () => { void this.stop(id); };
    const capture: Capture = { id, guest: target, expires: Date.now() + 15000, consumed: false, ingress: null,
      lastChunk: Date.now(), release, watchdog: setInterval(() => {
        if (this.capture?.id === id && Date.now() - capture.lastChunk > 30000) { this.notice('Website casting stopped because capture frames stopped arriving.'); void this.stop(id); }
      }, 2000) };
    capture.watchdog.unref();
    this.capture = capture;
    target.once('destroyed', release); target.once('did-navigate', release);
    // Return the single-use grant before encoder probing can consume user activation.
    const input = this.sender.beginMirror(upscale, options);
    capture.ingress = new MirrorIngress(async (bytes) => (await input).write(bytes));
    void this.cast.startMirror(deviceId, title, input.then((encoder) => encoder.ready), options).catch((error) => {
      if (this.capture === capture) { this.notice((error as Error).message); void this.stop(id); }
    });
    return { ticket: id };
  }
  async push(id: string, sequence: number, bytes: Uint8Array) {
    const capture = this.capture;
    if (!capture || capture.id !== id || !capture.consumed || !capture.ingress) throw new Error('This player capture is not active.');
    capture.lastChunk = Date.now();
    await capture.ingress.push(sequence, bytes);
  }
  async stop(id?: string) {
    const capture = this.capture;
    if (!capture || (id && capture.id !== id)) return;
    this.capture = null;
    clearInterval(capture.watchdog); capture.ingress?.close();
    capture.guest.removeListener('destroyed', capture.release); capture.guest.removeListener('did-navigate', capture.release);
    await this.cast.stop();
  }
  onCastState(state: CastState) {
    if (this.capture?.consumed && ['idle', 'error', 'ended'].includes(state.status)) void this.stop(this.capture.id);
  }
}
