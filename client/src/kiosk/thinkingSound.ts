// Quiet "thinking" audio: a gentle stream of low, computer-ish beeps and boops
// (R2D2 by way of a library voice) played while the avatar is pondering, in place
// of a spoken filler line. Pure Web Audio — no assets. Synthesized notes with
// short envelopes; occasional pitch glides for the "boop". Kept low and soft.
let ctx: AudioContext | null = null;
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
  const vol = 0.045;                                      // quiet
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.start(t0); osc.stop(t0 + dur + 0.03);
}

export function startThinkingSound() {
  if (active) return;
  active = true;
  try {
    if (!ctx) ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  } catch { active = false; return; }
  const tick = () => {
    if (!active || !ctx) return;
    const now = ctx.currentTime;
    note(ctx, now);
    if (Math.random() < 0.3) note(ctx, now + 0.13);      // occasional quick double-blip
    timer = setTimeout(tick, 260 + Math.random() * 360); // ~0.26–0.62s between blips
  };
  tick();
}

export function stopThinkingSound() {
  active = false;
  if (timer) { clearTimeout(timer); timer = null; }
}
