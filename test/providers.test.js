// Unit tests for the multi-provider layer: OpenAI request shaping / response
// parsing, usage normalization across the Anthropic + OpenAI shapes, and that a
// key-backed openai provider resolves (or falls back to mock without a key).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.WONDRY_DB = path.join(os.tmpdir(), `wondry-prov-test-${process.pid}.db`);
for (const f of [process.env.WONDRY_DB, process.env.WONDRY_DB + '-wal', process.env.WONDRY_DB + '-shm']) { try { fs.rmSync(f); } catch {} }

const { initSchema, recordUsage, costByArtifact, usageSince } = await import('../server/db.js');
initSchema();
const { openaiBody, parseOpenaiText, usageTokens } = await import('../server/services/providers.js');
const { resolveProviderByName } = await import('../server/config.js');

test('usageTokens normalizes both Anthropic and OpenAI shapes', () => {
  assert.deepEqual(usageTokens({ usage: { input_tokens: 10, output_tokens: 5 } }), { inTok: 10, outTok: 5 });
  assert.deepEqual(usageTokens({ usage: { prompt_tokens: 8, completion_tokens: 3 } }), { inTok: 8, outTok: 3 });
  assert.deepEqual(usageTokens({}), { inTok: 0, outTok: 0 });
});

test('openaiBody prepends system, sets the token param, and includes tools', () => {
  const p = { model: 'gpt-4o', max_tokens: 8000 };
  const b = openaiBody(p, { system: 'You are kind.', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1234 });
  assert.deepEqual(b.messages[0], { role: 'system', content: 'You are kind.' });
  assert.equal(b.messages[1].content, 'hi');
  assert.equal(b.model, 'gpt-4o');
  assert.equal(b.max_tokens, 1234);
  assert.equal(b.max_completion_tokens, undefined);

  const reasoning = openaiBody({ model: 'o-next', max_tokens: 8000, token_param: 'max_completion_tokens' }, { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(reasoning.max_completion_tokens, 8000);
  assert.equal(reasoning.max_tokens, undefined);

  const withTools = openaiBody(p, { messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'f' } }] });
  assert.equal(withTools.tools.length, 1);
});

test('parseOpenaiText pulls the assistant content (empty when missing)', () => {
  assert.equal(parseOpenaiText({ choices: [{ message: { content: 'hello' } }] }), 'hello');
  assert.equal(parseOpenaiText({ choices: [] }), '');
  assert.equal(parseOpenaiText({}), '');
});

test('usage is recorded and summed per artifact (cost attribution)', () => {
  recordUsage({ task: 'artifact', model: 'm', artifactId: 'A1', inputTokens: 1000, outputTokens: 500, costUsd: 0.02 });
  recordUsage({ task: 'plan', model: 'm', artifactId: 'A1', inputTokens: 100, outputTokens: 50, costUsd: 0.001 });
  recordUsage({ task: 'chat', model: 'm', artifactId: null, inputTokens: 10, outputTokens: 5, costUsd: 0.0005 });
  const byArt = costByArtifact(['A1', 'A2']);
  assert.ok(Math.abs(byArt.A1 - 0.021) < 1e-9, 'A1 sums both its calls');
  assert.equal(byArt.A2, undefined, 'no rows for A2');
  const total = usageSince(0);
  assert.equal(total.n, 3);
  assert.ok(total.cost > 0.0214);
});

test('an openai provider resolves with its key, or falls back to mock without one', () => {
  delete process.env.OPENAI_API_KEY;
  const noKey = resolveProviderByName('openai');
  assert.equal(noKey.type, 'mock', 'no key → mock fallback');

  process.env.OPENAI_API_KEY = 'sk-test-123';
  const withKey = resolveProviderByName('openai');
  assert.equal(withKey.type, 'openai');
  assert.equal(withKey._apiKey, 'sk-test-123');
  assert.equal(withKey.model, 'gpt-4o');
  delete process.env.OPENAI_API_KEY;
});
