import { call, onEvent } from './bridge';
/** User-initiated capture; main grants only the selected, owned source webContents. */
export async function startWebsiteMirror(ticket: string, audio: boolean, onError: (message: string) => void): Promise<() => void> {
  let stream: MediaStream | null = null, recorder: MediaRecorder | null = null;
  let stopped = false, sequence = 0, queued = 0, tail = Promise.resolve();
  let detach: () => void = () => undefined;
  const stop = () => {
    if (stopped) return; stopped = true; detach();
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    stream?.getTracks().forEach((track) => track.stop());
    void call('cast.mirrorStop', { ticket }).catch(() => undefined);
  };
  detach = onEvent('player.captureEnded', (event) => { if (event.ticket === ticket) stop(); });
  try {
    const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('This device cannot encode a browser capture.');
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 24 } }, audio });
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 128_000 });
    recorder.addEventListener('dataavailable', (event) => {
      if (stopped || !event.data.size) return;
      queued += event.data.size;
      if (queued > 8_000_000) { onError('This device cannot keep up with mirroring. Stop other GPU tasks or use direct casting.'); stop(); return; }
      const index = sequence++;
      tail = tail.then(async () => {
        if (!stopped) await call('cast.mirrorChunk', { ticket, sequence: index, bytes: new Uint8Array(await event.data.arrayBuffer()) });
      }).catch((error) => { if (!stopped) { onError(error instanceof Error ? error.message : 'Website casting stopped.'); stop(); } })
        .finally(() => { queued -= event.data.size; });
    });
    recorder.addEventListener('error', () => { if (!stopped) { onError('Browser capture encoding failed.'); stop(); } });
    stream.getVideoTracks()[0]?.addEventListener('ended', stop, { once: true });
    recorder.start(250);
    return stop;
  } catch (error) { stop(); throw error; }
}
