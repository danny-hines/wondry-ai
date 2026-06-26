// Unit tests for the familiar-faces clustering + identification core, using
// synthetic high-dim embeddings (no camera/hardware). Verifies that samples of the
// same person group together and different people separate, that identification
// matches an enrolled child and rejects unknowns, and that input is sanitized.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.WONDRY_DB = path.join(os.tmpdir(), `wondry-faces-test-${process.pid}.db`);
for (const f of [process.env.WONDRY_DB, process.env.WONDRY_DB + '-wal', process.env.WONDRY_DB + '-shm']) { try { fs.rmSync(f); } catch {} }

const db = await import('../server/db.js');
db.initSchema();
const { bus } = await import('../server/events.js');
const F = await import('../server/services/faces.js');

const DIM = 128;
const randUnit = () => F.normalize(Array.from({ length: DIM }, () => Math.random() - 0.5));
// A noisy sample of a base identity. Components of a 128-d unit vector are ~1/sqrt(128)
// ≈ 0.09, so keep the per-component noise well under that to stay same-person (cosine
// ~0.9, comfortably above the 0.5 cluster threshold).
const noisy = (base, eps = 0.1) => F.normalize(base.map((b) => b + eps * (Math.random() - 0.5)));

const personA = randUnit();
const personB = randUnit();
const profile = (id, name) => db.db.prepare('INSERT INTO profiles (id,name,initials,color,created_at) VALUES (?,?,?,?,?)')
  .run(id, name, name.slice(0, 2).toUpperCase(), '#3b82f6', db.now());

test('vector math: cosine of identical is 1, of distinct high-dim vectors is near 0', () => {
  assert.ok(Math.abs(F.cosine(personA, personA) - 1) < 1e-9);
  assert.ok(Math.abs(F.cosine(personA, personB)) < 0.4, 'two random people are far apart');
});

test('banking groups same person together and separates different people', () => {
  const aIds = Array.from({ length: 8 }, () => F.bankSample({ embedding: noisy(personA), thumb: thumb(), quality: 0.9 }));
  const bIds = Array.from({ length: 8 }, () => F.bankSample({ embedding: noisy(personB), thumb: thumb(), quality: 0.9 }));
  assert.equal(new Set(aIds).size, 1, 'all of person A landed in one cluster');
  assert.equal(new Set(bIds).size, 1, 'all of person B landed in one cluster');
  assert.notEqual(aIds[0], bIds[0], 'A and B are different clusters');
  assert.equal(db.faceClusterCentroids().length, 2, 'exactly two clusters formed');
});

test('identify matches an enrolled child and rejects unknown faces', () => {
  profile('logan', 'Logan');
  // enroll person A's cluster to Logan
  const aCluster = F.bankSample({ embedding: noisy(personA) });   // returns A's cluster id
  db.setFaceClusterProfile(aCluster, 'logan', 'assigned');

  const m = F.identify(noisy(personA));
  assert.ok(m && m.profileId === 'logan', 'a fresh A face identifies as Logan');
  assert.ok(m.confidence >= 0.55);

  assert.equal(F.identify(noisy(personB)), null, 'person B (not enrolled) is unknown');
});

test('observe identifies + emits face.recognized, and only banks thumbed faces', async () => {
  let event = null;
  const onEvt = (e) => { if (e.type === 'face.recognized') event = e; };
  bus.on('event', onEvt);
  const before = db.clusterSampleCount(db.assignedFaceGalleries()[0].clusterId);

  const out = F.observe([
    { embedding: noisy(personA), trackId: 't1' },               // identify-only (no thumb) — not banked
    { embedding: noisy(personB), trackId: 't2', thumb: thumb() }, // banked, unknown
  ]);
  bus.off('event', onEvt);

  assert.ok(out.identified.some((i) => i.profileId === 'logan'), 'Logan identified in frame');
  assert.equal(out.banked, 1, 'only the thumbnailed face was banked');
  assert.equal(db.clusterSampleCount(db.assignedFaceGalleries()[0].clusterId), before, 'identify-only A face was not banked');
  assert.ok(event && event.profileId === 'logan', 'emitted face.recognized for Logan');
});

test('caps samples per cluster', () => {
  const e = noisy(personA);
  const id = F.bankSample({ embedding: e, thumb: thumb() });
  for (let i = 0; i < 40; i++) F.bankSample({ embedding: noisy(personA), thumb: thumb() });
  assert.ok(db.clusterSampleCount(id) <= 30, 'cluster trimmed to maxSamplesPerCluster');
});

test('sanitizes embeddings and thumbnails from the open endpoint', () => {
  assert.equal(F.cleanEmbedding([1, 2]), null, 'too short rejected');
  assert.equal(F.cleanEmbedding(Array(64).fill('x')), null, 'non-numeric rejected');
  assert.ok(F.cleanEmbedding(Array(64).fill(1)), '64 finite numbers accepted');
  const ok = F.cleanEmbedding(Array(64).fill(3));
  assert.ok(Math.abs(F.cosine(ok, ok) - 1) < 1e-9, 'output is L2-normalized');

  assert.equal(F.cleanThumb('data:image/svg+xml;base64,PHN2Zz4='), null, 'SVG thumb rejected');
  assert.equal(F.cleanThumb('data:image/jpeg;base64,' + 'A'.repeat(70000)), null, 'oversized rejected');
  assert.ok(F.cleanThumb('data:image/jpeg;base64,/9j/4AAQ'), 'small jpeg data URI accepted');
});

test('faces_enabled toggle defaults off', () => {
  assert.equal(F.facesEnabled(), false);
  db.setKV('faces_enabled', '1');
  assert.equal(F.facesEnabled(), true);
  db.setKV('faces_enabled', '0');
});

function thumb() { return 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='; }
