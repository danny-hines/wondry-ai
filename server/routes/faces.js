// Face-observation ingress: the on-device vision sidecar POSTs detected faces here
// (embedding + optional thumbnail + trackId + quality). Local-LAN only, no auth —
// same trust model as /api/presence (the sidecar runs on the device). Everything is
// gated by the `faces_enabled` parent toggle, so it no-ops until turned on.
//
// Sidecar contract — POST /api/faces/observe:
//   { "faces": [ { "embedding": [512 floats], "thumb"?: "data:image/jpeg;base64,…",
//                  "trackId"?: "t7", "quality"?: 0.0-1.0 } ] }
// Send `thumb` only occasionally (e.g. once every few seconds per track) — a thumb
// means "bank this for enrollment"; embeddings without a thumb are identify-only.
import express from 'express';
import { facesEnabled, observe } from '../services/faces.js';

export const router = express.Router();

router.post('/faces/observe', (req, res) => {
  if (!facesEnabled()) return res.json({ ok: true, enabled: false });
  const { banked, identified } = observe((req.body || {}).faces);
  res.json({ ok: true, enabled: true, banked, identified });
});

export default router;
