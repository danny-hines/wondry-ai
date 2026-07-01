// Integration suite: boots the real server with the mock provider and a throwaway DB,
// then exercises the full surface over HTTP + WebSocket. Run: `npm test`.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8099;
const BASE = `http://localhost:${PORT}`;
const PW = 'wondry';
const DBP = path.join(os.tmpdir(), `wondry-test-${process.pid}.db`);

let srv, kidId;

const j = (r) => r.json();
const api = (p, opts = {}) =>
  fetch(BASE + p, { headers: { 'content-type': 'application/json' }, ...opts });
const admin = (p, opts = {}) =>
  api(p, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      'x-admin-password': PW,
      ...(opts.headers || {}),
    },
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const turn = (profileId, text) =>
  api('/api/turn', { method: 'POST', body: JSON.stringify({ profileId, text }) }).then(j);
const inTray = async (pid, aid) =>
  (await api(`/api/artifacts?profileId=${pid}`).then(j)).artifacts.some((a) => a.id === aid);
const newKid = async (name) =>
  (
    await admin('/api/admin/profiles', {
      method: 'POST',
      body: JSON.stringify({ name, color: '#3b82f6', age: 6 }),
    }).then(j)
  ).id;

async function waitHealth(timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error('server did not become healthy');
}
async function pollReady(id, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const a = await api(`/api/artifacts/${id}`).then(j);
    if (a.status === 'ready') return a;
    if (a.status === 'failed') throw new Error('generation failed: ' + a.error);
    await sleep(150);
  }
  throw new Error('artifact not ready in time');
}

before(async () => {
  for (const f of [DBP, DBP + '-journal', DBP + '-wal', DBP + '-shm']) {
    try {
      fs.rmSync(f);
    } catch {}
  }
  srv = spawn('node', ['--experimental-sqlite', 'server/index.js'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      WONDRY_DB: DBP,
      PORT: String(PORT),
      ANTHROPIC_API_KEY: '',
      ADMIN_PASSWORD: PW,
      PIPER_VOICES_DIR: path.join(os.tmpdir(), 'wondry-novoices'),
    },
  });
  await waitHealth();
  const r = await admin('/api/admin/profiles', {
    method: 'POST',
    body: JSON.stringify({
      name: 'TestKid',
      initials: 'TK',
      color: '#16b8a6',
      age: 6,
      reading_level: 'early reader',
    }),
  }).then(j);
  kidId = r.id;
});
after(() => {
  if (srv) srv.kill('SIGKILL');
  for (const f of [DBP, DBP + '-journal', DBP + '-wal', DBP + '-shm']) {
    try {
      fs.rmSync(f);
    } catch {}
  }
});

test('health reports mock generation', async () => {
  const h = await api('/api/health').then(j);
  assert.equal(h.ok, true);
  assert.equal(h.liveGeneration, false);
});

test('profile created and listed', async () => {
  assert.ok(kidId);
  const { profiles } = await api('/api/profiles').then(j);
  assert.ok(profiles.some((p) => p.id === kidId && p.name === 'TestKid'));
});

test('per-kid theme defaults to light and round-trips through save', async () => {
  // new kids default to light, exposed on the public profile list (kiosk reads this)
  const pub0 = (await api('/api/profiles').then(j)).profiles.find((p) => p.id === kidId);
  assert.equal(pub0.theme, 'light');
  // save dark, confirm it persists; an invalid value is coerced back to light
  await admin('/api/admin/profiles', {
    method: 'POST',
    body: JSON.stringify({
      id: kidId,
      name: 'TestKid',
      initials: 'TK',
      color: '#16b8a6',
      theme: 'dark',
    }),
  });
  assert.equal(
    (await api('/api/profiles').then(j)).profiles.find((p) => p.id === kidId).theme,
    'dark',
  );
  await admin('/api/admin/profiles', {
    method: 'POST',
    body: JSON.stringify({
      id: kidId,
      name: 'TestKid',
      initials: 'TK',
      color: '#16b8a6',
      theme: 'banana',
    }),
  });
  assert.equal(
    (await api('/api/profiles').then(j)).profiles.find((p) => p.id === kidId).theme,
    'light',
  );
});

