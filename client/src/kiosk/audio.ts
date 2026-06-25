// One shared AudioContext for the whole kiosk, kept "warm" so the output device never
// powers down. On some hardware configurations (it varies with the audio output path —
// a USB-audio adapter, an audio HAT, the onboard DAC/amp), the output stage sleeps
// during true silence and then clips the first ~100-300ms of the next sound as it
// powers back up. A *zero-gain* node still reads as silence to the driver — so the
// keepalive must emit a REAL, non-zero signal humans can't hear: a high tone above the
// speaker's reproduction range. It keeps the output stage active without an audible hum.
//
// The frequency/gain are server config, tuned live on the device with `wondry audio` or
// the parent console (which broadcast to the kiosk over the websocket — no reload). They
// default OFF and are enabled/tuned per device where clipping occurs. A `?warmHz=…&
// warmGain=…` URL param still works as a one-off manual override and wins over the server value.

let ctx: AudioContext | null = null;
let keepalive: { osc: OscillatorNode; gain: GainNode } | null = null;

function numParam(key: string): number | null {
  try { const v = parseFloat(new URLSearchParams(location.search).get(key) ?? ''); return Number.isFinite(v) ? v : null; } catch { return null; }
}
const urlHz = numParam('warmHz');
const urlGain = numParam('warmGain');
let warmHz = urlHz ?? 0;          // 0 = keepalive off until the server config / CLI sets it
let warmGain = urlGain ?? 0.02;

const belowNyquist = (c: AudioContext, hz: number) => Math.min(hz, c.sampleRate / 2 - 1000);

// Start / retune / stop the keepalive to match the current params. Safe to call any time.
function retune() {
  if (!ctx) return;
  const on = warmHz > 0 && warmGain > 0;
  if (on && !keepalive) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = belowNyquist(ctx, warmHz);
    gain.gain.value = warmGain;
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start();
    keepalive = { osc, gain };
  } else if (on && keepalive) {
    keepalive.osc.frequency.value = belowNyquist(ctx, warmHz);
    keepalive.gain.gain.value = warmGain;
  } else if (!on && keepalive) {
    try { keepalive.osc.stop(); keepalive.osc.disconnect(); keepalive.gain.disconnect(); } catch { /* already gone */ }
    keepalive = null;
  }
}

// The shared context. Creates it (with the keepalive) on first use and resumes it if
// the browser suspended it — must be called from within a user gesture the first time
// (autoplay policy), which on the kiosk is the first tap.
export function audioCtx(): AudioContext {
  if (!ctx) { ctx = new (window.AudioContext || (window as any).webkitAudioContext)(); retune(); }
  if (ctx.state === 'suspended') ctx.resume().then(retune).catch(() => {});
  return ctx;
}

// Call on the kiosk's first user interaction so the device is warm before any sound.
export function primeAudio() { try { audioCtx(); } catch { /* no audio */ } }

// Apply keepalive params (from the server config or a `wondry audio` broadcast). Retunes
// live — no reload. A URL override wins so manual ?warmHz=… testing isn't clobbered.
export function applyWarm(hz?: number, gain?: number) {
  if (typeof hz === 'number' && urlHz == null) warmHz = hz;
  if (typeof gain === 'number' && urlGain == null) warmGain = gain;
  retune();
}

// A short, sharp-attack test tone (no fade-in) so you can hear whether the start clips
// while tuning the keepalive. Fired by `wondry audio`. Plays after a brief gap so, if
// the keepalive is too weak, the device has a moment to sleep and clip the attack.
export function playTestTone() {
  const c = audioCtx();
  const t0 = c.currentTime + 0.03;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'square';
  osc.frequency.value = 660;
  osc.connect(gain); gain.connect(c.destination);
  gain.gain.setValueAtTime(0.2, t0);                       // instant onset — exposes clipping
  gain.gain.setValueAtTime(0.2, t0 + 0.18);
  gain.gain.linearRampToValueAtTime(0.0001, t0 + 0.22);
  osc.start(t0); osc.stop(t0 + 0.24);
}
