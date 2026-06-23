// Content type: 'reading' — leveled read-along lessons (the child reads aloud, the
// device follows along live and scores gently). Rendered by the native Reader.
import { db, recordReadingAttempt, readingSummary, adaptiveReadingLevel } from '../../db.js';
import { runReading, runText, pickEmoji, titleCase } from '../../services/providers.js';
import { getReadingSystemPrompt } from '../../services/systemPrompt.js';
import { checkReadingContent } from '../../services/safety.js';

// Interests inferred from what the child has recently chatted about.
async function inferInterests(profileId) {
  if (!profileId) return '';
  try {
    const rows = db.prepare(
      `SELECT text FROM messages WHERE profile_id=? AND role='kid' AND text IS NOT NULL AND safety_flag=0 ORDER BY created_at DESC LIMIT 30`
    ).all(profileId);
    if (!rows.length) return '';
    const blob = rows.map((r) => r.text).reverse().join(' ').slice(0, 1500);
    const r = await runText('summarize', {
      system: 'List 2-4 specific topics or characters this child seems interested in, comma-separated. Reply with ONLY the comma-separated list, no other words.',
      prompt: blob,
    });
    return (r || '').replace(/^[^:]*:\s*/, '').replace(/[.\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  } catch { return ''; }
}
function mergeInterests(parts) {
  const seen = new Set(); const out = [];
  for (const part of parts) for (const piece of String(part || '').split(',')) {
    const v = piece.trim(); const k = v.toLowerCase();
    if (v && !seen.has(k)) { seen.add(k); out.push(v); }
  }
  return out.slice(0, 5).join(', ');
}

const isReadingRequest = (t) =>
  /\b(read (with|to) me|read me (a |an )?(story|book)|reading (practice|time|lesson|game)|practice (my )?reading|help me (to )?read|read(ing)? along|read aloud|(a |an )?(story|book) (that )?i can read|(story|book) to read|let'?s read|can i read|i (want|wanna|would like) to read|teach me to read)\b/i.test((t || '').trim());
function readingInterest(text) {
  const m = (text || '').match(/\babout\s+(.+)$/i);
  return m ? m[1].replace(/[?.!]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
}

export default {
  id: 'reading',
  label: 'Reading practice',
  emoji: '📖',
  renderer: 'native',
  ext: 'json',
  uses: { mic: true },
  defaultColor: '#16a34a',
  triggersHelp: 'e.g. "read with me", "read me a story about dinosaurs"',
  createForm: [
    { key: 'interest', label: 'Theme / interest', type: 'text', placeholder: '(optional, e.g. dinosaurs)' },
    { key: 'level', label: 'Level', type: 'level' },
  ],

  matchIntent: (text) => (isReadingRequest(text) ? { interest: readingInterest(text) || undefined } : null),
  intentReply: (params) => (params.interest
    ? `Yay! Let's read a story about ${params.interest} together!`
    : `Yay! Let's read a story together — I'm making one just for you!`),

  async prepare({ params, profile }) {
    const interests = params.interest || mergeInterests([profile.interests, await inferInterests(profile.id)]) || 'a fun story';
    const level = Number(params.level) || adaptiveReadingLevel(profile.id, profile.reading_level);
    return { interests, level };
  },

  plan({ params, profile }) {
    return {
      title: `Reading: ${titleCase(params.interests.split(',')[0].trim()).slice(0, 36)}`,
      emoji: pickEmoji(params.interests),
      color: profile.color || '#16a34a',
      subject: params.interests,
      reading_level: profile.reading_level || null,
      plan: 'A read-along story just for you.',
      promptText: params.interests,
    };
  },

  async generate({ params, profile }) {
    const lesson = await runReading({ profile, interests: params.interests, level: params.level, system: getReadingSystemPrompt() });
    const safe = checkReadingContent(lesson, profile);
    if (safe.verdict === 'block') throw new Error('Reading lesson failed safety scan: ' + safe.reasons.join(', '));
    return {
      data: lesson,
      meta: {
        title: lesson.title, emoji: lesson.emoji, color: profile.color || '#16a34a',
        subject: lesson.interest, reading_level: String(params.level),
        plan: `A ${lesson.pages.length}-page read-along about ${lesson.interest}.`,
      },
    };
  },

  // Progress: one event per line read aloud (kind 'line', value = accuracy score).
  recordEvent({ artifactId, profileId, event }) {
    const e = event || {};
    recordReadingAttempt({
      artifactId, profileId, pageIndex: e.pageIndex, lineIndex: e.lineIndex,
      expected: e.expected, transcript: e.transcript, score: e.score, perWord: e.perWord,
    });
  },
  summary(profileId) { return readingSummary(profileId); },
};
