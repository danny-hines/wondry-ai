import test from 'node:test';
import assert from 'node:assert/strict';
import { maskProfanity, hasProfanity } from '../server/services/profanity.js';

test('maskProfanity blanks swears (incl. the whisper mis-transcription that shipped one)', () => {
  assert.equal(maskProfanity("what the fuck she's eat"), "what the **** she's eat");
  assert.equal(
    maskProfanity('Yay! Let me make you a page about what the fuck she’s eat!'),
    'Yay! Let me make you a page about what the **** she’s eat!',
  );
  assert.equal(
    maskProfanity('SHIT and Shitty and fuckin’ awesome'),
    '**** and **** and **** awesome',
  );
});

test('maskProfanity leaves innocent words alone (whole-word only)', () => {
  // substrings of swears must NOT trigger
  assert.equal(
    maskProfanity('a class of bass in the grass, please pass'),
    'a class of bass in the grass, please pass',
  );
  assert.equal(maskProfanity('what do foxes eat'), 'what do foxes eat');
  assert.equal(maskProfanity('assassin assembly assist'), 'assassin assembly assist');
});

test('maskProfanity handles empty/nullish', () => {
  assert.equal(maskProfanity(''), '');
  assert.equal(maskProfanity(null), null);
  assert.equal(maskProfanity(undefined), undefined);
});

test('hasProfanity detects whole words only', () => {
  assert.equal(hasProfanity('what do foxes eat'), false);
  assert.equal(hasProfanity('classic pass glass'), false);
  assert.equal(hasProfanity("what the fuck she's eat"), true);
  assert.equal(hasProfanity('that is bullshit'), true);
});
