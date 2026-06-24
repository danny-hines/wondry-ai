// Two-tone cues that bookend a listen session, so the child hears when the
// assistant starts and stops listening (like a walkie-talkie). Pure Web Audio —
// no assets. Start = low→high (rising "I'm listening"); stop = high→low (falling
// "got it"). Kept short and soft, in the same register as the thinking beeps.
let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  try {
    if (!ctx) ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  } catch { return null; }
}

// A single beep at frequency `f`, starting at `t0`, lasting `dur` seconds.
function beep(c: AudioContext, f: number, t0: number, dur: number) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.connect(gain); gain.connect(c.destination);
  osc.type = 'sine';
  osc.frequency.setValueAtTime(f, t0);
  const vol = 0.07;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}

const LOW = 520;   // low beep
const HIGH = 780;  // high beep
const DUR = 0.09;  // each beep ~90ms
const GAP = 0.1;   // start of beep 2 after start of beep 1

function pair(first: number, second: number) {
  const c = ensureCtx(); if (!c) return;
  const t0 = c.currentTime + 0.01;
  beep(c, first, t0, DUR);
  beep(c, second, t0 + GAP, DUR);
}

// Start listening: low then high (rising).
export function playStartListening() { pair(LOW, HIGH); }

// Stop listening: high then low (falling).
export function playStopListening() { pair(HIGH, LOW); }
