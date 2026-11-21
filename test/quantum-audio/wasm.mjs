import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';

const path = new URL('../../test/cache/aniverse2/quantum/wasm32-unknown-unknown/release/aniverse_quantum_audio.wasm', import.meta.url);
const wasm = await readFile(path);
const module = await WebAssembly.compile(wasm);
assert.deepEqual(WebAssembly.Module.imports(module), []);
const {memory, qa_init, qa_reset, qa_input_ptr, qa_output_ptr, qa_process, qa_max_frames} = (await WebAssembly.instantiate(module)).exports;
const stride = qa_max_frames();
const buffer = memory.buffer;
const input = new Float32Array(buffer, qa_input_ptr(), stride * 8);
const output = new Float32Array(buffer, qa_output_ptr(), stride * 2);
assert.equal(stride, 128);
assert.equal(qa_process(stride, 2, 0), 0);
assert.equal(qa_init(48_000), 1);
input[3] = 5;
input[stride + 3] = -6;
assert.equal(qa_process(stride, 2, 0), 1);
assert.equal(output[3], input[3]);
assert.equal(output[stride + 3], input[stride + 3]);
assert.equal(qa_process(stride + 1, 2, 0), 0);
assert.equal(qa_process(stride, 7, 0), 0);
input.fill(0);
for (let block = 0; block < 16; block++) assert.equal(qa_process(stride, 6, 1), 1);
input[11] = 0.25;
assert.equal(qa_process(stride, 6, 1), 1);
assert.ok(output.subarray(0, 11).every((value) => value === 0));
assert.ok(output[11] >= 0.25);
assert.equal(output[stride + 11], 0);
assert.ok(output.subarray(stride + 12).some((value) => value > 0.001));
assert.equal(qa_reset(), 1);
input.fill(0);
assert.equal(qa_process(stride, 6, 1), 1);
assert.ok(output.every((value) => value === 0));
assert.equal(memory.buffer, buffer);

const report = {
  passed: true,
  wasmBytes: wasm.length,
  wasmImports: 0,
  frameStride: stride,
  checks: ['Fixed linear-memory planes', 'Exact stereo unity bypass', 'Bounds validation',
    'Immediate front impulse', 'Delayed contralateral path', 'Seek reset', 'No block-time memory growth'],
};
const artifacts = new URL('../artifacts/', import.meta.url);
await mkdir(artifacts, {recursive: true});
await writeFile(new URL('aniverse-quantum-audio-wasm.json', artifacts), JSON.stringify(report, null, 2) + '\n');
console.log(report);
