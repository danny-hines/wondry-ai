// Verifies the Kokoro engine wiring: a kokoro:-prefixed voice routes to the Kokoro
// HTTP server, and Kokoro voices appear in the picker when configured. Uses a mock
// OpenAI-compatible server (no real Kokoro needed). node --test runs this file in its
// own process, so the KOKORO_URL we set here doesn't leak into the other suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const srv = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    let j = {};
    try {
      j = JSON.parse(b);
    } catch {}
    res.setHeader('content-type', 'audio/wav');
    res.end(Buffer.from(`RIFFmock-${j.voice || '?'}-${j.input || ''}`)); // echo voice + text into the bytes
  });
});
await new Promise((r) => srv.listen(0, r));
process.env.KOKORO_URL = `http://127.0.0.1:${srv.address().port}/v1/audio/speech`;

const { synthesize, listVoices, kokoroEnabled, kokoroVoices } =
  await import('../server/services/tts.js');

test('kokoro is enabled via KOKORO_URL and its voices are listed (prefixed)', () => {
  assert.equal(kokoroEnabled(), true);
  assert.ok(kokoroVoices().length > 0, 'config provides kokoro voices');
  assert.ok(
    listVoices().some((v) => v.startsWith('kokoro:')),
    'kokoro voices appear in the picker',
  );
});

test('synthesize routes a kokoro: voice to the Kokoro server with the right voice + text', async () => {
  const wav = (await synthesize('hello there', 'kokoro:af_bella')).toString();
  assert.match(wav, /RIFFmock-af_bella-hello there/);
});

test.after(() => srv.close());
