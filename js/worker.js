/* Web Worker: runs the measurement off the main thread so the UI stays responsive. */
importScripts('loudness.js');
self.onmessage = (e) => {
  const { id, channels, sampleRate } = e.data;
  try {
    const report = Loudness.measure(channels, sampleRate, (p) => self.postMessage({ id, progress: p }));
    self.postMessage({ id, report });
  } catch (err) { self.postMessage({ id, error: String(err && err.message || err) }); }
};
