// Pick a readable foreground (white or near-black) for text/icons placed ON the
// given solid color. Uses WCAG relative luminance with a threshold tuned to keep
// white on saturated mid-tones (the avatar's teal/blue/purple accents) and only
// flip to dark text on genuinely light colors (pale yellows, etc.).
const DARK_FG = '#1f2430';
const LIGHT_THRESHOLD = 0.45;

export function readableOn(hex: string): string {
  const c = (hex || '').replace('#', '').trim();
  const full = c.length === 3 ? c.split('').map((ch) => ch + ch).join('') : c;
  if (full.length !== 6 || /[^0-9a-f]/i.test(full)) return '#ffffff';
  const ch = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const L = 0.2126 * lin(ch(0)) + 0.7152 * lin(ch(2)) + 0.0722 * lin(ch(4));
  return L > LIGHT_THRESHOLD ? DARK_FG : '#ffffff';
}
