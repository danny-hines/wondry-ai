// "Familiar faces": on-device face clustering + identification for auto child-
// profile switching. A vision sidecar (Hailo on the Pi) detects faces, computes
// 512-d ArcFace embeddings, and POSTs them to /api/faces/observe. Here we:
//   - IDENTIFY each face against the enrolled galleries (clusters a parent mapped
//     to a child) and emit `face.recognized` so the kiosk can switch profile.
//   - BANK thumbnailed samples into clusters (online leader clustering) so the
//     parent console can group look-alike faces and assign each to a child.
// All on-device, off by default (the `faces_enabled` KV toggle gates everything).
// Embeddings never leave the device; we store the vector + a tiny thumbnail.
import { getConfig } from '../config.js';
import {
  getKV, createFaceCluster, updateFaceClusterCentroid, insertFaceSample,
  faceClusterCentroids, assignedFaceGalleries, clusterSampleCount, trimClusterSamples,
} from '../db.js';
import { emit } from '../events.js';

export function facesEnabled() { return getKV('faces_enabled', '0') === '1'; }
function cfg() { return getConfig().faces || {}; }
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

// --- pure vector math (exported for tests) ---
export function normalize(v) {
  let s = 0; for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  return v.map((x) => x / s);
}
// Cosine similarity of two L2-normalized vectors == dot product.
export function cosine(a, b) {
  let s = 0; const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
// Nearest cluster centroid to an embedding. Returns { best, sim }.
export function nearest(embedding, centroids) {
  let best = null, sim = -2;
  for (const c of centroids) { const s = cosine(embedding, c.centroid); if (s > sim) { sim = s; best = c; } }
  return { best, sim };
}

// Validate + L2-normalize an incoming embedding. Rejects junk from the unauthenticated
// endpoint: must be 16..2048 finite numbers. Returns the normalized vector or null.
export function cleanEmbedding(v) {
  if (!Array.isArray(v) || v.length < 16 || v.length > 2048) return null;
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) { const n = Number(v[i]); if (!Number.isFinite(n)) return null; out[i] = n; }
  return normalize(out);
}
// Only accept small raster data-URI thumbnails (no SVG → no script vector).
export function cleanThumb(t) {
  if (typeof t !== 'string') return null;
  if (t.length > 60000) return null;
  return /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(t) ? t : null;
}

// Bank one sample: online-cluster it (join the nearest cluster within threshold, else
// start a new one), update that cluster's centroid (running mean direction), store the
// sample, and cap the cluster. Returns the cluster id (or null on bad input).
export function bankSample({ embedding, thumb, quality = 0 }) {
  const e = cleanEmbedding(embedding); if (!e) return null;
  const th = num(cfg().clusterThreshold, 0.5);
  const { best, sim } = nearest(e, faceClusterCentroids());
  let clusterId;
  if (best && sim >= th) {
    clusterId = best.id;
    const n = best.n + 1;
    // running mean direction: treat the stored centroid as n unit vectors, add e, renormalize.
    const merged = best.centroid.map((c, i) => c * best.n + (e[i] || 0));
    updateFaceClusterCentroid(clusterId, normalize(merged), n);
  } else {
    clusterId = createFaceCluster(e);
  }
  insertFaceSample({ clusterId, embedding: e, thumb: cleanThumb(thumb), quality: num(quality, 0) });
  const max = num(cfg().maxSamplesPerCluster, 30);
  if (clusterSampleCount(clusterId) > max) trimClusterSamples(clusterId, max);
  return clusterId;
}

// Identify an embedding against enrolled galleries. Returns the best match above the
// (stricter) match threshold, or null for unknown.
export function identify(embedding) {
  const e = cleanEmbedding(embedding); if (!e) return null;
  const th = num(cfg().matchThreshold, 0.55);
  let best = null, sim = -2;
  for (const g of assignedFaceGalleries()) { const s = cosine(e, g.centroid); if (s > sim) { sim = s; best = g; } }
  return best && sim >= th ? { profileId: best.profileId, confidence: sim, clusterId: best.clusterId } : null;
}

// Handle one frame of observed faces from the sidecar. Identifies every face, banks
// the thumbnailed ones for the enrollment UI, and emits the best known identity so
// the kiosk can switch from idle. Returns a small summary.
export function observe(faces) {
  const list = Array.isArray(faces) ? faces.slice(0, 8) : [];
  let banked = 0;
  const identified = [];
  for (const f of list) {
    const m = identify(f.embedding);
    if (m) identified.push({ trackId: f.trackId ?? null, ...m });
    if (f.thumb) { if (bankSample(f)) banked++; }   // thumb present == sidecar wants it banked (throttled there)
  }
  const best = identified.sort((a, b) => b.confidence - a.confidence)[0];
  if (best) emit('face.recognized', { profileId: best.profileId, confidence: best.confidence, trackId: best.trackId });
  return { banked, identified };
}
