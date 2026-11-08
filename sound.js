// sound.js — the office bell, synthesised with WebAudio (no audio files, nothing copyrighted).
// A struck bell is a handful of inharmonic partials with their own decays, plus a short "clank" of
// filtered noise for the strike. Browsers only start audio after a user gesture, so unlock() is wired
// to the first tap / key press; until then ring() is a silent no-op.
const PARTIALS = [ // [ratio to the base, relative gain, decay seconds] — a hum / prime / tierce / quint / nominal bell
  [0.5, 0.32, 4.2], [1.0, 0.55, 3.2], [1.19, 0.3, 2.4], [1.5, 0.22, 2.0], [2.0, 0.38, 1.7], [2.5, 0.12, 1.1], [3.0, 0.1, 0.8], [4.2, 0.05, 0.45],
];
/** Schedule one strike into any AudioContext (live or Offline) — shared by the page and the tests/recordings. */
export function strike(ctx, dest, t0, { base = 392, strength = 1, detune = 0 } = {}) {
  const f0 = base * Math.pow(2, detune / 12), v = Math.max(0.05, Math.min(1, strength));
  for (const [ratio, gain, decay] of PARTIALS) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = f0 * ratio * (1 + (Math.random() - 0.5) * 0.002);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain * v, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay * (0.7 + v * 0.3));
    o.connect(g); g.connect(dest);
    o.start(t0); o.stop(t0 + decay + 0.1);
  }
  // the strike: 40 ms of band-passed noise
  const n = Math.floor(ctx.sampleRate * 0.04), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), ng = ctx.createGain();
  src.buffer = buf; bp.type = 'bandpass'; bp.frequency.value = f0 * 6; bp.Q.value = 1.4; ng.gain.value = 0.25 * v;
  src.connect(bp); bp.connect(ng); ng.connect(dest); src.start(t0);
}
export function createBell({ base = 392 } = {}) {
  let ctx = null, master = null, muted = false;
  function ensure() {
    if (ctx) return ctx;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createDynamicsCompressor();
    const out = ctx.createGain(); out.gain.value = 0.55;
    master.connect(out); out.connect(ctx.destination);
    return ctx;
  }
  return {
    get unlocked() { return !!ctx && ctx.state === 'running'; },
    get muted() { return muted; },
    setMuted(v) { muted = !!v; },
    unlock() { const c = ensure(); if (c && c.state === 'suspended') c.resume().catch(() => {}); return !!c; },
    /** strength 0..1; detune in semitones (a second strike sounds a little different) */
    ring(strength = 1, detune = 0) {
      if (muted || !ctx || ctx.state !== 'running') return false;
      strike(ctx, master, ctx.currentTime + 0.01, { base, strength, detune });
      return true;
    },
  };
}
