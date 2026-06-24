// Unit tests for the timer utterance parser: durations (digits + number words +
// "half"), optional labels, cancel phrasings, the min/max clamp, and non-matches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimer, formatDuration } from '../server/services/timerParse.js';

const MIN = 1000 * 60;

test('digit durations with units', () => {
  assert.deepEqual(parseTimer('set a timer for 5 minutes'), { action: 'set', durationMs: 5 * MIN, label: null });
  assert.equal(parseTimer('timer for 90 seconds').durationMs, 90 * 1000);
  assert.equal(parseTimer('start a 2 hour timer').durationMs, 2 * 3600000);
});

test('number-word durations', () => {
  assert.equal(parseTimer('set a timer for five minutes').durationMs, 5 * MIN);
  assert.equal(parseTimer('set a timer for ten minutes').durationMs, 10 * MIN);
  assert.equal(parseTimer('set a timer for one minute').durationMs, MIN);
});

test('half durations', () => {
  assert.equal(parseTimer('set a timer for half a minute').durationMs, 30 * 1000);
  assert.equal(parseTimer('timer for half an hour').durationMs, 30 * MIN);
});

test('captures a label from the "to ..." tail', () => {
  const r = parseTimer('set a timer for 10 minutes to take the cookies out');
  assert.equal(r.action, 'set');
  assert.equal(r.durationMs, 10 * MIN);
  assert.equal(r.label, 'take the cookies out');
});

test('does not mistake the duration phrase for a label', () => {
  assert.equal(parseTimer('set a timer for five minutes').label, null);
});

test('cancel phrasings', () => {
  assert.deepEqual(parseTimer('cancel my timer'), { action: 'cancel' });
  assert.deepEqual(parseTimer('stop the timer'), { action: 'cancel' });
  assert.deepEqual(parseTimer('never mind the timer'), { action: 'cancel' });
});

test('clamps absurd durations and tiny ones', () => {
  assert.equal(parseTimer('set a timer for 100 hours').durationMs, 6 * 3600000); // MAX 6h
  assert.equal(parseTimer('set a timer for 1 second').durationMs, 3000);          // MIN 3s
});

test('non-timer utterances return null', () => {
  assert.equal(parseTimer('tell me about dinosaurs'), null);
  assert.equal(parseTimer('what time is it'), null);          // no "timer", no duration
  assert.equal(parseTimer('set a timer'), null);              // no duration
  assert.equal(parseTimer('how many minutes in an hour'), null); // no "timer" word
});

test('formatDuration reads naturally', () => {
  assert.equal(formatDuration(5 * MIN), '5 minutes');
  assert.equal(formatDuration(MIN), '1 minute');
  assert.equal(formatDuration(90 * 1000), '1 minute 30 seconds');
  assert.equal(formatDuration(2 * 3600000), '2 hours');
});
