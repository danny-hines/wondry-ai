// Grade a child's read-aloud line against the expected text — pure, local, and
// engine-agnostic (works on Web Speech or whisper transcripts). We align the two
// word sequences with a fuzzy LCS so word order is respected, near-misses count,
// and we get a per-word breakdown for coloring the line. Deliberately LENIENT:
// STT on young readers is noisy, so a wrong transcript should never feel punishing.
import type { WordMark } from './types';

const normalize = (s: string) =>
  (s || '').toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').replace(/\s+/g, ' ').trim();
const tokenize = (s: string) => normalize(s).split(' ').filter(Boolean);

// Small Levenshtein, capped — only used to decide "close enough" word matches.
function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let jj = 1; jj <= n; jj++) {
      const cost = a[i - 1] === b[jj - 1] ? 0 : 1;
      cur[jj] = Math.min(prev[jj] + 1, cur[jj - 1] + 1, prev[jj - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}
// Forgiving word equality: exact, or within 1 edit for words of length >= 4
// (handles plural/tense slips and minor STT errors without rewarding nonsense).
export function wordEq(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) >= 4 && lev(a, b) <= 1) return true;
  return false;
}

// Normalize a single display word to its comparable form (keeps 1:1 with the
// on-screen words so a match index maps straight to the highlighted word).
export const normWord = (w: string) => (w || '').toLowerCase().replace(/[^a-z0-9']/g, '');
export const splitWords = (s: string) => (s || '').split(/\s+/).filter(Boolean);

export interface LiveAlign { cursor: number; matched: boolean[]; trailingUnmatched: number }

// Live, forgiving alignment of a running speech buffer against the expected words.
// `expected` and `recognized` are already normalized (normWord). Walks forward,
// matching in order; skips recognized noise AND lets the cursor jump past an
// expected word the recognizer dropped (common for short words like "a"/"the"),
// so flow never stalls. Returns how far we've progressed (cursor), which expected
// words were actually heard (matched), and how many trailing recognized words went
// unmatched (a "they're stuck on this word" signal for a gentle hint).
export function alignLive(expected: string[], recognized: string[]): LiveAlign {
  const matched = expected.map(() => false);
  let ci = 0, ri = 0, lastMatchRi = -1;
  while (ci < expected.length && ri < recognized.length) {
    if (wordEq(recognized[ri], expected[ci])) { matched[ci] = true; ci++; lastMatchRi = ri; ri++; continue; }
    // Did they actually say a slightly-later expected word? Then the recognizer
    // dropped the in-between word(s) — skip past them (left unmatched) and match.
    let skip = -1;
    for (let k = 1; k <= 2 && ci + k < expected.length; k++) if (wordEq(recognized[ri], expected[ci + k])) { skip = k; break; }
    if (skip > 0) { ci += skip; matched[ci] = true; ci++; lastMatchRi = ri; ri++; }
    else ri++; // recognized noise / wrong word — ignore it (never punishes)
  }
  return { cursor: ci, matched, trailingUnmatched: recognized.length - 1 - lastMatchRi };
}

export interface GradeResult { score: number; perWord: WordMark[]; expectedWords: string[] }

export function gradeReading(expected: string, transcript: string): GradeResult {
  const exp = tokenize(expected);
  const got = tokenize(transcript);
  if (!exp.length) return { score: 1, perWord: [], expectedWords: [] };

  // LCS over (exp, got) with fuzzy equality; backtrack to mark matched exp words.
  const m = exp.length, n = got.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let jj = 1; jj <= n; jj++)
      dp[i][jj] = wordEq(exp[i - 1], got[jj - 1]) ? dp[i - 1][jj - 1] + 1 : Math.max(dp[i - 1][jj], dp[i][jj - 1]);

  const matched = new Set<number>();
  let i = m, jj = n;
  while (i > 0 && jj > 0) {
    if (wordEq(exp[i - 1], got[jj - 1]) && dp[i][jj] === dp[i - 1][jj - 1] + 1) { matched.add(i - 1); i--; jj--; }
    else if (dp[i - 1][jj] >= dp[i][jj - 1]) i--;
    else jj--;
  }

  const perWord: WordMark[] = exp.map((w, k) => ({ word: w, ok: matched.has(k) }));
  const score = matched.size / exp.length;
  return { score, perWord, expectedWords: exp };
}

// Encouraging, never-shaming feedback keyed to the score.
export function feedbackFor(score: number, name?: string): string {
  const who = name ? `, ${name}` : '';
  if (score >= 0.95) return `Wow${who}, perfect reading!`;
  if (score >= 0.8) return `Great job${who}! You read that so well.`;
  if (score >= 0.6) return `Nice work${who}! Let's try the tricky words together.`;
  return `Good try${who}! Let's read it together.`;
}
