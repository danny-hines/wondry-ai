// Tests for the timezone util: DST-correct wall-clock↔epoch conversion (standard &
// daylight, and across both US spring-forward and fall-back transitions), validation,
// and the datetime-local parser. Uses fixed IANA zones so results are deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.WONDRY_DB = path.join(os.tmpdir(), `wondry-tz-test-${process.pid}.db`);
for (const f of [process.env.WONDRY_DB, process.env.WONDRY_DB + '-wal', process.env.WONDRY_DB + '-shm']) { try { fs.rmSync(f); } catch {} }

const { initSchema } = await import('../server/db.js');
initSchema();
const { zonedWallTimeToEpoch, localInputToEpoch, isValidTimezone, partsInZone, formatClock } = await import('../server/services/timezone.js');

const NY = 'America/New_York';

test('standard time (EST, UTC-5): 7:00 PM Jan 15 2026', () => {
  // 2026-01-15 19:00 EST == 2026-01-16 00:00 UTC
  const epoch = zonedWallTimeToEpoch({ year: 2026, month: 1, day: 15, hour: 19, minute: 0 }, NY);
  assert.equal(new Date(epoch).toISOString(), '2026-01-16T00:00:00.000Z');
});

test('daylight time (EDT, UTC-4): 7:00 AM Jul 1 2026', () => {
  // 2026-07-01 07:00 EDT == 2026-07-01 11:00 UTC
  const epoch = zonedWallTimeToEpoch({ year: 2026, month: 7, day: 1, hour: 7, minute: 0 }, NY);
  assert.equal(new Date(epoch).toISOString(), '2026-07-01T11:00:00.000Z');
});

test('round-trips back to the same wall clock', () => {
  const wall = { year: 2026, month: 3, day: 20, hour: 6, minute: 30 };
  const epoch = zonedWallTimeToEpoch(wall, NY);
  const p = partsInZone(epoch, NY);
  assert.equal(p.hour, 6); assert.equal(p.minute, 30); assert.equal(p.day, 20);
});

test('spring forward: 8:00 AM the morning of DST start (Mar 8 2026) is EDT', () => {
  // After 2:00 AM EST jumps to 3:00 AM EDT; 8 AM is solidly EDT (UTC-4) → 12:00 UTC.
  const epoch = zonedWallTimeToEpoch({ year: 2026, month: 3, day: 8, hour: 8, minute: 0 }, NY);
  assert.equal(new Date(epoch).toISOString(), '2026-03-08T12:00:00.000Z');
});

test('fall back: 8:00 AM the morning of DST end (Nov 1 2026) is EST', () => {
  // After 2:00 AM EDT falls to 1:00 AM EST; 8 AM is EST (UTC-5) → 13:00 UTC.
  const epoch = zonedWallTimeToEpoch({ year: 2026, month: 11, day: 1, hour: 8, minute: 0 }, NY);
  assert.equal(new Date(epoch).toISOString(), '2026-11-01T13:00:00.000Z');
});

test('localInputToEpoch parses a datetime-local value', () => {
  const epoch = localInputToEpoch('2026-01-15T19:00', NY);
  assert.equal(new Date(epoch).toISOString(), '2026-01-16T00:00:00.000Z');
  assert.equal(localInputToEpoch('not-a-date', NY), null);
});

test('timezone validation', () => {
  assert.ok(isValidTimezone('America/Chicago'));
  assert.ok(isValidTimezone('UTC'));
  assert.ok(!isValidTimezone('Mars/Phobos'));
  assert.ok(!isValidTimezone(''));
});

test('formatClock renders 12-hour time in the zone', () => {
  const epoch = Date.UTC(2026, 0, 16, 0, 0); // midnight UTC == 7 PM EST
  assert.equal(formatClock(epoch, NY), '7:00 PM');
});
