/*
 * loudness.js — loudness measurement following ITU-R BS.1770-4 / EBU R128 / EBU Tech 3342.
 * Pure JavaScript, no dependencies; works in the browser, in a Web Worker and in Node (tests).
 * Written from the public specifications (formulas, not code, borrowed from the standards).
 *
 * measure(channels, sampleRate, onProgress) -> report:
 *   integrated (LUFS), momentaryMax, shortTermMax, lra (LU), samplePeak & truePeak (dBFS / dBTP),
 *   plr, correlation, dcOffset, clips, plus time series of momentary and short-term loudness.
 */
(function (root) {
  'use strict';

  const ABS_GATE = -70;          // LUFS, absolute gate
  const SEG = 0.1;               // analysis hop: 100 ms (blocks overlap by 75 %)

  /** K-weighting coefficients for any sample rate (two biquads: high shelf + RLB high-pass). */
  function kWeighting(fs) {
    // Stage 1: high shelf (+4 dB above ~1.7 kHz), parameters that reproduce the 48 kHz table
    let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    let K = Math.tan(Math.PI * f0 / fs);
    const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    const shelf = {
      b: [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0],
      a: [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0],
    };
    // Stage 2: second-order high-pass at ~38 Hz
    f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan(Math.PI * f0 / fs);
    a0 = 1 + K / Q + K * K;
    const hp = { b: [1, -2, 1], a: [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] };
    return [shelf, hp];
  }

  /** Channel weights: L, R, C = 1; LFE excluded; surrounds = 1.41 (5.1 order L R C LFE Ls Rs). */
  function channelWeights(n) {
    if (n <= 3) return new Array(n).fill(1);
    if (n === 6) return [1, 1, 1, 0, 1.41, 1.41];
    return new Array(n).fill(1);
  }

  const toLufs = (ms) => (ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity);
  const toDb = (a) => (a > 0 ? 20 * Math.log10(a) : -Infinity);

  /** Filter one channel through the K-weighting and return the energy per 100 ms segment. */
  function segmentEnergy(x, fs, segLen, nSeg) {
    const [s1, s2] = kWeighting(fs);
    const out = new Float64Array(nSeg);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0;
    const [b0, b1, b2] = s1.b, [a1, a2] = s1.a, [c1, c2] = s2.a;
    for (let s = 0, i = 0; s < nSeg; s++) {
      let acc = 0;
      const end = Math.min(x.length, i + segLen);
      for (; i < end; i++) {
        const v = x[i];
        const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;  // shelf (direct form I)
        x2 = x1; x1 = v;
        const z = y - 2 * y1 + y2 - c1 * z1 - c2 * z2;              // high-pass, b = [1,-2,1]
        y2 = y1; y1 = y; z2 = z1; z1 = z;
        acc += z * z;
      }
      out[s] = acc;
    }
    return out;
  }

  /** Windowed-sinc interpolator for 4x true-peak oversampling (phases 1..3; phase 0 = sample). */
  const TP_TAPS = 12;  // taps per side
  const tpKernel = (() => {
    const k = [];
    for (let p = 1; p < 4; p++) {
      const h = [];
      for (let j = -TP_TAPS + 1; j <= TP_TAPS; j++) {
        const t = j - p / 4;                                   // distance in input samples
        const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
        const w = 0.5 + 0.5 * Math.cos(Math.PI * t / (TP_TAPS + 0.5)); // Hann window
        h.push(sinc * w);
      }
      k.push(h);
    }
    return k;
  })();

  /** True peak (linear) of one channel. Only interpolates where a peak can exceed the running max. */
  function truePeak(x) {
    let peak = 0;
    for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
    let tp = peak;
    const thr = () => tp * 0.5;  // inter-sample overs above 2x neighbours do not occur in practice
    for (let i = TP_TAPS - 1; i < x.length - TP_TAPS; i++) {
      if (Math.abs(x[i]) < thr() && Math.abs(x[i + 1]) < thr()) continue;
      for (let p = 0; p < 3; p++) {
        const h = tpKernel[p];
        let acc = 0;
        for (let j = 0, n = i - TP_TAPS + 1; j < h.length; j++, n++) acc += h[j] * x[n];
        const a = Math.abs(acc); if (a > tp) tp = a;
      }
    }
    return { sample: peak, true: tp };
  }

  /** Power-mean loudness of a list of block energies (already channel-weighted mean squares). */
  function gatedMean(blocks, relOffset) {
    const abs = blocks.filter((z) => toLufs(z) > ABS_GATE);
    if (!abs.length) return { value: -Infinity, kept: [] };
    const rel = toLufs(abs.reduce((a, b) => a + b, 0) / abs.length) + relOffset;
    const kept = abs.filter((z) => toLufs(z) > rel);
    return { value: kept.length ? toLufs(kept.reduce((a, b) => a + b, 0) / kept.length) : -Infinity, kept, rel };
  }

  /** Percentile with linear interpolation (p in 0..1) of a sorted array. */
  function percentile(sorted, p) {
    if (!sorted.length) return NaN;
    const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  function measure(channels, fs, onProgress) {
    const prog = onProgress || (() => {});
    const n = channels.length, len = channels[0].length;
    const segLen = Math.round(fs * SEG), nSeg = Math.ceil(len / segLen);
    const w = channelWeights(n);

    // 1) K-weighted energy per 100 ms segment, weighted and summed across channels
    const seg = new Float64Array(nSeg);
    channels.forEach((ch, c) => {
      if (!w[c]) return;
      const e = segmentEnergy(ch, fs, segLen, nSeg);
      for (let s = 0; s < nSeg; s++) seg[s] += w[c] * e[s];
      prog(0.1 + 0.4 * (c + 1) / n);
    });

    // 2) sliding blocks: momentary = 400 ms (4 segments), short-term = 3 s (30 segments)
    const blocks = (k) => {
      const out = [];
      if (nSeg < k) { // shorter than one block: measure what exists (flagged as "short")
        const tot = seg.reduce((a, b) => a + b, 0);
        return [tot / len];
      }
      let acc = 0;
      for (let s = 0; s < nSeg; s++) {
        acc += seg[s];
        if (s >= k) acc -= seg[s - k];
        if (s >= k - 1) out.push(acc / (k * segLen));
      }
      return out;
    };
    const mom = blocks(4), st = blocks(30);

    // 3) integrated loudness (BS.1770-4): absolute gate -70, relative gate -10 LU
    const integ = gatedMean(mom, -10);
    // 4) loudness range (EBU Tech 3342): short-term, abs gate -70, rel gate -20, L95 - L10
    const lraG = gatedMean(st, -20);
    const lraVals = lraG.kept.map(toLufs).sort((a, b) => a - b);
    const lra = lraVals.length > 1 ? percentile(lraVals, 0.95) - percentile(lraVals, 0.10) : 0;

    // 5) peaks, clipping, DC offset, stereo correlation
    let sp = 0, tp = 0, clips = [], dc = [];
    channels.forEach((ch, c) => {
      const p = truePeak(ch); sp = Math.max(sp, p.sample); tp = Math.max(tp, p.true);
      let sum = 0, run = 0;
      for (let i = 0; i < ch.length; i++) {
        const v = ch[i]; sum += v;
        if (Math.abs(v) >= 0.9999) { run++; if (run === 3) clips.push(i / fs); } else run = 0; // 3+ full-scale samples in a row
      }
      dc.push(sum / ch.length);
      prog(0.5 + 0.45 * (c + 1) / n);
    });
    let corr = null;
    if (n === 2) {
      let lr = 0, ll = 0, rr = 0; const [L, R] = channels;
      for (let i = 0; i < len; i++) { lr += L[i] * R[i]; ll += L[i] * L[i]; rr += R[i] * R[i]; }
      corr = ll && rr ? lr / Math.sqrt(ll * rr) : 0;
    }
    clips = [...new Set(clips.map((t) => Math.round(t * 10) / 10))].sort((a, b) => a - b);

    const momL = mom.map(toLufs), stL = st.map(toLufs);
    const maxOf = (a) => a.reduce((m, v) => (v > m ? v : m), -Infinity);
    const iMom = momL.indexOf(maxOf(momL));
    prog(1);
    return {
      sampleRate: fs, channels: n, duration: len / fs, short: nSeg < 30,
      integrated: integ.value, relativeGate: integ.rel,
      momentaryMax: maxOf(momL), loudestAt: iMom >= 0 ? (iMom + 4) * SEG - 0.4 : 0,
      shortTermMax: maxOf(stL), lra,
      samplePeak: toDb(sp), truePeak: toDb(tp), plr: toDb(tp) - integ.value,
      correlation: corr, dcOffset: dc, clips,
      series: { hop: SEG, momentary: momL, shortTerm: stL }, // values at t = (index + window) * hop
    };
  }

  /**
   * Streaming platform normalisation. Targets are public figures as of 2026 and may change;
   * `up` says whether quieter tracks are turned up (limited so the true peak stays <= ceiling).
   */
  const PLATFORMS = [
    { id: 'spotify', name: 'Spotify', target: -14, up: true, ceiling: -1 },
    { id: 'apple', name: 'Apple Music', target: -16, up: true, ceiling: -1 },
    { id: 'youtube', name: 'YouTube', target: -14, up: false },
    { id: 'amazon', name: 'Amazon Music', target: -14, up: false },
    { id: 'tidal', name: 'TIDAL', target: -14, up: false },
    { id: 'deezer', name: 'Deezer', target: -15, up: false },
    { id: 'podcast', name: 'Podcast (Apple)', target: -16, up: true, ceiling: -1 },
    { id: 'ebu', name: 'TV EBU R128', target: -23, up: true, ceiling: -1, broadcast: true },
    { id: 'atsc', name: 'TV ATSC A/85', target: -24, up: true, ceiling: -2, broadcast: true },
  ];

  /** Gain each platform applies, and the resulting playback loudness / peak. */
  function platformGains(r, list = PLATFORMS) {
    return list.map((p) => {
      let gain = p.target - r.integrated;
      if (!isFinite(gain)) gain = 0;
      if (gain > 0 && !p.up) gain = 0;
      if (gain > 0 && p.ceiling !== undefined) gain = Math.max(0, Math.min(gain, p.ceiling - r.truePeak));
      return { ...p, gain, playback: r.integrated + gain, peakAfter: r.truePeak + gain };
    });
  }

  /** Plain-language findings: [{level: ok|warn|bad, key, values}] — texts live in i18n.js. */
  function findings(r) {
    const f = [];
    if (r.short) f.push({ level: 'warn', key: 'fShort' });
    if (!isFinite(r.integrated)) { f.push({ level: 'bad', key: 'fSilent' }); return f; }
    if (r.truePeak > -1) f.push({ level: r.truePeak > 0 ? 'bad' : 'warn', key: 'fTP', v: { tp: r.truePeak.toFixed(1) } });
    else f.push({ level: 'ok', key: 'fTPok', v: { tp: r.truePeak.toFixed(1) } });
    if (r.integrated > -14 && r.truePeak > -2) f.push({ level: 'warn', key: 'fLoudTP' });
    if (r.clips.length) f.push({ level: 'bad', key: 'fClip', v: { n: r.clips.length, t: r.clips.slice(0, 5).map(fmtTime).join(', ') } });
    const down = r.integrated + 14;
    if (down > 0.5) f.push({ level: 'info', key: 'fDown', v: { db: down.toFixed(1) } });
    if (r.integrated < -18) f.push({ level: 'info', key: 'fQuiet' });
    if (r.plr < 6) f.push({ level: 'warn', key: 'fCrushed', v: { plr: r.plr.toFixed(1) } });
    if (r.correlation !== null && r.correlation < 0) f.push({ level: 'bad', key: 'fPhase', v: { c: r.correlation.toFixed(2) } });
    else if (r.correlation !== null && r.correlation < 0.2) f.push({ level: 'warn', key: 'fWide', v: { c: r.correlation.toFixed(2) } });
    if (r.dcOffset.some((d) => Math.abs(d) > 0.005)) f.push({ level: 'warn', key: 'fDC' });
    return f;
  }

  function fmtTime(t) {
    const m = Math.floor(t / 60), s = t - m * 60;
    return `${m}:${s.toFixed(1).padStart(4, '0')}`;
  }

  const api = { measure, kWeighting, truePeak, platformGains, findings, fmtTime, PLATFORMS, toLufs, toDb };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Loudness = api;
})(typeof self !== 'undefined' ? self : this);
