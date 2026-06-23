// Block-grid (dot-matrix) avatar engine. Renders to a canvas; moods are cell
// patterns; the mouth is amplitude-driven. app.js/useSpeech feeds it amplitude
// from the playing Piper WAV (real lip-sync); speakFallback uses browser speech.
export type Mood = 'idle' | 'listening' | 'thinking';

export class AvatarEngine {
  private ctx: CanvasRenderingContext2D;
  private COLS = 15; private ROWS = 15;
  private PX: number; private cell: number; private pad: number;
  private buf: Float32Array;
  private mood: Mood = 'idle';
  private color = '#16b8a6';
  private mouthOpen = 0; private mouthTarget = 0;
  private eyeOffX = 0; private eyeOffXTarget = 0;
  private speaking = false;
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
  setMood(m: Mood) { this.mood = m; if (!this.speaking) this.mouthTarget = 0; }
  beginSpeaking() { this.speaking = true; }
  setLevel(v: number) { this.mouthTarget = Math.max(0, Math.min(1, v)); }
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
  private eyes(now: number) {
    const blink = this.blink(now);
    let baseH = 1.3, lookY = 0, scanX = 0;
    if (this.mood === 'listening') baseH = 1.9;
    if (this.mood === 'thinking') { baseH = 1.1; lookY = -1; scanX = Math.sin(now / 480) * 1.3; }
    const h = baseH * blink;
    const ox = Math.round(this.eyeOffX + scanX), oy = Math.round(lookY);
    const cyc = 5 + oy, top = Math.round(cyc - h), bot = Math.round(cyc + h);
    [4, 10].forEach((cx) => this.rect(cx + ox - 1, cx + ox + 1, top, bot, 1));
    if (this.mood === 'listening' && blink > 0.6) [3, 5, 9, 11].forEach((c) => this.set(c + ox, top - 1, 0.55));
  }
  private mouth(now: number) {
    const op = this.mouthOpen;
    if (this.mood === 'thinking' && !this.speaking) { const k = Math.floor(now / 280) % 3; for (let i = 0; i <= k; i++) this.set(6 + i, 11, 0.9); return; }
    if (op < 0.12) { this.rect(5, 9, 11, 11, 0.95); this.set(4, 10, 0.9); this.set(10, 10, 0.9); }
    else { const hh = Math.max(1, Math.round(op * 3)), top = 10, bot = 10 + hh; for (let y = top; y <= bot; y++) { const edge = (y === top || y === bot); this.rect(edge ? 6 : 5, edge ? 8 : 9, y, y, 0.98); } }
  }
  private round(x: number, y: number, w: number, h: number, r: number) {
    const c = this.ctx; c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  private loop(now: number) {
    this.buf.fill(0);
    this.mouthOpen += (this.mouthTarget - this.mouthOpen) * 0.45;
    this.eyeOffX += (this.eyeOffXTarget - this.eyeOffX) * 0.08;
    if (this.mood === 'idle' && now >= this.nextDrift) { this.eyeOffXTarget = [-1, 0, 0, 1][Math.floor(Math.random() * 4)]; this.nextDrift = now + 1600 + Math.random() * 2400; }
    if (this.mood !== 'idle') this.eyeOffXTarget = 0;
    this.eyes(now); this.mouth(now);
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
