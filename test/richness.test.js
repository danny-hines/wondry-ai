// Unit tests for content-richness resolution + the daily on-demand cap. Exercises
// resolveRichness/overCap directly against an isolated DB and config.json's tiers.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.WONDRY_DB = path.join(os.tmpdir(), `wondry-rich-test-${process.pid}.db`);
for (const f of [
  process.env.WONDRY_DB,
  process.env.WONDRY_DB + '-wal',
  process.env.WONDRY_DB + '-shm',
]) {
  try {
    fs.rmSync(f);
  } catch {}
}

const { initSchema, db, setKV, uid, now } = await import('../server/db.js');
initSchema();
const { resolveRichness, overCap, selectedTierId } = await import('../server/services/richness.js');

const reset = () => {
  db.exec('DELETE FROM artifacts');
  setKV('content_richness', 'standard');
  setKV('richness_daily_cap', '0');
};
const addOnDemand = (type = 'page') =>
  db
    .prepare('INSERT INTO artifacts (id,title,source,status,type,created_at) VALUES (?,?,?,?,?,?)')
    .run(uid(), 'x', 'on_demand', 'ready', type, now());

test('defaults to the configured tier with no cap', () => {
  reset();
  assert.equal(selectedTierId(), 'standard');
  const r = resolveRichness({ source: 'on_demand' });
  assert.equal(r.id, 'standard');
  assert.equal(r.degraded, false);
  assert.ok(r.maxTokens > 0 && r.provider);
});

test('the selected global tier is honored', () => {
  reset();
  setKV('content_richness', 'rich');
  assert.equal(selectedTierId(), 'rich');
  assert.equal(resolveRichness({ source: 'on_demand' }).id, 'rich');
});

test('on-demand degrades to the simplest tier past the daily cap — any type counts', () => {
  reset();
  setKV('content_richness', 'rich');
  setKV('richness_daily_cap', '2');
  addOnDemand('page');
  addOnDemand('explorable'); // 2 == cap → not over yet
  assert.equal(overCap({ source: 'on_demand' }), false);
  assert.equal(resolveRichness({ source: 'on_demand' }).id, 'rich');
  addOnDemand('memory'); // 3 > cap → over (and a non-page type counts)
  assert.equal(overCap({ source: 'on_demand' }), true);
  const r = resolveRichness({ source: 'on_demand' });
  assert.equal(r.id, 'simple');
  assert.equal(r.degraded, true);
});

test('parent generations and per-create overrides bypass the cap', () => {
  reset();
  setKV('content_richness', 'rich');
  setKV('richness_daily_cap', '1');
  addOnDemand();
  addOnDemand();
  addOnDemand(); // well over the cap
  assert.equal(overCap({ source: 'parent' }), false);
  assert.equal(resolveRichness({ source: 'parent' }).id, 'rich');
  assert.equal(overCap({ source: 'on_demand', override: 'rich' }), false);
  assert.equal(resolveRichness({ source: 'on_demand', override: 'rich' }).id, 'rich');
});

test('unlimited cap (0) never degrades', () => {
  reset();
  setKV('content_richness', 'rich');
  setKV('richness_daily_cap', '0');
  for (let i = 0; i < 10; i++) addOnDemand();
  assert.equal(overCap({ source: 'on_demand' }), false);
  assert.equal(resolveRichness({ source: 'on_demand' }).id, 'rich');
});
