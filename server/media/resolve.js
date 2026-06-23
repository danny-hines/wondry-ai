// Generation-time media baking. A declarative doc may contain image blocks that
// only DESCRIBE the image they want ({type:'image', query, alt}). Here we resolve
// each query through the enabled trusted sources, cache the bytes locally, and
// rewrite the block to a local mediaId + attribution. Unresolved images are
// dropped (they're supplementary — content stays valid without them).
import { getConfig } from '../config.js';
import { getMedia } from '../db.js';
import { getSource, allSources } from './registry.js';
import { saveMedia } from './store.js';
import './index.js'; // register sources

function imagesCfg(override) { return override || (getConfig().media && getConfig().media.images) || {}; }
function enabledSourceIds(cfg) {
  if (cfg.sources && cfg.sources.length) return cfg.sources;
  return allSources().map((s) => s.id);
}

// Resolve one description to a cached local image (or null). Tries sources in order.
export async function resolveImage(query, override) {
  const cfg = imagesCfg(override);
  if (cfg.enabled === false || !query) return null;
  for (const id of enabledSourceIds(cfg)) {
    const src = getSource(id);
    if (!src) continue;
    try {
      const r = await src.resolve(query, { maxBytes: cfg.maxBytes || 3_000_000 });
      if (!r) continue;
      const mediaId = saveMedia({ source: id, query, bytes: r.bytes, mime: r.mime, ext: r.ext, alt: query, credit: r.credit, license: r.license, sourceUrl: r.sourceUrl });
      return { mediaId, credit: r.credit, alt: query };
    } catch { /* try next source */ }
  }
  return null;
}

// Walk a declarative doc, baking image blocks. Caps the number of images per
// artifact (config) and drops requests that don't resolve.
export async function resolveDocImages(doc, override) {
  const cfg = imagesCfg(override);
  const disabled = cfg.enabled === false;
  const max = cfg.maxPerArtifact || 3;
  const out = [];
  let used = 0;
  for (const b of (doc.blocks || [])) {
    if (b.type !== 'image') { out.push(b); continue; }
    if (disabled || used >= max) continue; // drop image requests we won't fulfill
    const res = await resolveImage(b.query, cfg);
    if (res) { out.push({ ...b, mediaId: res.mediaId, credit: res.credit, alt: b.alt || res.alt }); used++; }
    // else: drop the unresolved image block
  }
  doc.blocks = out;
  return doc;
}

// Capability blurbs for the generation prompt, so the model requests images the
// enabled sources can actually provide. Empty string when images are off.
export function imageSourceHints(override) {
  const cfg = imagesCfg(override);
  if (cfg.enabled === false) return '';
  const hints = enabledSourceIds(cfg).map((id) => getSource(id)).filter(Boolean).map((s) => `- ${s.label}: ${s.capabilities}`);
  return hints.join('\n');
}

// Agentic generation: a find_image TOOL the model can call mid-generation. It
// bakes the image immediately and returns a mediaId the model embeds directly,
// so it can decide per-image whether one was actually found. Same source adapters
// as the post-pass — no duplication. Gated by config media.images.agentic.
export function mediaAgenticEnabled(override) {
  const cfg = imagesCfg(override);
  return cfg.enabled !== false && cfg.agentic === true;
}
export function imageTool() {
  return {
    name: 'find_image',
    description: 'Find one real, kid-appropriate photo illustrating a concept, from trusted sources. Call this BEFORE adding any image. Returns {available, mediaId, credit}. Only add an {"type":"image","mediaId":"<the id>","alt":"..."} block when available is true.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'short description of the photo to find, e.g. "a red panda in a tree"' } }, required: ['query'] },
    handler: async ({ query }) => {
      const r = await resolveImage(query);
      return r ? { available: true, mediaId: r.mediaId, credit: r.credit } : { available: false };
    },
  };
}

// Drop image blocks whose mediaId the model invented (must match a real baked row).
export function validateDocMedia(doc) {
  doc.blocks = (doc.blocks || []).filter((b) => b.type !== 'image' || (b.mediaId && getMedia(b.mediaId)));
  return doc;
}
