// Content type: 'memory' — a native matching game (the NATIVE-APP stratum: real
// interaction logic lives in a hand-built React component, fed by generated JSON).
import { runStructured, pickEmoji, titleCase } from '../../services/providers.js';
import { getMemorySystemPrompt } from '../../services/systemPrompt.js';
import { mockMemoryGame } from '../../services/mockArtifact.js';
import { recordProgressEvent, progressEvents } from '../../db.js';

const FALLBACK = [
  ['🍎', 'Apple'],
  ['⭐', 'Star'],
  ['🌙', 'Moon'],
  ['🐶', 'Dog'],
  ['🚗', 'Car'],
  ['🌳', 'Tree'],
  ['🐟', 'Fish'],
  ['🎈', 'Balloon'],
];
const oneEmoji = (s) => {
  const m = String(s || '').match(/\p{Extended_Pictographic}/u);
  return m ? m[0] : '';
};

// Coerce model output into exactly 6 pairs with distinct emojis (pad if short).
function normalizeGame(obj, theme) {
  const seen = new Set();
  const pairs = [];
  for (const p of Array.isArray(obj && obj.pairs) ? obj.pairs : []) {
    const emoji = oneEmoji(p && p.emoji);
    const label = String((p && p.label) || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 24);
    if (!emoji || !label || seen.has(emoji)) continue;
    seen.add(emoji);
    pairs.push({ emoji, label });
    if (pairs.length === 6) break;
  }
  for (const [emoji, label] of FALLBACK) {
    if (pairs.length >= 6) break;
    if (!seen.has(emoji)) {
      seen.add(emoji);
      pairs.push({ emoji, label });
    }
  }
  return {
    title: String((obj && obj.title) || `${titleCase(theme)} Memory`).slice(0, 60),
    emoji: oneEmoji(obj && obj.emoji) || pairs[0].emoji,
    theme,
    pairs,
  };
}

const wantsMemory = (t) =>
  /\b(memory game|matching game|match(ing)? cards|memory match|play (a )?memory|concentration game)\b/i.test(
    (t || '').trim(),
  );
function memoryTheme(text) {
  const m = (text || '').match(/\b(?:about|with|of)\s+(.+)$/i);
  return m
    ? m[1]
        .replace(/[?.!]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40)
    : '';
}

export default {
  id: 'memory',
  label: 'Memory game',
  emoji: '🃏',
  renderer: 'native',
  ext: 'json',
  uses: {},
  defaultColor: '#7c3aed',
  triggersHelp: 'e.g. "play a memory game about animals", "matching game"',
  createForm: [
    { key: 'theme', label: 'Theme', type: 'text', placeholder: 'e.g. animals, space, food' },
  ],

  matchIntent: (text) => (wantsMemory(text) ? { theme: memoryTheme(text) || undefined } : null),
  intentReply: (params) =>
    params.theme
      ? `Yes! A ${params.theme} memory game coming up!`
      : `Yes! Let's play a memory game!`,

  prepare: ({ params }) => ({ theme: (params.theme && String(params.theme).trim()) || 'animals' }),

  plan: ({ params, profile }) => ({
    title: `${titleCase(params.theme).slice(0, 36)} Memory`,
    emoji: pickEmoji(params.theme),
    color: profile.color || '#7c3aed',
    subject: params.theme,
    plan: `A matching game about ${params.theme}.`,
    promptText: params.theme,
  }),

  async generate({ params, profile }) {
    const raw = await runStructured('memory', {
      system: getMemorySystemPrompt(),
      prompt: `Pick 6 items for a memory matching game on the theme "${params.theme}" for a child age ${profile.age || 7}.`,
      mock: () => mockMemoryGame({ theme: params.theme }),
    });
    const game = normalizeGame(raw, params.theme);
    return {
      data: game,
      meta: {
        title: game.title,
        emoji: game.emoji,
        color: profile.color || '#7c3aed',
        subject: params.theme,
        plan: `Match ${game.pairs.length} pairs!`,
      },
    };
  },

  // Record a finished game (value = a simple 0..1 efficiency score from move count).
  recordEvent({ artifactId, profileId, event }) {
    const e = event || {};
    recordProgressEvent({
      artifactId,
      profileId,
      type: 'memory',
      kind: 'win',
      value: typeof e.score === 'number' ? e.score : 1,
      data: { moves: e.moves, pairs: e.pairs },
    });
  },
  summary(profileId) {
    const rows = progressEvents(profileId, 'memory');
    return { count: rows.length, lastMoves: rows[0] && rows[0].data ? rows[0].data.moves : null };
  },
};
