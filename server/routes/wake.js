// Wake-word ingress, mirroring presence: the on-device sidecar polls the public
// config (which phrase, on/off) and POSTs /api/wake when it hears the word. Local
// LAN only, no auth — same posture as /api/presence and the kiosk endpoints. The
// parent console reads/writes the config through the password-gated admin routes.
import express from 'express';
import { getWakeConfig, triggerWake } from '../services/wake.js';

export const router = express.Router();

// Public so the sidecar can read which phrase to listen for (and whether to listen).
router.get('/wake/config', (req, res) => res.json(getWakeConfig()));

// Sidecar reports a detection; we broadcast it to the kiosk (no-op when disabled).
router.post('/wake', (req, res) => {
  res.json(triggerWake((req.body || {}).meta || {}));
});

export default router;
