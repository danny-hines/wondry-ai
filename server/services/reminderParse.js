// Pure parser turning an utterance into a wall-clock reminder/alarm intent — no DB,
// no clock, no timezone — so it's unit-testable. The conversation route resolves the
// returned wall-clock parts to an absolute epoch via the timezone util. Shapes:
//   { action: 'set', hour12, minute, meridiem, day, message }
//   { action: 'cancel' }
//   null
// meridiem is 'am' | 'pm' | null (null → caller picks the next matching o'clock).
// day is null (today/next) | 'tomorrow' | a weekday abbrev ('Mon'…'Sun').

import { isRelativeDuration } from './timerParse.js';

const WEEKDAYS = {
  sunday: 'Sun',
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
  saturday: 'Sat',
};

// Parse a clock phrase → { hour12, minute, meridiem } or null. Handles "7", "7:30",
// "7pm", "7:30 am", "half past 7", "quarter to 8", "noon", "midnight", "7 o'clock".
function parseTime(text) {
  const t = text.toLowerCase();
  if (/\bnoon\b/.test(t)) return { hour12: 12, minute: 0, meridiem: 'pm' };
  if (/\bmidnight\b/.test(t)) return { hour12: 12, minute: 0, meridiem: 'am' };

  const mer = (s) => (/\bp\.?m\.?\b/.test(s) ? 'pm' : /\ba\.?m\.?\b/.test(s) ? 'am' : null);
  const clampMin = (n) => (n >= 0 && n < 60 ? n : null);

  // "half past 7", "quarter past 7", "quarter to 8"
  let m = t.match(/\b(half|quarter)\s+(past|to|after|till|til)\s+(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)?/);
  if (m) {
    let hour = +m[3];
    const frac = m[1] === 'half' ? 30 : 15;
    let minute,
      meridiem = mer(m[4] || '');
    if (m[2] === 'to' || m[2] === 'till' || m[2] === 'til') {
      minute = 60 - frac;
      hour = hour - 1 || 12;
    } else minute = frac;
    if (hour < 1 || hour > 12) return null;
    return { hour12: hour, minute, meridiem };
  }

  // "7", "7:30", "7.30", "7 o'clock", with optional am/pm
  m = t.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(?:o'?clock\b)?\s*(a\.?m\.?|p\.?m\.?)?/);
  if (m) {
    const hour = +m[1];
    if (hour < 1 || hour > 12) return null; // 24h like "19:00" is unusual in speech; keep to 1–12
    const minute = m[2] != null ? clampMin(+m[2]) : 0;
    if (minute == null) return null;
    return { hour12: hour, minute, meridiem: mer(m[3] || '') };
  }
  return null;
}

// Pull a weekday / "tomorrow" / "today" out of the text → day token (or null).
function parseDay(text) {
  const t = text.toLowerCase();
  if (/\btomorrow\b/.test(t)) return 'tomorrow';
  if (/\btoday\b|\btonight\b|\bthis (morning|afternoon|evening)\b/.test(t)) return 'today';
  for (const [word, abbr] of Object.entries(WEEKDAYS))
    if (new RegExp(`\\b${word}\\b`).test(t)) return abbr;
  return null;
}

// Clean a captured message: strip leading "to", trailing day/time words, punctuation.
function cleanMessage(raw) {
  if (!raw) return null;
  let s = raw.trim().replace(/^to\s+/i, '');
  s = s.replace(/\b(at|by|around)\s+\d{1,2}(?:[:.]\d{2})?\s*(a\.?m\.?|p\.?m\.?)?\b/gi, ' ');
  s = s.replace(
    /\b(today|tonight|tomorrow|this (morning|afternoon|evening)|on\s+\w+day|every\s+\w+|noon|midnight)\b/gi,
    ' ',
  );
  s = s.replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, ' ');
  s = s
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,.;:!?-]+$/, '')
    .replace(/^[\s,.;:]+/, '')
    .trim();
  return s || null;
}

export function parseReminder(textRaw) {
  const text = (textRaw || '').trim();
  if (!text) return null;
  const low = text.toLowerCase();

  // Cancel: "cancel/stop my alarm/reminder"
  if (
    /\b(cancel|stop|clear|delete|remove|never ?mind)\b.*\b(alarm|reminder)s?\b/.test(low) ||
    /\b(alarm|reminder)s?\b.*\b(cancel|stop|clear|off)\b/.test(low)
  ) {
    return { action: 'cancel' };
  }

  // Must look like a reminder/alarm request: "remind me …", "set/create a reminder …",
  // "set an alarm …", or "wake me up …".
  const isReminder =
    /\bremind me\b/.test(low) ||
    /\b(set|make|create|add|start|schedule|put)\b[^.]*\b(reminder|alarm)s?\b/.test(low);
  const isAlarm = /\bwake me( up)?\b/.test(low);
  if (!isReminder && !isAlarm) return null;

  // A relative duration ("in 5 minutes") is a countdown timer, not a wall-clock time —
  // don't misread its number as an o'clock. (The timer parser handles these.)
  if (isRelativeDuration(low)) return null;

  const time = parseTime(low);
  if (!time) return null;
  const day = parseDay(low);

  // Message: "remind me to X at <time>" or "remind me at <time> to X". Alarms usually
  // have none. Prefer an explicit "to ..." clause.
  let message = null;
  let m = text.match(
    /\bremind me\s+(?:to\s+)?(.*?)\s+(?:at|by|around|tomorrow|today|tonight|on)\b/i,
  );
  if (m) message = cleanMessage(m[1]);
  if (!message) {
    m = text.match(/\bto\s+(.+)$/i);
    if (m) message = cleanMessage(m[1]);
  }
  // Don't let a bare time become the message.
  if (message && /^\d{1,2}(?:[:.]\d{2})?\s*(a\.?m\.?|p\.?m\.?)?$/i.test(message)) message = null;

  return {
    action: 'set',
    hour12: time.hour12,
    minute: time.minute,
    meridiem: time.meridiem,
    day,
    message,
  };
}
