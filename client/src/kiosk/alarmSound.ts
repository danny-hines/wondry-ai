// A friendly "timer's done" alarm — three rising two-note chirps, repeated a couple
// of times so it's noticeable without being harsh (this is a kids' device). Pure
// Web Audio, same asset-free approach as the listen/thinking cues. Returns a stop()
// so a caller can cut it short (e.g. the child taps the timer to dismiss).
import { audioCtx } from './audio';

function chirp(c: AudioContext, f0: number, f1: number, t0: number, dur: number) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.connect(gain); gain.connect(c.destination);
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(f0, t0);
  osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  const vol = 0.12;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}

// Play the alarm. `cycles` is how many times the three-chirp burst repeats.
export function playAlarm(cycles = 3): { stop: () => void } {
  let c: AudioContext; try { c = audioCtx(); } catch { return { stop: () => {} }; }
  const oscs: OscillatorNode[] = [];
  // We can't easily track every node, so for stop() we ride a master timer: the
  // alarm is short and self-stopping, and stop() just prevents further bursts.
  let cancelled = false;
  const BURST = 0.16;     // per-chirp
  const burst = (t0: number) => {
    chirp(c, 660, 990, t0, BURST);
    chirp(c, 770, 1180, t0 + BURST, BURST);
    chirp(c, 880, 1320, t0 + 2 * BURST, BURST);
  };
  const schedule = () => {
    if (cancelled) return;
    const t0 = c.currentTime + 0.02;
    for (let i = 0; i < cycles; i++) burst(t0 + i * (3 * BURST + 0.22));
  };
  schedule();
  return { stop: () => { cancelled = true; oscs.forEach((o) => { try { o.stop(); } catch {} }); } };
}
