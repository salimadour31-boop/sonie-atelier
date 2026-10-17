// Node tests: node tests/loudness.test.js — checks against values defined by the standards.
const L = require('../js/loudness.js');
const assert = require('assert');
let ok = 0; const t = (name, fn) => { fn(); ok++; console.log('✓', name); };
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
const sine = (f, amp, sec, fs, ph = 0) => Float32Array.from({ length: Math.round(sec * fs) }, (_, i) => amp * Math.sin(2 * Math.PI * f * i / fs + ph));
const dB = (d) => Math.pow(10, d / 20);

t('K-weighting coefficients at 48 kHz match the BS.1770 table', () => {
  const [s, h] = L.kWeighting(48000);
  near(s.b[0], 1.53512485958697, 1e-9, 'b0'); near(s.b[1], -2.69169618940638, 1e-9, 'b1'); near(s.b[2], 1.19839281085285, 1e-9, 'b2');
  near(s.a[0], -1.69065929318241, 1e-9, 'a1'); near(s.a[1], 0.73248077421585, 1e-9, 'a2');
  near(h.a[0], -1.99004745483398, 1e-9, 'hp a1'); near(h.a[1], 0.99007225036621, 1e-9, 'hp a2');
});
for (const fs of [44100, 48000, 96000]) t(`EBU Tech 3341: 1 kHz stereo sine at -23 dBFS reads -23.0 LUFS (${fs} Hz)`, () => {
  const x = sine(1000, dB(-23), 20, fs);
  const r = L.measure([x, x], fs);
  near(r.integrated, -23, 0.1, 'integrated'); near(r.shortTermMax, -23, 0.1, 'short-term'); near(r.momentaryMax, -23, 0.1, 'momentary');
  near(r.correlation, 1, 1e-6, 'correlation');
});
t('Relative gate: 20 s at -36 LUFS + 20 s at -23 LUFS -> about -23.0 (quiet part gated out)', () => {
  const fs = 48000, a = sine(1000, dB(-36), 20, fs), b = sine(1000, dB(-23), 20, fs);
  const x = new Float32Array(a.length + b.length); x.set(a); x.set(b, a.length);
  near(L.measure([x, x], fs).integrated, -23, 0.1, 'gated');
});
t('Absolute gate: silence is ignored, pure silence gives -Infinity', () => {
  const fs = 48000, x = new Float32Array(fs * 40); x.set(sine(1000, dB(-23), 20, fs), fs * 10);
  near(L.measure([x, x], fs).integrated, -23, 0.1, 'with silence');
  assert.strictEqual(L.measure([new Float32Array(fs * 5)], fs).integrated, -Infinity);
});
t('EBU Tech 3342-style LRA: -20 LU then -30 LU tone blocks -> LRA ≈ 10 LU', () => {
  const fs = 48000, a = sine(1000, dB(-20), 20, fs), b = sine(1000, dB(-30), 20, fs);
  const x = new Float32Array(a.length + b.length); x.set(a); x.set(b, a.length);
  near(L.measure([x, x], fs).lra, 10, 0.2, 'lra');
});
t('True peak: fs/4 sine with 45° phase -> sample peak -3 dB lower, true peak ≈ 0 dBTP', () => {
  const fs = 48000, x = sine(fs / 4, 1, 2, fs, Math.PI / 4);
  const r = L.measure([x], fs);
  near(r.samplePeak, -3.01, 0.05, 'sample peak'); near(r.truePeak, 0, 0.2, 'true peak');
});
t('Clipping, DC offset, phase-inverted stereo and platform gains', () => {
  const fs = 48000, x = sine(100, 1.5, 3, fs).map((v) => Math.max(-1, Math.min(1, v)) + 0.01);
  const neg = x.map((v) => -v), r = L.measure([x, neg], fs);
  assert(r.clips.length > 0, 'clips'); assert(r.dcOffset[0] > 0.005, 'dc'); near(r.correlation, -1, 0.01, 'corr');
  const keys = L.findings(r).map((f) => f.key);
  ['fClip', 'fPhase', 'fDC', 'fTP'].forEach((k) => assert(keys.includes(k), k));
  const g = L.platformGains({ integrated: -8, truePeak: 0.5 });
  near(g.find((p) => p.id === 'spotify').gain, -6, 1e-9, 'spotify down'); near(g.find((p) => p.id === 'apple').gain, -8, 1e-9, 'apple');
  const q = L.platformGains({ integrated: -20, truePeak: -4 });
  near(q.find((p) => p.id === 'spotify').gain, 3, 1e-9, 'spotify up limited by -1 dBTP ceiling');
  near(q.find((p) => p.id === 'youtube').gain, 0, 1e-9, 'youtube never turns up');
});
t('Speed: 3 min stereo 48 kHz measured in a few seconds', () => {
  const fs = 48000, x = sine(440, 0.5, 180, fs), t0 = Date.now(); L.measure([x, x], fs);
  const s = (Date.now() - t0) / 1000; console.log('   ', s.toFixed(2), 's'); assert(s < 10);
});
console.log(`\n${ok} tests OK`);
