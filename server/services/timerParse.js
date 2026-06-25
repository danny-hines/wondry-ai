// Pure parser turning a child's utterance into a timer instruction — no DB, no
// clock — so it's easy to unit-test. Two shapes:
//   { action: 'set',    durationMs, label }   e.g. "set a timer for 5 minutes to check cookies"
//   { action: 'cancel' }                       e.g. "cancel my timer" / "stop the timer"
//   null                                        not a timer utterance
// Kids speak durations as digits or words ("five minutes"), single unit, with an
// optional "to <thing>" trailing label. Absolute clock times are out of scope here
// (those become reminders later).

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, ninety: 90, hundred: 100,
};
const UNIT_MS = { sec: 1000, second: 1000, min: 60000, minute: 60000, hour: 3600000, hr: 3600000 };

const MIN_MS = 3000;             // floor so "set a timer" with a tiny number isn't instant
const MAX_MS = 6 * 3600000;      // 6h cap — anything longer is reminder territory

const NUMWORD = 'a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|ninety|hundred';
const UNIT_RE = 'sec(?:ond)?|min(?:ute)?|hour|hr';
// A relative-duration phrase: "in 5 minutes", "in half an hour", "for ten minutes".
// This is what makes something a TIMER ("remind me in 5 minutes") rather than a
// wall-clock reminder ("remind me at 5"). Used to detect intent and to strip the
// duration tail out of a label.
const REL_DURATION = new RegExp(`\\b(?:in|for)\\s+(?:\\d+|${NUMWORD}|half\\s+(?:a|an))\\s*(?:and a half\\s*)?(?:${UNIT_RE})s?\\b`, 'i');
export function isRelativeDuration(text) { return REL_DURATION.test(text || ''); }

const wordToNum = (w) => (/^\d+$/.test(w) ? parseInt(w, 10) : NUMBER_WORDS[w] ?? null);

// "half" handling: "half a minute"/"half an hour" → 0.5 of the unit.
function parseDuration(text) {
  const t = text.toLowerCase();
  // half a/an <unit>
  const half = t.match(/\bhalf\s+(?:a|an)\s+(sec(?:ond)?|min(?:ute)?|hour|hr)s?\b/);
  if (half) {
    const unit = Object.keys(UNIT_MS).find((u) => half[1].startsWith(u));
    if (unit) return UNIT_MS[unit] / 2;
  }
  // <number-or-word> [and a half] <unit>
  const m = t.match(/\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|ninety|hundred)\s*(and a half\s*)?(sec(?:ond)?|min(?:ute)?|hour|hr)s?\b/);
  if (!m) return null;
  const n = wordToNum(m[1]);
  if (n == null) return null;
  const unit = Object.keys(UNIT_MS).find((u) => m[3].startsWith(u));
  if (!unit) return null;
  const extra = m[2] ? UNIT_MS[unit] / 2 : 0;
  return n * UNIT_MS[unit] + extra;
}

// Optional human label: the trailing "to <do something>" (e.g. "... to take the
// cookies out"). The greedy `.*` skips past the duration's own "for 10 minutes" to
// the LAST "to"/"for"; if that tail is itself just a duration, it's not a label.
function parseLabel(text) {
  let m = text.match(/.*\bto\s+(.{2,80}?)\s*$/i);
  if (!m) m = text.match(/.*\bfor\s+(.{2,80}?)\s*$/i);
  if (!m) return null;
  let label = m[1].trim().replace(/[.?!,]+$/, '');
  // Drop a trailing duration that belongs to the timer, not the label
  // ("water the plants in 1 minute" → "water the plants").
  label = label.replace(REL_DURATION, '').replace(/\s{2,}/g, ' ').trim();
  if (!label || parseDuration(label) != null) return null;   // the tail was the duration, not a label
  return label;
}

export function parseTimer(textRaw) {
  const text = (textRaw || '').trim();
  if (!text) return null;
  const low = text.toLowerCase();

  // Cancel: "cancel/stop/clear/delete (my|the) timer", "never mind the timer"
  if (/\b(cancel|stop|clear|delete|remove|never ?mind)\b.*\btimers?\b/.test(low)
      || /\btimers?\b.*\b(cancel|stop|clear|off)\b/.test(low)) {
    return { action: 'cancel' };
  }

  // Set: either the word "timer" with a duration, OR a request phrased with a relative
  // duration ("remind me in 5 minutes", "wake me in 1 minute") — those are countdowns,
  // not wall-clock reminders. Absolute clock times ("at 5pm") fail the relative test
  // and fall through to the reminder parser.
  const mentionsTimer = /\btimers?\b/.test(low);
  const request = /\b(set|start|make|put|create|give me|remind me|wake me|alarm)\b/.test(low);
  if (!mentionsTimer && !(request && REL_DURATION.test(low))) return null;

  const durationMs = parseDuration(low);
  if (durationMs == null) return null;

  // Strip the label tail before measuring, then clamp.
  const ms = Math.max(MIN_MS, Math.min(MAX_MS, durationMs));
  // Only treat the "to …" tail as a label if it isn't just the duration phrase.
  const labelText = parseLabel(text);
  return { action: 'set', durationMs: ms, label: labelText };
}

// Friendly duration for spoken/visible copy: "5 minutes", "1 minute 30 seconds", "2 hours".
export function formatDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  if (s) parts.push(`${s} second${s === 1 ? '' : 's'}`);
  return parts.join(' ') || '0 seconds';
}
