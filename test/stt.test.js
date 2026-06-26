import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscript } from '../server/services/stt.js';

test('cleanTranscript drops whisper non-speech markers (the ones seen on the Pi)', () => {
  assert.equal(cleanTranscript('[BLANK_AUDIO]'), '');
  assert.equal(cleanTranscript('[ Silence ]'), '');
  assert.equal(cleanTranscript('(music)'), '');
  assert.equal(cleanTranscript('*laughs*'), '');
  assert.equal(cleanTranscript('   ...   '), '');
  assert.equal(cleanTranscript(''), '');
  assert.equal(cleanTranscript(null), '');
});

test('cleanTranscript keeps real speech (and strips inline markers)', () => {
  assert.equal(cleanTranscript('what do foxes eat'), 'what do foxes eat');
  assert.equal(cleanTranscript('  Yes please!  '), 'Yes please!');
  assert.equal(cleanTranscript('[BLANK_AUDIO] tell me about sharks'), 'tell me about sharks');
});
