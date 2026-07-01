// Tests for the reminder/alarm utterance parser and the wall-clock→epoch resolver.
// We pin a fixed "from" instant and zone so "next 7 o'clock", tomorrow, weekday, and
// am/pm inference are deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.WONDRY_DB = path.join(os.tmpdir(), `wondry-rem-test-${process.pid}.db`);
for (const f of [
  process.env.WONDRY_DB,
  process.env.WONDRY_DB + '-wal',
  process.env.WONDRY_DB + '-shm',
]) {
  try {
    fs.rmSync(f);
  } catch {}
}

const { initSchema } = await import('../server/db.js');
initSchema();
const { parseReminder } = await import('../server/services/reminderParse.js');
const { nextEpochForLocalTime, partsInZone } = await import('../server/services/timezone.js');

const NY = 'America/New_York';
// Fixed reference: 2026-06-24 10:00 EDT (== 14:00 UTC). Wednesday.
const FROM = Date.UTC(2026, 5, 24, 14, 0);

test('parses "remind me to feed the fish at 5pm"', () => {
  const r = parseReminder('remind me to feed the fish at 5pm');
  assert.equal(r.action, 'set');
  assert.equal(r.hour12, 5);
  assert.equal(r.minute, 0);
  assert.equal(r.meridiem, 'pm');
  assert.equal(r.day, null);
  assert.equal(r.message, 'feed the fish');
});

test('parses "set an alarm for 7:30 am" with no message', () => {
  const r = parseReminder('set an alarm for 7:30 am');
  assert.equal(r.hour12, 7);
  assert.equal(r.minute, 30);
  assert.equal(r.meridiem, 'am');
  assert.equal(r.message, null);
});

test('parses "set a reminder for 5:58 to feed the fish"', () => {
  const r = parseReminder('set a reminder for 5:58 to feed the fish');
  assert.equal(r.action, 'set');
  assert.equal(r.hour12, 5);
  assert.equal(r.minute, 58);
  assert.equal(r.message, 'feed the fish');
});

test('parses "set a reminder to take a bath at 7pm"', () => {
  const r = parseReminder('set a reminder to take a bath at 7pm');
  assert.equal(r.hour12, 7);
  assert.equal(r.meridiem, 'pm');
  assert.equal(r.message, 'take a bath');
});

test('parses "create a reminder for 8am"', () => {
  const r = parseReminder('create a reminder for 8am');
  assert.equal(r.hour12, 8);
  assert.equal(r.meridiem, 'am');
  assert.equal(r.message, null);
});

test('parses "wake me up at 6"', () => {
  const r = parseReminder('wake me up at 6');
  assert.equal(r.hour12, 6);
  assert.equal(r.meridiem, null);
});

test('parses tomorrow + "remind me at 8 to brush teeth"', () => {
  const r = parseReminder('remind me tomorrow at 8 to brush my teeth');
  assert.equal(r.day, 'tomorrow');
  assert.equal(r.hour12, 8);
  assert.equal(r.message, 'brush my teeth');
});

test('parses a weekday', () => {
  assert.equal(parseReminder('remind me to take out trash on monday at 7am').day, 'Mon');
});

test('parses half past / quarter to', () => {
  assert.deepEqual(
    (({ hour12, minute }) => ({ hour12, minute }))(parseReminder('set an alarm for half past 6')),
    { hour12: 6, minute: 30 },
  );
  assert.deepEqual(
    (({ hour12, minute }) => ({ hour12, minute }))(parseReminder('set an alarm for quarter to 8')),
    { hour12: 7, minute: 45 },
  );
});

test('cancel phrasings', () => {
  assert.deepEqual(parseReminder('cancel my alarm'), { action: 'cancel' });
  assert.deepEqual(parseReminder('stop the reminder'), { action: 'cancel' });
});

test('non-reminders return null', () => {
  assert.equal(parseReminder('set a timer for 5 minutes'), null); // timer, not reminder
  assert.equal(parseReminder('what time is it'), null);
  assert.equal(parseReminder('tell me about whales'), null);
  assert.equal(parseReminder('remind me'), null); // no time
});

test('relative durations are NOT reminders (they are timers)', () => {
  assert.equal(parseReminder('remind me in 5 minutes'), null);
  assert.equal(parseReminder('set a reminder to water the plants in 1 minute'), null);
  assert.equal(parseReminder('remind me to come inside in half an hour'), null);
});

// ---- resolver ----
const iso = (e) => new Date(e).toISOString();

test('"at 5pm" today resolves to today 5pm EDT (21:00 UTC)', () => {
  const r = parseReminder('remind me to feed the fish at 5pm');
  const e = nextEpochForLocalTime(r, NY, FROM);
  assert.equal(iso(e), '2026-06-24T21:00:00.000Z');
});

test('a time already past today rolls to tomorrow', () => {
  // 8am < 10am now → tomorrow 8am EDT (12:00 UTC next day)
  const r = parseReminder('set an alarm for 8 am');
  assert.equal(iso(nextEpochForLocalTime(r, NY, FROM)), '2026-06-25T12:00:00.000Z');
});

test("am/pm unstated picks the soonest future o'clock", () => {
  // "at 6" at 10am → 6 PM today (18:00 EDT = 22:00 UTC), not 6 AM (past)
  const r = parseReminder('wake me up at 6');
  assert.equal(iso(nextEpochForLocalTime(r, NY, FROM)), '2026-06-24T22:00:00.000Z');
});

test('tomorrow at 8 resolves to next-day morning', () => {
  const r = parseReminder('remind me tomorrow at 8am to brush teeth');
  assert.equal(iso(nextEpochForLocalTime(r, NY, FROM)), '2026-06-25T12:00:00.000Z');
});

test('weekday resolves to the next occurrence', () => {
  // From Wed → next Monday at 7am EDT (11:00 UTC). 2026-06-29 is a Monday.
  const r = parseReminder('remind me to take out trash on monday at 7am');
  const e = nextEpochForLocalTime(r, NY, FROM);
  const p = partsInZone(e, NY);
  assert.equal(p.weekday, 'Mon');
  assert.equal(p.hour, 7);
  assert.equal(p.day, 29);
});
