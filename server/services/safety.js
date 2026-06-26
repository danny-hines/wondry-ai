// Layered safety: keyword input pre-check + output HTML scan. These are the
// SOFT layers — the hard boundary is the CSP sandbox the artifact renders in.
// Kid-facing turns are also pinned to a well-aligned model in config routing.
import { getConfig } from '../config.js';
import { db, uid, now } from '../db.js';

function log(profile_id, stage, verdict, reason, sample) {
  db.prepare('INSERT INTO safety_log (id,profile_id,stage,verdict,reason,sample,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(uid(), profile_id || null, stage, verdict, reason || null, (sample || '').slice(0, 200), now());
}

// Whole-word profanity mask/detect for kid/avatar text + page topics (see profanity.js).
export { maskProfanity, hasProfanity } from './profanity.js';

export function checkInput(text, profile) {
  const cfg = getConfig().safety;
  const lower = (text || '').toLowerCase();
  const hit = cfg.blockedTopics.find((w) => new RegExp(`\\b${w}`, 'i').test(lower));
  if (hit) {
    log(profile?.id, 'input', 'block', `matched "${hit}"`, text);
    return { verdict: 'block', reason: hit, deflection: cfg.deflection };
  }
  log(profile?.id, 'input', 'pass', null, text);
  return { verdict: 'pass' };
}

// Reading lessons are plain text the child reads aloud — scan every line for the
// same blocked keywords as kid input before we store/serve the lesson.
export function checkReadingContent(lesson, profile) {
  const cfg = getConfig().safety;
  const text = ((lesson && lesson.pages) || []).flatMap((p) => p.lines || []).join(' ').toLowerCase();
  const hit = cfg.blockedTopics.find((w) => new RegExp(`\\b${w}`, 'i').test(text));
  const verdict = hit ? 'block' : 'pass';
  log(profile?.id, 'reading', verdict, hit ? `matched "${hit}"` : null, text);
  return { verdict, reasons: hit ? [`blocked word "${hit}"`] : [] };
}

// Declarative content (flashcards, etc.) is plain text rendered by the widget kit;
// scan all of its text for blocked keywords before storing/serving.
export function checkDeclarativeContent(text, profile) {
  const cfg = getConfig().safety;
  const lower = (text || '').toLowerCase();
  const hit = cfg.blockedTopics.find((w) => new RegExp(`\\b${w}`, 'i').test(lower));
  const verdict = hit ? 'block' : 'pass';
  log(profile?.id, 'declarative', verdict, hit ? `matched "${hit}"` : null, lower);
  return { verdict, reasons: hit ? [`blocked word "${hit}"`] : [] };
}

// Output scan: reject artifacts that try to reach the network (defense in depth;
// the CSP already blocks it, but we catch it before writing/serving).
export function checkOutputHTML(html, profile) {
  const bad = [];
  if (/<link\b/i.test(html)) bad.push('external <link>');
  if (/src\s*=\s*["']https?:/i.test(html)) bad.push('remote src');
  if (/<script\b[^>]*\bsrc\s*=/i.test(html)) bad.push('external script');
  if (/fetch\s*\(\s*["']https?:/i.test(html)) bad.push('remote fetch');
  const verdict = bad.length ? 'block' : 'pass';
  log(profile?.id, 'output', verdict, bad.join(', '), null);
  return { verdict, reasons: bad };
}
