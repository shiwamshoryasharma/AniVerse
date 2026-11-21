(function (workletText, wasm) {
  let active, sequence = 0;
  const isTop = window === window.top;
  function player() {
    const videos = document.querySelectorAll(isTop ? 'video[data-aniverse-media]' : 'video');
    const eligible = Array.from(videos).filter(video => {
      const bounds = video.getBoundingClientRect();
      return bounds.width >= 160 && bounds.height >= 90 &&
        video.checkVisibility({checkVisibilityCSS:true, checkOpacity:true});
    });
    return eligible.length === 1 ? eligible[0] : null;
  }
  function stop() {
    sequence++;
    const graph = active;
    active = undefined;
    if (graph) graph.close();
  }
  function status() {
    if (!active) return {state:'off'};
    const {video, track, context, analyser, buffer, samples, source} = active;
    if (!video.isConnected || video.currentSrc !== source || video.mediaKeys ||
        track.readyState !== 'live' || context.state === 'closed') {
      stop();
      return {state:'off'};
    }
    if (context.state !== 'running' || (track.muted && !video.paused && !video.seeking)) return {state:'waiting'};
    analyser.getFloatTimeDomainData(buffer);
    return {state:'active', mediaTime:video.currentTime, videoFrames:video.getVideoPlaybackQuality().totalVideoFrames,
      playing:!video.paused && !video.seeking, sampleRate:context.sampleRate, samples,
      signal:buffer.some(sample => Math.abs(sample) > 0.0001)};
  }
  async function enable(level) {
    if (active) return resume(level);
    const video = player(), run = ++sequence;
    if (!video || video.readyState < 2 || video.paused || video.muted || video.volume === 0)
      return {state:'waiting'};
    if (!isSecureContext || video.mediaKeys || video.srcObject || !video.captureStream)
      return {state:'unavailable'};
    const source = video.currentSrc;
    let stream, context, effect, output, url, ownsMute = false;
    const listeners = new AbortController();
    const close = () => {
      listeners.abort();
      if (output) output.disconnect();
      if (effect) effect.port.close();
      if (stream) for (const track of stream.getTracks()) track.stop();
      if (context) void context.close().catch(() => {});
      if (url) URL.revokeObjectURL(url);
      if (ownsMute && video.muted) video.muted = false;
    };
    try {
      stream = video.captureStream();
      for (const track of stream.getVideoTracks()) track.stop();
      const tracks = stream.getAudioTracks();
      const track = tracks[0];
      if (tracks.length !== 1 || track.muted || track.readyState !== 'live') throw Error();
      context = new AudioContext({latencyHint:'interactive'});
      url = URL.createObjectURL(new Blob([workletText], {type:'text/javascript'}));
      const prepare = async () => {
        const [, , module] = await Promise.all([
          context.resume(), context.audioWorklet.addModule(url),
          WebAssembly.compile(Uint8Array.from(atob(wasm), byte => byte.charCodeAt(0))),
        ]);
        if (run !== sequence || context.state !== 'running') throw Error();
        effect = new AudioWorkletNode(context, 'aniverse-quantum-audio', {
          numberOfInputs:1, numberOfOutputs:1, channelCount:8, channelCountMode:'max',
          channelInterpretation:'discrete', outputChannelCount:[2],
          processorOptions:{module, report:true}, parameterData:{intensity:level},
        });
        return new Promise((resolve, reject) => {
          effect.port.onmessage = ({data}) => { if (data === 'ready') resolve(); };
          effect.addEventListener('processorerror', reject, {once:true, signal:listeners.signal});
        });
      };
      let timer;
      try {
        await Promise.race([prepare(), new Promise((_, reject) => {timer = setTimeout(reject, 1800);})]);
      } finally { clearTimeout(timer); }
      if (run !== sequence || !video.isConnected || video.currentSrc !== source || video.mediaKeys ||
          video.muted || track.muted || track.readyState !== 'live') throw Error();
      const capture = context.createMediaStreamSource(new MediaStream([track]));
      const gain = output = context.createGain();
      const analyser = context.createAnalyser();
      gain.gain.value = 0;
      analyser.fftSize = 512;
      capture.connect(analyser).connect(effect).connect(gain);
      const graph = {video, track, context, effect, source, analyser, close,
        buffer:new Float32Array(analyser.fftSize), samples:0};
      const leave = () => { if (active === graph) stop(); };
      const options = {signal:listeners.signal};
      effect.port.onmessage = ({data}) => { if (Number.isSafeInteger(data)) graph.samples = data; };
      for (const event of ['emptied','loadstart','encrypted','ended']) video.addEventListener(event, leave, options);
      video.addEventListener('seeking', () => effect.port.postMessage('reset'), options);
      const updateOutput = () => {
        if (active !== graph) return;
        const processing = context.state === 'running' && !track.muted;
        if (processing) {
          if (!video.muted) video.muted = true;
          ownsMute = true;
          gain.gain.value = video.volume;
        } else {
          gain.gain.value = 0;
          if (ownsMute) {
            ownsMute = false;
            video.muted = false;
          }
        }
      };
      video.addEventListener('volumechange', updateOutput, options);
      track.addEventListener('ended', leave, options);
      track.addEventListener('mute', updateOutput, options);
      track.addEventListener('unmute', updateOutput, options);
      stream.addEventListener('removetrack', ({track: removed}) => { if (removed === track) leave(); }, options);
      context.addEventListener('statechange', updateOutput, options);
      effect.addEventListener('processorerror', leave, options);
      window.addEventListener('pagehide', leave, options);
      gain.connect(context.destination);
      active = graph;
      updateOutput();
      return status();
    } catch {
      if (sequence === run) sequence++;
      close();
      return {state:'unavailable'};
    } finally {
      if (url) { URL.revokeObjectURL(url); url = undefined; }
    }
  }
  function resume(intensity) {
    const current = status();
    if (!active) return current;
    active.effect.parameters.get('intensity').value = intensity;
    if (active.context.state !== 'running' && !active.resuming) {
      const graph = active;
      graph.resuming = true;
      void graph.context.resume().catch(() => {}).finally(() => {graph.resuming = false;});
    }
    return current;
  }
  function apply(action, intensity) {
    if (action === 'off') stop();
    if (action === 'enable') return enable(intensity);
    if (action === 'resume') return resume(intensity);
    if (action === 'level' && active) active.effect.parameters.get('intensity').value = intensity;
    return status();
  }
  return apply;
})