test('admin endpoints are password gated', async () => {
  assert.equal((await fetch(BASE + '/api/admin/log')).status, 401);
  assert.equal((await admin('/api/admin/log')).status, 200);
});

test('a plain question is answered in chat, NOT built into a page', async () => {
  const res = await turn(kidId, 'what time is it?');
  assert.equal(res.kind, 'chat');
  assert.ok(!res.artifactId, 'no page generated for a simple question');
});

test('a greeting stays chat with no page offer', async () => {
  const res = await turn(kidId, "how's it going?");
  assert.equal(res.kind, 'chat');
  assert.doesNotMatch(res.reply, /make you a page/i);
});

test('an explicit request builds a ready, self-contained, sandboxed page', async () => {
  const res = await turn(kidId, 'make me a page about the rock cycle');
  assert.equal(res.kind, 'artifact');
  assert.ok(res.artifactId);
  assert.ok(
    res.artifact && res.artifact.id === res.artifactId,
    'artifact object returned so the card renders below the reply',
  );
  const a = await pollReady(res.artifactId);
  assert.equal(a.status, 'ready');
  assert.equal(await inTray(kidId, res.artifactId), true);
  const r = await api(`/api/artifact/${res.artifactId}`);
  const csp = r.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'self'/);
  const html = await r.text();
  assert.match(html, /<!DOCTYPE html>/i);
  assert.doesNotMatch(html, /src=["']https?:/i);
  assert.match(html, /postMessage/);
});

test('a learnable question offers a page, and "yes" then builds it', async () => {
  const kid = await newKid('Curious');
  const ask = await turn(kid, 'how is glass made?');
  assert.equal(ask.kind, 'chat');
  assert.match(ask.reply, /make you a page/i, 'offers a page for an explorable question');
  const yes = await turn(kid, 'yes');
  assert.equal(yes.kind, 'artifact', 'the follow-up "yes" builds the offered page');
  assert.ok(yes.artifactId);
  await pollReady(yes.artifactId);
});

test('websocket emits created and completed for a generation', async () => {
  const WS = globalThis.WebSocket;
  const ws = new WS(`ws://localhost:${PORT}/ws`);
  const types = [];
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  ws.addEventListener('message', (e) => {
    try {
      types.push(JSON.parse(e.data).type);
    } catch {}
  });
  await turn(kidId, 'make me a page about space');
  await sleep(1500);
  ws.close();
  assert.ok(types.includes('artifact.created'));
  assert.ok(types.includes('artifact.completed'));
});

test('unsafe input is blocked with a deflection', async () => {
  const res = await turn(kidId, 'show me a gun');
  assert.equal(res.blocked, true);
  const { safety } = await admin('/api/admin/log').then(j);
  assert.ok(safety.some((s) => s.verdict === 'block'));
});

test('tray seen-tracking clears the badge', async () => {
  const before = await api(`/api/artifacts?profileId=${kidId}`).then(j);
  assert.ok(before.unseen >= 1);
  const target = before.artifacts.find((a) => a.status === 'ready' && !a.seen);
  await api(`/api/artifacts/${target.id}/seen`, {
    method: 'POST',
    body: JSON.stringify({ profileId: kidId }),
  });
  const after = await api(`/api/artifacts?profileId=${kidId}`).then(j);
  assert.ok(after.unseen < before.unseen);
});

test('parent authoring is held until toggled on for a child, and is reversible', async () => {
  const { artifactId } = await admin('/api/admin/author', {
    method: 'POST',
    body: JSON.stringify({ topic: 'a bedtime story about the moon' }),
  }).then(j);
  await pollReady(artifactId);
  assert.equal(await inTray(kidId, artifactId), false);
  await admin(`/api/admin/artifacts/${artifactId}/audience`, {
    method: 'POST',
    body: JSON.stringify({ profileId: kidId, on: true }),
  });
  assert.equal(await inTray(kidId, artifactId), true);
  await admin(`/api/admin/artifacts/${artifactId}/audience`, {
    method: 'POST',
    body: JSON.stringify({ profileId: kidId, on: false }),
  });
  assert.equal(await inTray(kidId, artifactId), false);
});

test('a page can be shared to a second child', async () => {
  const kid2 = await newKid('Sib');
  const { artifactId } = await admin('/api/admin/author', {
    method: 'POST',
    body: JSON.stringify({ topic: 'fun facts about clouds' }),
  }).then(j);
  await pollReady(artifactId);
  await admin(`/api/admin/artifacts/${artifactId}/audience`, {
    method: 'POST',
    body: JSON.stringify({ profileId: kidId, on: true }),
  });
  await admin(`/api/admin/artifacts/${artifactId}/audience`, {
    method: 'POST',
    body: JSON.stringify({ profileId: kid2, on: true }),
  });
  assert.equal(await inTray(kidId, artifactId), true);
  assert.equal(await inTray(kid2, artifactId), true);
});

test('deleting content removes it for everyone', async () => {
  const { artifactId } = await admin('/api/admin/author', {
    method: 'POST',
    body: JSON.stringify({ topic: 'how rainbows form' }),
  }).then(j);
  await pollReady(artifactId);
  await admin(`/api/admin/artifacts/${artifactId}/audience`, {
    method: 'POST',
    body: JSON.stringify({ profileId: kidId, on: true }),
  });
  await admin(`/api/admin/artifacts/${artifactId}/delete`, { method: 'POST' });
  assert.equal((await api(`/api/artifacts/${artifactId}`)).status, 404);
  assert.equal(await inTray(kidId, artifactId), false);
});

test('removing a child deletes their activity but keeps their content (orphaned)', async () => {
  const kid3 = await newKid('Temp');
  await turn(kid3, 'hello');
  const made = await turn(kid3, 'make me a page about bugs');
  await pollReady(made.artifactId);
  await admin(`/api/admin/profiles/${kid3}/delete`, { method: 'POST' });
  const { profiles } = await api('/api/profiles').then(j);
  assert.ok(!profiles.some((p) => p.id === kid3));
  const a = await api(`/api/artifacts/${made.artifactId}`).then(j);
  assert.equal(a.status, 'ready');
  assert.equal(a.profile_id, null);
});

test('system prompt is editable and persists', async () => {
  const c0 = await admin('/api/admin/config').then(j);
  assert.ok(c0.systemPrompt.length > 0);
  const marker = 'TEST-MARKER ' + Date.now();
  await admin('/api/admin/config', {
    method: 'POST',
    body: JSON.stringify({ systemPrompt: c0.systemPrompt + '\n' + marker }),
  });
  const c1 = await admin('/api/admin/config').then(j);
  assert.match(c1.systemPrompt, new RegExp(marker));
});

test('a reading request builds a leveled read-along lesson with valid pages', async () => {
  const res = await turn(kidId, 'read with me');
  assert.equal(res.kind, 'artifact');
  await pollReady(res.artifactId);
  // it's a reading-type artifact, auto-published to the asking kid
  const meta = await api(`/api/artifacts/${res.artifactId}`).then(j);
  assert.equal(meta.type, 'reading');
  assert.equal(await inTray(kidId, res.artifactId), true);
  // the lesson JSON is well-formed: pages with non-empty single-line strings
  const lesson = await api(`/api/content/${res.artifactId}`).then(j);
  assert.ok(Array.isArray(lesson.pages) && lesson.pages.length > 0);
  assert.ok(lesson.pages.every((p) => Array.isArray(p.lines) && p.lines.length > 0));
  assert.ok(lesson.pages[0].lines.every((l) => typeof l === 'string' && l.trim().length > 0));
  assert.ok(lesson.level >= 1 && lesson.level <= 5);
});

test('parent can author a reading lesson and recorded attempts feed the report', async () => {
  const { artifactId } = await admin('/api/admin/author-reading', {
    method: 'POST',
    body: JSON.stringify({ interest: 'dinosaurs', level: 3, profileId: kidId }),
  }).then(j);
  const lesson = await pollReady(artifactId).then(() => api(`/api/content/${artifactId}`).then(j));
  const expected = lesson.pages[0].lines[0];
  // a near-perfect read and a poor read, posted as generic content events
  await api(`/api/content/${artifactId}/event`, {
    method: 'POST',
    body: JSON.stringify({
      profileId: kidId,
      event: {
        pageIndex: 0,
        lineIndex: 0,
        expected,
        transcript: expected,
        score: 1,
        perWord: expected.split(/\s+/).map((w) => ({ word: w, ok: true })),
      },
    }),
  });
  await api(`/api/content/${artifactId}/event`, {
    method: 'POST',
    body: JSON.stringify({
      profileId: kidId,
      event: {
        pageIndex: 0,
        lineIndex: 1,
        expected: 'the quick brown fox',
        transcript: 'the brown',
        score: 0.5,
        perWord: [
          { word: 'the', ok: true },
          { word: 'quick', ok: false },
          { word: 'brown', ok: true },
          { word: 'fox', ok: false },
        ],
      },
    }),
  });
  const { report } = await admin('/api/admin/reading-report').then(j);
  const row = report.find((r) => r.id === kidId);
  assert.ok(row && row.count >= 2);
  assert.ok(row.avg > 0 && row.avg < 1);
  assert.ok(row.missWords.some((m) => m.word === 'quick' || m.word === 'fox'));
});

test('a flashcards request builds a declarative deck', async () => {
  const res = await turn(kidId, 'make flashcards about animals');
  assert.equal(res.kind, 'artifact');
  await pollReady(res.artifactId);
  const meta = await api(`/api/artifacts/${res.artifactId}`).then(j);
  assert.equal(meta.type, 'flashcards');
  const doc = await api(`/api/content/${res.artifactId}`).then(j);
  assert.ok(Array.isArray(doc.blocks) && doc.blocks.length > 0);
  const fc = doc.blocks.find((b) => b.type === 'flashcards');
  assert.ok(fc && fc.cards.length >= 3, 'has a flashcards block with cards');
  assert.ok(
    fc.cards.every((c) => c.front && c.back),
    'cards have front + back',
  );
});

test('a memory-game request builds a native game with 6 distinct pairs', async () => {
  const res = await turn(kidId, 'play a memory game about animals');
  assert.equal(res.kind, 'artifact');
  await pollReady(res.artifactId);
  const meta = await api(`/api/artifacts/${res.artifactId}`).then(j);
  assert.equal(meta.type, 'memory');
  const game = await api(`/api/content/${res.artifactId}`).then(j);
  assert.equal(game.pairs.length, 6);
  assert.equal(new Set(game.pairs.map((p) => p.emoji)).size, 6, 'distinct emojis');
  assert.ok(
    game.pairs.every((p) => p.emoji && p.label),
    'each pair has emoji + label',
  );
});

test('an explorable request builds a declarative scene with focusable nodes', async () => {
  const res = await turn(kidId, 'show me a diagram of the solar system');
  assert.equal(res.kind, 'artifact');
  await pollReady(res.artifactId);
  const meta = await api(`/api/artifacts/${res.artifactId}`).then(j);
  assert.equal(meta.type, 'explorable');
  const doc = await api(`/api/content/${res.artifactId}`).then(j);
  const scene = doc.blocks.find((b) => b.type === 'scene');
  assert.ok(scene, 'has a scene block');
  assert.ok(['orbit', 'map', 'cycle'].includes(scene.layout), 'valid layout');
  assert.ok(scene.nodes.length >= 2, 'scene has focusable nodes');
  assert.ok(
    scene.nodes.every((nd) => nd.label && nd.emoji),
    'nodes have label + emoji',
  );
});

test('presence ingress validates state and reflects it (greet-on-approach)', async () => {
  const bad = await api('/api/presence', {
    method: 'POST',
    body: JSON.stringify({ state: 'nope' }),
  });
  assert.equal(bad.status, 400, 'invalid state rejected');
  const ok = await api('/api/presence', {
    method: 'POST',
    body: JSON.stringify({ state: 'present' }),
  }).then(j);
  assert.equal(ok.state, 'present');
  const got = await api('/api/presence').then(j);
  assert.equal(got.state, 'present');
  assert.equal(got.enabled, false); // config.presence.enabled defaults off
});

test('wake word: config defaults off, and a detection POST is ignored while disabled', async () => {
  const cfg = await api('/api/wake/config').then(j);
  assert.equal(cfg.enabled, false); // off by default
  assert.ok(
    cfg.phrases.some((p) => p.key === cfg.phrase),
    'phrase is one of the presets',
  );
  const r = await api('/api/wake', { method: 'POST', body: JSON.stringify({}) }).then(j);
  assert.equal(r.ok, false); // disabled → no broadcast
  assert.equal(r.reason, 'disabled');
});

test('server STT reports unavailable (falls back to browser) when whisper is not configured', async () => {
  const r = await api('/api/stt', {
    method: 'POST',
    headers: { 'content-type': 'audio/webm' },
    body: Buffer.from([1, 2, 3, 4]),
  }).then(j);
  assert.equal(r.available, false);
  assert.equal(r.text, '');
});

test('content-types manifest lists registered types with renderers + create forms', async () => {
  const { types } = await api('/api/content-types').then(j);
  const ids = types.map((t) => t.id);
  for (const id of ['page', 'reading', 'flashcards', 'memory', 'explorable'])
    assert.ok(ids.includes(id), 'missing type ' + id);
  assert.equal(types.find((t) => t.id === 'explorable').renderer, 'declarative');
  assert.equal(types.find((t) => t.id === 'flashcards').renderer, 'declarative');
  assert.equal(types.find((t) => t.id === 'memory').renderer, 'native');
  assert.equal(types.find((t) => t.id === 'page').renderer, 'sandbox-html');
  // every type exposes a create form (page got one too) so the Create tab is generic
  assert.ok(types.every((t) => Array.isArray(t.createForm)));
  assert.ok(types.find((t) => t.id === 'page').createForm.length >= 1);
});

test('generic admin authoring works for any content type', async () => {
  const { artifactId } = await admin('/api/admin/content', {
    method: 'POST',
    body: JSON.stringify({ typeId: 'memory', params: { theme: 'space' } }),
  }).then(j);
  const meta = await pollReady(artifactId);
  assert.equal(meta.type, 'memory');
});

test('disabling a content type globally removes it from manifests + voice routing', async () => {
  await admin('/api/admin/content-types/flashcards', {
    method: 'POST',
    body: JSON.stringify({ enabled: false }),
  });
  // a flashcards request no longer builds a flashcards artifact (falls through to chat/page)
  const res = await turn(kidId, 'make flashcards about colors');
  assert.notEqual(res.kind === 'artifact' && res.artifact && res.artifact.type, 'flashcards');
  // re-enable and confirm it works again
  await admin('/api/admin/content-types/flashcards', {
    method: 'POST',
    body: JSON.stringify({ enabled: true }),
  });
  const res2 = await turn(kidId, 'make flashcards about colors');
  assert.equal(res2.artifact.type, 'flashcards');
});

test('per-child disabled types are skipped in voice routing', async () => {
  const k = await newKid('NoGames');
  await admin('/api/admin/profiles', {
    method: 'POST',
    body: JSON.stringify({
      id: k,
      name: 'NoGames',
      initials: 'NG',
      color: '#3b82f6',
      age: 6,
      disabledTypes: ['memory'],
    }),
  });
  const res = await turn(k, 'play a memory game about animals');
  // memory is off for this child, so it should NOT build a memory artifact
  assert.notEqual(res.kind === 'artifact' && res.artifact && res.artifact.type, 'memory');
});
