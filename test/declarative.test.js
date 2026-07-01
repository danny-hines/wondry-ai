// Unit tests for the declarative widget kit's normalizer — focused on the security
// boundary for node icons: the model emits structured shapes, and anything outside
// the whitelist (script, event handlers, url()/href, raw markup, bad geometry) must
// be stripped so an icon can only ever DRAW, never execute or fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDoc, collectText } from '../server/content/declarative.js';

const scene = (nodes) =>
  normalizeDoc({ title: 'T', emoji: '🧩', blocks: [{ type: 'scene', layout: 'map', nodes }] });
const iconOf = (doc) => doc.blocks.find((b) => b.type === 'scene').nodes[0].icon;

test('a clean structured icon passes through with only whitelisted fields', () => {
  const doc = scene([
    {
      label: 'Heart',
      emoji: '🫀',
      icon: {
        viewBox: '0 0 24 24',
        shapes: [
          {
            type: 'path',
            d: 'M12 21 C8 17 4 13 4 9 Z',
            fill: 'currentColor',
            stroke: 'red',
            strokeWidth: 2,
            strokeLinecap: 'round',
          },
          { type: 'circle', cx: 12, cy: 8, r: 3, fill: '#ff0000' },
        ],
      },
    },
    { label: 'Bone', emoji: '🦴' },
  ]);
  const icon = iconOf(doc);
  assert.equal(icon.viewBox, '0 0 24 24');
  assert.equal(icon.shapes.length, 2);
  assert.deepEqual(icon.shapes[0], {
    type: 'path',
    d: 'M12 21 C8 17 4 13 4 9 Z',
    fill: 'currentColor',
    stroke: 'red',
    strokeWidth: 2,
    strokeLinecap: 'round',
  });
  assert.deepEqual(icon.shapes[1], { type: 'circle', cx: 12, cy: 8, r: 3, fill: '#ff0000' });
});

test('unknown shape types and unsafe attributes are stripped', () => {
  const doc = scene([
    {
      label: 'X',
      emoji: '⭐',
      icon: {
        viewBox: '0 0 24 24',
        shapes: [
          { type: 'script', d: 'alert(1)' }, // not a real shape → dropped
          { type: 'image', href: 'http://evil/x.png' }, // not whitelisted → dropped
          {
            type: 'rect',
            x: 2,
            y: 2,
            width: 20,
            height: 20,
            onclick: 'steal()',
            href: 'javascript:1',
            style: 'x',
            fill: 'url(http://evil)',
          },
        ],
      },
    },
    { label: 'Y', emoji: '🌟' },
  ]);
  const icon = iconOf(doc);
  // Only the rect survives, and only with whitelisted geometry — no onclick/href/style,
  // and the url() fill was rejected (not a valid color).
  assert.equal(icon.shapes.length, 1);
  const r = icon.shapes[0];
  assert.equal(r.type, 'rect');
  assert.deepEqual(Object.keys(r).sort(), ['height', 'type', 'width', 'x', 'y']);
  assert.equal(r.fill, undefined, 'url() fill rejected');
  assert.equal(r.onclick, undefined);
  assert.equal(r.href, undefined);
  assert.equal(r.style, undefined);
});

test('a path with non-geometry characters is rejected entirely', () => {
  const doc = scene([
    {
      label: 'X',
      emoji: '⭐',
      icon: {
        viewBox: '0 0 24 24',
        shapes: [
          { type: 'path', d: 'M0 0 L10 10"></svg><script>alert(1)</script>' }, // injection attempt
          { type: 'line', x1: 0, y1: 0, x2: 10, y2: 10, stroke: 'currentColor' },
        ],
      },
    },
    { label: 'Y', emoji: '🌟' },
  ]);
  const icon = iconOf(doc);
  assert.equal(icon.shapes.length, 1, 'malicious path dropped, clean line kept');
  assert.equal(icon.shapes[0].type, 'line');
});

test('an icon with no valid shapes is omitted, and bad viewBox falls back', () => {
  const doc = scene([
    { label: 'A', emoji: '⭐', icon: { viewBox: 'evil', shapes: [{ type: 'nope' }] } },
    {
      label: 'B',
      emoji: '🌟',
      icon: { viewBox: '0 0 32 32', shapes: [{ type: 'circle', cx: 16, cy: 16, r: 8 }] },
    },
  ]);
  const nodes = doc.blocks.find((b) => b.type === 'scene').nodes;
  assert.equal(nodes[0].icon, undefined, 'no surviving shapes → no icon');
  assert.equal(nodes[1].icon.viewBox, '0 0 32 32');
});

test('collectText ignores icons (no text to scan there)', () => {
  const doc = scene([
    {
      label: 'Heart',
      emoji: '🫀',
      blurb: 'beats',
      facts: ['fact one'],
      icon: { viewBox: '0 0 24 24', shapes: [{ type: 'circle', cx: 1, cy: 1, r: 1 }] },
    },
    { label: 'Bone', emoji: '🦴', blurb: 'strong' },
  ]);
  const text = collectText(doc);
  assert.match(text, /Heart/);
  assert.match(text, /beats/);
  assert.match(text, /fact one/);
});
