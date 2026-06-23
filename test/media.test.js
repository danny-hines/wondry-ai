// Unit tests for the media-baking pass — offline, using a fake source (no network).
// Verifies that image blocks get resolved to a cached local mediaId, that the cap
// and disabled-state drop image blocks, and that the cached file is retrievable.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Isolate the DB before importing modules that open it.
process.env.WONDRY_DB = path.join(os.tmpdir(), `wondry-media-test-${process.pid}.db`);
for (const f of [process.env.WONDRY_DB, process.env.WONDRY_DB + '-wal', process.env.WONDRY_DB + '-shm']) { try { fs.rmSync(f); } catch {} }

const { initSchema, getMedia } = await import('../server/db.js');
initSchema();
const { registerSource } = await import('../server/media/registry.js');
const { resolveDocImages, resolveImage } = await import('../server/media/resolve.js');
const { mediaFile } = await import('../server/media/store.js');

// A 1x1 PNG, served by a fake source for any query (no network).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
registerSource({
  id: 'fake', label: 'Fake', capabilities: 'test images',
  async resolve(query) { return { bytes: new Uint8Array(PNG), mime: 'image/png', ext: 'png', credit: 'Test Source', license: 'CC0', sourceUrl: 'http://example.test/' + query }; },
});
const CFG = { enabled: true, sources: ['fake'], maxBytes: 1_000_000, maxPerArtifact: 2 };

test('resolveImage caches bytes and returns a retrievable mediaId', async () => {
  const r = await resolveImage('a red panda', CFG);
  assert.ok(r && r.mediaId, 'got a mediaId');
  assert.match(r.credit, /Test Source/);
  const m = mediaFile(r.mediaId);
  assert.ok(m && fs.existsSync(m.path), 'cached file exists');
  assert.equal(getMedia(r.mediaId).mime, 'image/png');
});

test('resolveDocImages bakes image blocks and respects the per-artifact cap', async () => {
  const doc = { blocks: [
    { type: 'text', text: 'hi' },
    { type: 'image', query: 'a tiger', alt: 'tiger' },
    { type: 'image', query: 'a lion', alt: 'lion' },
    { type: 'image', query: 'a bear', alt: 'bear' },   // 3rd exceeds cap (2) -> dropped
  ] };
  await resolveDocImages(doc, CFG);
  const imgs = doc.blocks.filter((b) => b.type === 'image');
  assert.equal(imgs.length, 2, 'capped at maxPerArtifact');
  assert.ok(imgs.every((b) => b.mediaId && b.credit), 'baked with mediaId + credit');
  assert.equal(doc.blocks[0].type, 'text', 'non-image blocks preserved');
});

test('disabled media drops image blocks entirely', async () => {
  const doc = { blocks: [{ type: 'text', text: 'hi' }, { type: 'image', query: 'x', alt: 'x' }] };
  await resolveDocImages(doc, { enabled: false });
  assert.equal(doc.blocks.filter((b) => b.type === 'image').length, 0);
  assert.equal(doc.blocks.length, 1);
});
