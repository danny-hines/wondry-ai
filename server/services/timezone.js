// Timezone handling for wall-clock reminders/alarms. The scheduler fires on an
// absolute epoch-ms deadline (timezone-independent), so a zone is only needed at two
// moments: converting a wall-clock time ("7:00 PM") to an epoch when a reminder is
// created, and formatting an epoch back for display. We rely on the OS clock (NTP)
// for correct UTC and let the parent pick an IANA zone (default: the server's), so a
// misconfigured Pi zone doesn't throw everything off. DST is handled via Intl — no
// external date library, keeping the runtime sealed/offline-friendly.
import { getKV, setKV } from '../db.js';

// The zone the device runs in by OS config — our default if the parent hasn't set one.
export function detectedTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function getTimezone() {
  const tz = getKV('timezone', null);
  return tz && isValidTimezone(tz) ? tz : detectedTimezone();
}
export function setTimezone(tz) {
  if (!isValidTimezone(tz)) throw new Error('invalid timezone');
  setKV('timezone', tz);
  return tz;
}

// The list of IANA zones for the console picker (full set; the UI filters it).
export function supportedTimezones() {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [detectedTimezone()];
  }
}

// Wall-clock parts of an instant *as seen in tz* — used for "today" resolution and display.
export function partsInZone(epoch, tz = getTimezone()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(epoch)))
    if (part.type !== 'literal') p[part.type] = part.value;
  return {
    year: +p.year,
    month: +p.month,
    day: +p.day,
    hour: +p.hour % 24,
    minute: +p.minute,
    second: +p.second,
    weekday: p.weekday,
  };
}

// Offset (ms) of tz at a given instant: (that wall-clock interpreted as UTC) − instant.
function tzOffsetMs(epoch, tz) {
  const p = partsInZone(epoch, tz);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - epoch;
}

// Convert a wall-clock time in tz → epoch ms. DST-correct: we guess by treating the
// wall time as UTC, subtract the zone offset at that guess, then refine once in case
// the guess landed on the other side of a DST transition.
export function zonedWallTimeToEpoch(
  { year, month, day, hour, minute, second = 0 },
  tz = getTimezone(),
) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = tzOffsetMs(guess, tz);
  let epoch = guess - offset;
  const offset2 = tzOffsetMs(epoch, tz);
  if (offset2 !== offset) epoch = guess - offset2;
  return epoch;
}

// Parse "YYYY-MM-DDTHH:mm" (an <input type=datetime-local> value, no zone) as a
// wall-clock time in tz → epoch ms. Returns null on malformed input.
export function localInputToEpoch(value, tz = getTimezone()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(value || '');
  if (!m) return null;
  return zonedWallTimeToEpoch(
    { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] },
    tz,
  );
}

// Friendly clock string for an epoch in tz, e.g. "7:05 PM".
export function formatClock(epoch, tz = getTimezone()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(epoch));
}
// Friendly date+time, with Today/Tomorrow when close, e.g. "Today 7:05 PM".
export function formatWhen(epoch, tz = getTimezone()) {
  const now = Date.now();
  const a = partsInZone(now, tz),
    b = partsInZone(epoch, tz);
  const dayDiff = Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000,
  );
  const clock = formatClock(epoch, tz);
  if (dayDiff === 0) return `Today ${clock}`;
  if (dayDiff === 1) return `Tomorrow ${clock}`;
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(epoch));
  return `${date}, ${clock}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Epoch for a specific 24h time on a resolved day, in tz, strictly after `from`.
//  day: null → today, rolling to tomorrow if the time already passed;
//       'tomorrow' → the next calendar day; a weekday abbrev ('Mon'…) → its next
//       occurrence (today allowed only if the time hasn't passed, else next week).
function epochForLocalHM(hour24, minute, day, tz, from) {
  const n = partsInZone(from, tz);
  let baseUTC = Date.UTC(n.year, n.month - 1, n.day); // today's calendar date (as a key)
  if (day === 'tomorrow') baseUTC += 86400000;
  else if (WEEKDAYS.includes(day)) {
    const delta = (WEEKDAYS.indexOf(day) - WEEKDAYS.indexOf(n.weekday) + 7) % 7;
    baseUTC += delta * 86400000;
  }
  const mk = (utcDayKey) => {
    const d = new Date(utcDayKey);
    return zonedWallTimeToEpoch(
      {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        hour: hour24,
        minute,
      },
      tz,
    );
  };
  let epoch = mk(baseUTC);
  if (epoch <= from) {
    // Time already passed for the chosen day → roll to the next valid occurrence.
    if (day === null)
      epoch = mk(baseUTC + 86400000); // tomorrow same time
    else if (WEEKDAYS.includes(day)) epoch = mk(baseUTC + 7 * 86400000); // next week
  }
  return epoch;
}

// Resolve a parsed wall-clock intent to the next future epoch. meridiem null means
// "am/pm not stated" → we try both and pick whichever comes sooner (so "at 7" lands
// on the next 7 o'clock, morning or evening).
export function nextEpochForLocalTime(
  { hour12, minute = 0, meridiem = null, day = null },
  tz = getTimezone(),
  from = Date.now(),
) {
  const to24 = (h, mer) => (mer === 'am' ? (h === 12 ? 0 : h) : h === 12 ? 12 : h + 12);
  const hours = meridiem
    ? [to24(hour12, meridiem)]
    : [...new Set([to24(hour12, 'am'), to24(hour12, 'pm')])];
  const cands = hours
    .map((h24) => epochForLocalHM(h24, minute, day, tz, from))
    .filter((e) => e > from);
  if (!cands.length) return null;
  return Math.min(...cands);
}

// Full local datetime string, e.g. "Wednesday, June 24, 2026 at 10:42 AM" — given to
// the intent classifier so it can infer am/pm and the day for spoken reminder times.
export function describeNow(tz = getTimezone()) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(new Date());
  } catch {
    return new Date().toString();
  }
}

// Current server time, for the console to surface (so a skewed OS clock is visible).
export function serverTimeInfo() {
  const tz = getTimezone();
  const now = Date.now();
  return { epoch: now, timezone: tz, detected: detectedTimezone(), formatted: formatWhen(now, tz) };
}
