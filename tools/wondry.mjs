#!/usr/bin/env node
// `wondry` — small operator CLI for a running Wondry device (SSH into the device and run it).
// It talks to the running server over HTTP, which broadcasts to the kiosk over the
// websocket. Subcommands:
//   audio   interactively tune the audio keepalive (anti-clipping) live on the kiosk
//
// Run it as `npx wondry audio` from the project dir, `npm run audio`, or `node
// tools/wondry.mjs audio`. For a global `wondry` command, `npm link` once.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function baseUrl() {
  let port = process.env.PORT;
  if (!port) { try { port = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).port; } catch { /* default */ } }
  return `http://localhost:${port || 8080}`;
}
const get = async (p) => { const r = await fetch(baseUrl() + p); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
const post = async (p, body) => {
  const r = await fetch(baseUrl() + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
  return r.json();
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

async function audioCmd() {
  console.log(`\nWondry audio keepalive tuner  →  ${baseUrl()}`);
  console.log(`
On some hardware configurations the speaker output powers down during silence and clips
the first ~200ms of each sound (it varies with the USB-audio adapter, audio HAT, or DAC
you use). A continuous, inaudible high tone keeps it awake. Two knobs:

  warmHz    Frequency (Hz) of the keepalive tone — high enough that the speaker can't
            reproduce it audibly. Try 18000–22000. Use 0 to turn the keepalive OFF.
  warmGain  Loudness of that tone, 0–1. Higher = holds the device awake more reliably;
            if you hear a faint whine, lower the gain or raise the frequency. Try 0.01–0.1.

Changes apply to the kiosk instantly. Set values, let it sit a second, then press 't' to
play a test sound and listen for a clipped start. Adjust until it's clean AND silent.
`);
  let cur;
  try { cur = await get('/api/audio'); }
  catch (e) { console.error(`Couldn't reach the server at ${baseUrl()} — is Wondry running?  (${e.message})`); return; }

  for (;;) {
    console.log(`\nCurrent:  warmHz=${cur.warmHz}   warmGain=${cur.warmGain}`);
    const input = (await ask("→ set (e.g. '20000 0.05'), 't' to test sound, Enter to keep, 'q' to quit: ")).trim();
    if (input === 'q' || input === 'quit') break;
    if (input === '') continue;
    if (input === 't' || input === 'test') {
      try { await post('/api/audio/test'); console.log('▶ played a test sound on the kiosk — listen for a clipped attack.'); }
      catch (e) { console.error(`  test failed: ${e.message}`); }
      continue;
    }
    const nums = input.split(/\s+/).map(Number);
    const body = {};
    if (Number.isFinite(nums[0])) body.warmHz = nums[0];
    if (nums.length > 1 && Number.isFinite(nums[1])) body.warmGain = nums[1];
    if (!('warmHz' in body) && !('warmGain' in body)) { console.log("  didn't understand — try '20000 0.05' (Hz then gain), '20000' (just Hz), 't', or 'q'."); continue; }
    try { cur = await post('/api/audio', body); console.log(`✓ applied: warmHz=${cur.warmHz}  warmGain=${cur.warmGain}`); }
    catch (e) { console.error(`  apply failed: ${e.message}`); }
  }
  console.log('Saved — the kiosk will use these values from now on.');
}

const sub = process.argv[2];
(async () => {
  try {
    if (sub === 'audio') await audioCmd();
    else console.log('Usage: wondry <command>\n  audio   tune the audio keepalive (anti-clipping) live on the kiosk');
  } finally { rl.close(); }
})();
