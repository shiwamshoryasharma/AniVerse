type QuantumGraph = {
  readonly active: boolean;
  setIntensity(value: number): void;
  close(): void;
};

export function canUseQuantumAudio(url: string) {
  return /^https:\/\/localmedia\.localhost\/[a-f0-9-]{36}$/i.test(url);
}

let compiled: Promise<WebAssembly.Module> | undefined;
function loadQuantumModule() {
  compiled ??= fetch(new URL('./quantum-audio.wasm', document.baseURI))
    .then(response => {
      if (!response.ok) throw new Error('Quantum Audio is unavailable');
      return response.arrayBuffer();
    })
    .then(bytes => WebAssembly.compile(bytes))
    .catch(error => { compiled = undefined; throw error; });
  return compiled;
}

export async function openQuantumAudio(video: HTMLVideoElement, expectedUrl: string, failed: () => void): Promise<QuantumGraph> {
  if (!canUseQuantumAudio(expectedUrl) || video.currentSrc !== expectedUrl || video.mediaKeys) {
    throw new Error('This player does not expose supported audio.');
  }
  const context = new AudioContext({ latencyHint: 'interactive' });
  let source: MediaElementAudioSourceNode | undefined;
  try {
    await Promise.all([
      context.resume(),
      context.audioWorklet.addModule(new URL('./quantum-worklet.js', document.baseURI).href),
    ]);
    const module = await loadQuantumModule();
    const effect = new AudioWorkletNode(context, 'aniverse-quantum-audio', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 8,
      channelCountMode: 'max',
      channelInterpretation: 'discrete',
      outputChannelCount: [2],
      processorOptions: { module },
    });
    const level = effect.parameters.get('intensity');
    if (!level) throw new Error('Quantum Audio is not ready.');
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => done(new Error('Quantum Audio did not start.')), 1800);
      const ready = (event: MessageEvent) => { if (event.data === 'ready') done(); };
      const error = () => done(new Error('Quantum Audio could not start.'));
      const done = (failure?: Error) => {
        window.clearTimeout(timer);
        effect.port.removeEventListener('message', ready);
        effect.removeEventListener('processorerror', error);
        if (failure) reject(failure); else resolve();
      };
      effect.port.addEventListener('message', ready);
      effect.port.start();
      effect.addEventListener('processorerror', error);
    });
    if (!video.isConnected || video.currentSrc !== expectedUrl || video.mediaKeys) {
      throw new Error('The selected video changed.');
    }
    // Validate the graph before rerouting the existing element. Its clock, volume,
    // seeking and playback controls remain owned by the same HTML media element.
    effect.connect(context.destination);
    source = context.createMediaElementSource(video);
    const input = source;
    input.connect(effect);
    const reset = () => effect.port.postMessage('reset');
    const resume = () => { if (context.state === 'suspended') void context.resume().catch(() => {}); };
    const dry = () => {
      input.disconnect();
      input.connect(context.destination);
      effect.disconnect();
      failed();
    };
    video.addEventListener('seeking', reset);
    video.addEventListener('play', resume);
    effect.addEventListener('processorerror', dry, { once: true });
    return {
      active: true,
      setIntensity(value) { level.setValueAtTime(value, context.currentTime); },
      close() {
        video.removeEventListener('seeking', reset);
        video.removeEventListener('play', resume);
        effect.removeEventListener('processorerror', dry);
        input.disconnect();
        effect.disconnect();
        effect.port.close();
        void context.close().catch(() => {});
      },
    };
  } catch (error) {
    if (source) {
      // If the media element was already rerouted, keep a direct audio graph.
      source.connect(context.destination);
      return { active: false, setIntensity() {}, close() { void context.close().catch(() => {}); } };
    }
    void context.close().catch(() => {});
    throw error;
  }
}
const intensityKey = 'aniverse2.quantum-intensity';

export function initialQuantumIntensity() {
  try {
    const stored = localStorage.getItem(intensityKey);
    if (stored !== null && /^\d{1,3}$/.test(stored)) return Math.min(100, Number(stored));
  } catch { /* Preferences are optional. */ }
  return 50;
}

export function saveQuantumIntensity(value: number) {
  try { localStorage.setItem(intensityKey, String(value)); } catch { /* Optional preference. */ }
}
