/*
 * wav.js — minimal WAV reader (PCM 8/16/24/32-bit integer, 32/64-bit float, WAVE_FORMAT_EXTENSIBLE).
 * Reading WAV ourselves keeps the file's real sample rate and bit depth (the browser decoder
 * resamples everything to the sound card rate, which slightly changes true-peak readings).
 * Returns { sampleRate, bitDepth, format, channels: Float32Array[] } or null if not a WAV we can read.
 */
(function (root) {
  'use strict';
  function readWav(buf) {
    const dv = new DataView(buf);
    const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    if (buf.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
    let fmt = null, off = 12;
    while (off + 8 <= buf.byteLength) {
      const id = tag(off), size = dv.getUint32(off + 4, true), body = off + 8;
      if (id === 'fmt ') {
        let code = dv.getUint16(body, true);
        if (code === 0xfffe && size >= 26) code = dv.getUint16(body + 24, true); // extensible: sub-format GUID
        fmt = { code, ch: dv.getUint16(body + 2, true), sr: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
      } else if (id === 'data' && fmt) {
        const { code, ch, sr, bits } = fmt, bps = bits / 8;
        if (!((code === 1 && [8, 16, 24, 32].includes(bits)) || (code === 3 && [32, 64].includes(bits)))) return null;
        const avail = Math.min(size, buf.byteLength - body);
        const frames = Math.floor(avail / (bps * ch));
        const out = Array.from({ length: ch }, () => new Float32Array(frames));
        for (let i = 0, p = body; i < frames; i++) {
          for (let c = 0; c < ch; c++, p += bps) {
            let v;
            if (code === 3) v = bits === 32 ? dv.getFloat32(p, true) : dv.getFloat64(p, true);
            else if (bits === 8) v = (dv.getUint8(p) - 128) / 128;
            else if (bits === 16) v = dv.getInt16(p, true) / 32768;
            else if (bits === 24) { const x = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getInt8(p + 2) << 16); v = x / 8388608; }
            else v = dv.getInt32(p, true) / 2147483648;
            out[c][i] = v;
          }
        }
        return { sampleRate: sr, bitDepth: bits, format: code === 3 ? 'float' : 'pcm', channels: out };
      }
      off = body + size + (size & 1); // chunks are word-aligned
    }
    return null;
  }

  /** Write a 16-bit PCM WAV (used by the tests and the demo-signal download). */
  function writeWav(channels, sr) {
    const ch = channels.length, n = channels[0].length, buf = new ArrayBuffer(44 + n * ch * 2), dv = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true); dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, n * ch * 2, true);
    for (let i = 0, p = 44; i < n; i++) for (let c = 0; c < ch; c++, p += 2) dv.setInt16(p, Math.max(-32768, Math.min(32767, Math.round(channels[c][i] * 32767))), true);
    return buf;
  }
  const api = { readWav, writeWav };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Wav = api;
})(typeof self !== 'undefined' ? self : this);
