// Tests for the eval harness's pure pieces: the generalized DB helpers (insert /
// latest-per-target worst-first listing / per-kind summary, across page & chat kinds)
// and the judge's content extraction. The judge/vision calls need a live model and a
// browser, so they're not exercised here.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.WONDRY_DB = path.join(os.tmpdir(), `wondry-eval-test-${process.pid}.db`);
for (const f of [
  process.env.WONDRY_DB,
  process.env.WONDRY_DB + '-wal',
  process.env.WONDRY_DB + '-shm',
]) {
  try {
    fs.rmSync(f);
  } catch {}
}

const {
  initSchema,
  db,
  insertEval,
  listEvals,
  evalSummary,
  evaluatedTargetIds,
  recentAvatarReplies,
} = await import('../server/db.js');
initSchema();
const { extractContent } = await import('../server/services/evalJudge.js');
const { artifactPath, contentPath } = await import('../server/services/generator.js');

test('insert + latest-per-target listing, worst-first', () => {
  insertEval({
    kind: 'page',
    targetId: 'a1',
    label: 'volcanoes',
    scores: { accuracy: 5, age_fit: 4, engagement: 4, clarity: 5 },
    overall: 4.5,
    verdict: 'solid',
    issues: [],
  });
  insertEval({
    kind: 'page',
    targetId: 'a2',
    label: 'sharks',
    scores: { accuracy: 3, age_fit: 2, engagement: 2, clarity: 2 },
    overall: 2,
    verdict: 'weak',
    issues: ['dry', 'wall of text'],
  });
  insertEval({
    kind: 'page',
    targetId: 'a1',
    label: 'volcanoes',
    scores: { accuracy: 3, age_fit: 3, engagement: 3, clarity: 3 },
    overall: 3,
    verdict: 'regressed',
    issues: [],
  });

  const list = listEvals('page');
  assert.equal(list.length, 2); // one row per target (latest)
  assert.equal(list[0].target_id, 'a2'); // worst overall first
  assert.deepEqual(list[0].issues, ['dry', 'wall of text']);
  assert.equal(list[0].scores.engagement, 2);
  assert.equal(list.find((e) => e.target_id === 'a1').verdict, 'regressed'); // latest, not first
});

test('per-kind summary averages the latest eval per target', () => {
  const s = evalSummary('page');
  assert.equal(s.n, 2);
  assert.equal(s.overall, (3 + 2) / 2); // a1 latest (3) + a2 (2)
  assert.equal(s.dims.accuracy, (3 + 3) / 2); // a1 latest (3) + a2 (3)
});

test('evaluatedTargetIds is per-kind', () => {
  assert.deepEqual([...evaluatedTargetIds('page')].sort(), ['a1', 'a2']);
  assert.equal(evaluatedTargetIds('chat').size, 0);
});

test('chat evals carry prompt + response and their own dimensions', () => {
  insertEval({
    kind: 'chat',
    targetId: 'q0',
    label: 'why is the sky blue?',
    prompt: 'why is the sky blue?',
    response: 'Because sunlight scatters!',
    scores: { accuracy: 5, age_fit: 5, helpfulness: 4, tone: 5 },
    overall: 4.5,
  });
  const list = listEvals('chat');
  assert.equal(list.length, 1);
  assert.ok(list[0].response.includes('scatters'));
  assert.equal(list[0].scores.helpfulness, 4);
  assert.equal(evalSummary('chat').dims.tone, 5);
});

test('score clamp keeps values in 1..5', () => {
  insertEval({
    kind: 'page',
    targetId: 'a3',
    scores: { accuracy: 0, age_fit: 3, engagement: 3, clarity: 3 },
    overall: 9,
  });
  const row = db.prepare("SELECT overall, scores FROM evals WHERE target_id='a3'").get();
  assert.equal(row.overall, 5); // clamped down
  assert.equal(JSON.parse(row.scores).accuracy, 1); // clamped up
});

test('safety flag persists into the summary', () => {
  insertEval({
    kind: 'page',
    targetId: 'a4',
    scores: { accuracy: 3 },
    overall: 3,
    safety_ok: false,
  });
  assert.ok(evalSummary('page').safetyConcerns >= 1);
});

test('recentAvatarReplies pairs replies with the preceding kid turn and honors the cutoff', () => {
  db.prepare(
    "INSERT INTO profiles (id,name,initials,color,created_at) VALUES ('p','Kid','K','#fff',1)",
  ).run();
  db.prepare(
    "INSERT INTO conversations (id,profile_id,started_at,last_activity) VALUES ('c','p',1,1)",
  ).run();
  const m = (id, role, kind, text, ts) =>
    db
      .prepare(
        'INSERT INTO messages (id,conversation_id,profile_id,role,kind,text,safety_flag,created_at) VALUES (?,?,?,?,?,?,0,?)',
      )
      .run(id, 'c', 'p', role, kind, text, ts);
  m('k1', 'kid', 'text', 'why is the sky blue?', 100);
  m('a1', 'avatar', 'text', 'Because sunlight scatters!', 110);
  m('k2', 'kid', 'text', 'tell me a joke', 200);
  m('a2', 'avatar', 'text', 'Why did the chicken cross the road?', 210);
  m('a3', 'avatar', 'artifact', 'I made you a page!', 150); // not a chat reply → excluded

  const all = recentAvatarReplies(0, 100);
  assert.equal(all.length, 2); // a1 + a2; the artifact is skipped
  assert.equal(all.find((r) => r.id === 'a1').prompt, 'why is the sky blue?');
  assert.equal(all.find((r) => r.id === 'a2').prompt, 'tell me a joke');

  const recent = recentAvatarReplies(150, 100); // cutoff between the two
  assert.equal(recent.length, 1);
  assert.equal(recent[0].id, 'a2'); // only the reply after the cutoff
});

test('extractContent: HTML page strips <style>, keeps text + script', () => {
  fs.writeFileSync(
    artifactPath('a1'),
    '<html><head><style>.x{color:red}</style></head><body><h1>Volcanoes</h1><script>const lava=1</script></body></html>',
  );
  const c = extractContent({ id: 'a1', type: 'page' });
  assert.equal(c.kind, 'interactive HTML page');
  assert.ok(c.text.includes('Volcanoes'));
  assert.ok(c.text.includes('const lava'));
  assert.ok(!c.text.includes('color:red'));
  fs.rmSync(artifactPath('a1'));
});

test('extractContent: structured type returns pretty JSON; missing → null', () => {
  fs.writeFileSync(
    contentPath('a2'),
    JSON.stringify({ title: 'Sharks', pages: [{ lines: ['Sharks swim.'] }] }),
  );
  const c = extractContent({ id: 'a2', type: 'reading' });
  assert.ok(c.kind.includes('reading'));
  assert.ok(c.text.includes('Sharks swim.'));
  fs.rmSync(contentPath('a2'));
  assert.equal(extractContent({ id: 'nope', type: 'page' }), null);
});
