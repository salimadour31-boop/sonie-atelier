const { readWav, writeWav } = require('../js/wav.js'); const assert = require('assert');
const sr = 44100, L = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10) * 0.5), R = L.map((v) => -v);
const w = readWav(writeWav([L, R], sr));
assert.strictEqual(w.sampleRate, sr); assert.strictEqual(w.bitDepth, 16); assert.strictEqual(w.channels.length, 2);
assert(Math.abs(w.channels[0][123] - L[123]) < 1e-4 && Math.abs(w.channels[1][5] + L[5]) < 1e-4);
// 24-bit and float32 hand-built files
function make(code, bits, values) {
  const bps = bits / 8, buf = new ArrayBuffer(44 + values.length * bps), dv = new DataView(buf), s = (o, t) => [...t].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  s(0, 'RIFF'); s(8, 'WAVE'); s(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, code, true); dv.setUint16(22, 1, true); dv.setUint32(24, 96000, true); dv.setUint16(34, bits, true);
  s(36, 'data'); dv.setUint32(40, values.length * bps, true);
  values.forEach((v, i) => { const p = 44 + i * bps; if (code === 3) dv.setFloat32(p, v, true); else { const x = Math.round(v * 8388607); dv.setUint8(p, x & 255); dv.setUint8(p + 1, (x >> 8) & 255); dv.setInt8(p + 2, x >> 16); } });
  return buf;
}
const a = readWav(make(1, 24, [0.5, -0.25, 1]));
assert(a.bitDepth === 24 && a.sampleRate === 96000 && Math.abs(a.channels[0][1] + 0.25) < 1e-6 && Math.abs(a.channels[0][2] - 1) < 1e-6);
const f = readWav(make(3, 32, [1.5, -0.1]));
assert(f.format === 'float' && Math.abs(f.channels[0][0] - 1.5) < 1e-6, 'float over 0 dBFS kept');
assert.strictEqual(readWav(new ArrayBuffer(10)), null);
console.log('✓ wav reader: 16/24-bit PCM, float32, stereo, rejects non-WAV');
