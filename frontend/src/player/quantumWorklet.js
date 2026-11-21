const supportedChannels = [1, 2, 4, 6, 8];

class QuantumAudioProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'intensity', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }];
  }

  constructor({ processorOptions }) {
    super();
    this.dsp = new WebAssembly.Instance(processorOptions.module).exports;
    if (this.dsp.qa_init(sampleRate) !== 1) throw new Error('Unsupported audio sample rate');
    this.block = this.dsp.qa_max_frames();
    if (this.block !== 128) throw new Error('Unsupported Quantum Audio block size');
    this.input = new Float32Array(this.dsp.memory.buffer, this.dsp.qa_input_ptr(), 8 * this.block);
    this.output = new Float32Array(this.dsp.memory.buffer, this.dsp.qa_output_ptr(), 2 * this.block);
    this.port.onmessage = ({ data }) => { if (data === 'reset') this.dsp.qa_reset(); };
    this.report = processorOptions.report === true;
    this.samples = this.reported = 0;
    this.port.postMessage('ready');
  }

  process(inputs, outputs, parameters) {
    const source = inputs[0];
    const target = outputs[0];
    if (source.length === 0 || target.length !== 2) return true;
    const frames = target[0].length;
    const channels = source.length;
    for (let offset = 0; offset < frames; offset += this.block) {
      const size = Math.min(this.block, frames - offset);
      if (supportedChannels.includes(channels)) {
        for (let channel = 0; channel < channels; channel++) {
          const from = source[channel];
          const base = channel * this.block;
          for (let index = 0; index < size; index++) this.input[base + index] = from[offset + index];
        }
        if (this.dsp.qa_process(size, channels, parameters.intensity[0]) === 1) {
          for (let index = 0; index < size; index++) {
            target[0][offset + index] = this.output[index];
            target[1][offset + index] = this.output[this.block + index];
          }
          continue;
        }
      }
      for (let index = offset; index < offset + size; index++) {
        target[0][index] = source[0][index];
        target[1][index] = (source[1] ?? source[0])[index];
      }
    }
    if (this.report) {
      this.samples += frames;
      if (this.samples - this.reported >= sampleRate / 20) {
        this.reported = this.samples;
        this.port.postMessage(this.samples);
      }
    }
    return true;
  }
}

registerProcessor('aniverse-quantum-audio', QuantumAudioProcessor);