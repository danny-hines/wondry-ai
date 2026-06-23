// Block-grid (dot-matrix) avatar engine. Renders to a canvas; moods are cell
// patterns. The mouth is amplitude-driven during speech (useSpeech feeds Piper WAV
// amplitude via setLevel). Listening shows a volume-reactive EQUALIZER, thinking
// shows a perimeter LOADING RING, and entering/leaving listening plays a smooth
// face<->equalizer morph (dots drop and form bars, then rise and split back).
export type Mood = 'idle' | 'listening' | 'thinking';

const COLS = 15, ROWS = 15;
// Ordered ring of the matrix's outer cells (clockwise) — the thinking loader.
const PATH = ((): [number, number][] => {
  const p: [number, number][] = [];
  for (let x = 0; x < COLS; x++) p.push([x, 0]);
  for (let y = 1; y < ROWS; y++) p.push([COLS - 1, y]);
  for (let x = COLS - 2; x >= 0; x--) p.push([x, ROWS - 1]);
  for (let y = ROWS - 2; y >= 1; y--) p.push([0, y]);
  return p;
})();
// The "ink" cells of a neutral face (two 3x3 eyes + a smile) and their targets in
// a low full-width equalizer base — the dots that physically relocate in the morph.
const FACE_CELLS = ((): { x: number; y: number }[] => {
  const c: { x: number; y: number }[] = [];
  for (const ex of [3, 9]) for (let dx = 0; dx < 3; dx++) for (let dy = 0; dy < 3; dy++) c.push({ x: ex + dx, y: 4 + dy });
  ([[5, 11], [6, 11], [7, 11], [8, 11], [9, 11], [4, 10], [10, 10]] as [number, number][]).forEach(([x, y]) => c.push({ x, y }));
  return c;
})();
const BAR_CELLS = FACE_CELLS.map((_, i) => ({ x: i % COLS, y: 14 - Math.floor(i / COLS) }));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export class AvatarEngine {
  private ctx: CanvasRenderingContext2D;
  private COLS = COLS; private ROWS = ROWS;
  private PX: number; private cell: number; private pad: number;
  private buf: Float32Array;
  private mood: Mood = 'idle';
  private color = '#16b8a6';
  private mouthOpen = 0; private mouthTarget = 0;
  private eyeOffX = 0; private eyeOffXTarget = 0;
  private speaking = false;
  private level = 0; private eqLevel = 0;          // amplitude (setLevel) -> equalizer / lip-sync
  private bars = new Float32Array(COLS);            // smoothed equalizer bar heights
  private morph: 'in' | 'out' | null = null; private morphP = 0;  // face<->equalizer transition
  private nextBlink = performance.now() + 2500; private blinkStart = -1;
  private nextDrift = performance.now() + 2000;
  private raf = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.PX = canvas.width; this.cell = this.PX / this.COLS; this.pad = this.cell * 0.16;
    this.buf = new Float32Array(this.COLS * this.ROWS);
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }
  destroy() { cancelAnimationFrame(this.raf); }
  setColor(c: string) { this.color = c; }
  setMood(m: Mood) {
    if (m === this.mood) return;
    if (m === 'listening') { this.morph = 'in'; this.morphP = 0; }        // face -> equalizer
    else if (this.mood === 'listening') { this.morph = 'out'; this.morphP = 0; } // equalizer -> face
    this.mood = m;
    if (!this.speaking) this.mouthTarget = 0;
  }
  // Amplitude 0..1. Drives the mouth while speaking, and the equalizer while listening.
  setLevel(v: number) { this.level = Math.max(0, Math.min(1, v)); if (this.speaking) this.mouthTarget = this.level; }
  beginSpeaking() { this.speaking = true; }
  endSpeaking() { this.speaking = false; this.mouthTarget = 0; }

  private blink(now: number): number {
    if (now >= this.nextBlink && this.blinkStart < 0) this.blinkStart = now;
    if (this.blinkStart >= 0) {
      const t = now - this.blinkStart;
      if (t > 150) { this.blinkStart = -1; this.nextBlink = now + 2200 + Math.random() * 3200; return 1; }
      if (t < 75) return 1 - t / 75;
      return (t - 75) / 75;
    }
    return 1;
  }
  private set(x: number, y: number, v: number) {
    if (x >= 0 && y >= 0 && x < this.COLS && y < this.ROWS) { const i = y * this.COLS + x; if (v > this.buf[i]) this.buf[i] = v; }
  }
  private rect(x0: number, x1: number, y0: number, y1: number, v: number) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, v);
  }
  // Anti-aliased point: splat a fractional position across the 4 nearest cells.
  private splat(fx: number, fy: number, v: number) {
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    for (let yy = y0; yy <= y0 + 1; yy++) for (let xx = x0; xx <= x0 + 1; xx++) {
      const w = 1 - Math.hypot(fx - xx, fy - yy);
      if (w > 0) this.set(xx, yy, v * w);
    }
  }
  private perimeterPoint(pos: number): [number, number] {
    const L = PATH.length, p = ((pos % L) + L) % L;
    const i0 = Math.floor(p), i1 = (i0 + 1) % L, f = p - i0;
    const a = PATH[i0], b = PATH[i1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  }
  private eyes(now: number) {
    const blink = this.blink(now);
    let baseH = 1.3, lookY = 0, scanX = 0;
    if (this.mood === 'thinking') { baseH = 1.1; lookY = -1; scanX = Math.sin(now / 480) * 1.3; }
    const h = baseH * blink;
    const ox = Math.round(this.eyeOffX + scanX), oy = Math.round(lookY);
    const cyc = 5 + oy, top = Math.round(cyc - h), bot = Math.round(cyc + h);
    [4, 10].forEach((cx) => this.rect(cx + ox - 1, cx + ox + 1, top, bot, 1));
  }
  private mouth() {
    const op = this.mouthOpen;
    if (op < 0.12) { this.rect(5, 9, 11, 11, 0.95); this.set(4, 10, 0.9); this.set(10, 10, 0.9); }
    else { const hh = Math.max(1, Math.round(op * 3)), top = 10, bot = 10 + hh; for (let y = top; y <= bot; y++) { const edge = (y === top || y === bot); this.rect(edge ? 6 : 5, edge ? 8 : 9, y, y, 0.98); } }
  }
  // Listening: a volume-reactive equalizer. Reacts to mic amplitude (setLevel);
  // when quiet/no mic, a gentle floor keeps it alive.
  private equalizer(now: number) {
    const floor = 0.12 + 0.10 * (0.5 + 0.5 * Math.sin(now / 300));
    const lvl = Math.max(this.eqLevel, floor);
    for (let x = 0; x < COLS; x++) {
      const wob = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(now / 180 + x * 0.9));
      const target = Math.min(1, lvl * wob * 1.3);
      this.bars[x] += (target - this.bars[x]) * 0.35;
      const h = Math.round(this.bars[x] * 9);
      for (let k = 0; k <= h; k++) this.set(x, 14 - k, 0.35 + 0.65 * (k / Math.max(1, h)));
    }
  }
  // Thinking: classic "..." in the center wrapped by a comet looping the perimeter.
  private thinking(now: number) {
    const k = Math.floor(now / 280) % 3;
    for (let i = 0; i <= k; i++) this.set(6 + i, 11, 0.95);
    const headF = now / 32, T = 16;
    for (let t = 0; t < T; t++) { const [x, y] = this.perimeterPoint(headF - t); this.splat(x, y, (1 - t / T) * 0.95); }
  }
  // The transition: dots drop to the bottom and form bars ('in'), or rise up and
  // split apart back into the face ('out').
  private drawMorph(mode: 'in' | 'out', p: number) {
    for (let i = 0; i < FACE_CELLS.length; i++) {
      const f = FACE_CELLS[i], b = BAR_CELLS[i];
      let x: number, y: number;
      if (mode === 'in') {
        if (p <= 0.5) { const a = easeInOut(p / 0.5); x = f.x; y = lerp(f.y, 14, a); }
        else { const a = easeInOut((p - 0.5) / 0.5); x = lerp(f.x, b.x, a); y = lerp(14, b.y, a); }
      } else { const a = easeInOut(p); x = lerp(b.x, f.x, a); y = lerp(b.y, f.y, a); }
      this.splat(x, y, 0.95);
    }
  }
  private round(x: number, y: number, w: number, h: number, r: number) {
    const c = this.ctx; c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  private loop(now: number) {
    this.buf.fill(0);
    this.eqLevel += (this.level - this.eqLevel) * 0.3; this.level *= 0.9; // smooth + decay stale input
    this.mouthOpen += (this.mouthTarget - this.mouthOpen) * 0.45;
    this.eyeOffX += (this.eyeOffXTarget - this.eyeOffX) * 0.08;
    if (this.mood === 'idle' && now >= this.nextDrift) { this.eyeOffXTarget = [-1, 0, 0, 1][Math.floor(Math.random() * 4)]; this.nextDrift = now + 1600 + Math.random() * 2400; }
    if (this.mood !== 'idle') this.eyeOffXTarget = 0;

    if (this.morph) {
      this.drawMorph(this.morph, Math.min(1, this.morphP));
      this.morphP += 0.018;                       // ~0.9s transition
      if (this.morphP >= 1) this.morph = null;
    } else if (this.mood === 'listening') {
      this.equalizer(now);
    } else if (this.mood === 'thinking') {
      this.eyes(now); this.thinking(now);
    } else {
      this.eyes(now); this.mouth();
    }

    const breath = 0.93 + 0.07 * (0.5 + 0.5 * Math.sin(now / 1800));
    const ctx = this.ctx; ctx.clearRect(0, 0, this.PX, this.PX);
    for (let y = 0; y < this.ROWS; y++) for (let x = 0; x < this.COLS; x++) {
      const v = this.buf[y * this.COLS + x];
      ctx.globalAlpha = v > 0 ? (0.25 + 0.75 * v) * breath : 0.06;
      ctx.fillStyle = v > 0 ? this.color : '#94a3b8';
      const rx = x * this.cell + this.pad, ry = y * this.cell + this.pad, s = this.cell - this.pad * 2;
      this.round(rx, ry, s, s, s * 0.28); ctx.fill();
    }
    ctx.globalAlpha = 1;
    this.raf = requestAnimationFrame(this.loop);
  }
  // Fallback: browser SpeechSynthesis + a synthetic envelope. Resolves on end.
  speakFallback(text: string): Promise<void> {
    return new Promise((resolve) => {
      const start = performance.now();
      this.speaking = true;
      let raf = 0;
      const tick = () => {
        const t = (performance.now() - start) / 1000;
        const syl = 0.5 + 0.5 * Math.sin(t * 11), jit = 0.5 + 0.5 * Math.sin(t * 27 + 1.7);
        this.mouthTarget = Math.min(1, Math.max(0.08, 0.55 * syl + 0.3 * jit));
        raf = requestAnimationFrame(tick);
      };
      tick();
      const done = () => { cancelAnimationFrame(raf); this.speaking = false; this.mouthTarget = 0; resolve(); };
      if ('speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 0.98; u.pitch = 1.25; u.onend = done; u.onerror = done;
        window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
        setTimeout(done, Math.max(2500, text.length * 90));
      } else setTimeout(done, Math.max(1500, text.length * 60));
    });
  }
}
