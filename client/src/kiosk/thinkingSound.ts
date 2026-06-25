// Quiet "thinking" audio: a gentle stream of low, computer-ish beeps and boops
// (R2D2 by way of a library voice) played while the avatar is pondering, in place
// of a spoken filler line. Pure Web Audio — no assets. Synthesized notes with
// short envelopes; occasional pitch glides for the "boop". Kept low and soft.
import { audioCtx } from './audio';

let active = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function note(c: AudioContext, t0: number) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.connect(gain); gain.connect(c.destination);
  osc.type = Math.random() < 0.5 ? 'square' : 'sine';   // square = more "computer"
  const f0 = 170 + Math.random() * 380;                  // low-ish: ~170–550 Hz
  osc.frequency.setValueAtTime(f0, t0);
  const r = Math.random();
  if (r < 0.4) osc.frequency.exponentialRampToValueAtTime(f0 * 1.6, t0 + 0.12);   // beep up
  else if (r < 0.7) osc.frequency.exponentialRampToValueAtTime(Math.max(80, f0 * 0.55), t0 + 0.14); // boop down
  const dur = 0.07 + Math.random() * 0.11;
  const vol = 0.056;                                      // quiet (≈25% louder than 0.045)
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.start(t0); osc.stop(t0 + dur + 0.03);
}

// `delayMs` holds off the first blip — used after a listen session so there's a
// brief silent beat between the stop-listening cue and the thinking beeps. The
// session is still claimed immediately (active=true), so a parallel call is a
// no-op and stopThinkingSound() during the delay cancels cleanly.
export function startThinkingSound(delayMs = 0) {
  if (active) return;
  active = true;
  let ctx: AudioContext;
  try { ctx = audioCtx(); } catch { active = false; return; }
  const tick = () => {
    if (!active) return;
    const now = ctx.currentTime;
    note(ctx, now);
    if (Math.random() < 0.45) note(ctx, now + 0.12);     // quick double-blip, fairly often
    timer = setTimeout(tick, 160 + Math.random() * 250); // ~0.16–0.41s between blips
  };
  timer = setTimeout(tick, delayMs);
}

export function stopThinkingSound() {
  active = false;
  if (timer) { clearTimeout(timer); timer = null; }
}
