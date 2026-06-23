// Presence ingress: the Pi's person-detection sidecar (or a manual test POST) tells
// the device when someone is in front of it, so the avatar can greet on approach.
// Local-LAN only by design — there's no auth here, same as the kiosk endpoints.
import express from 'express';
import { setPresence, getPresence } from '../services/presence.js';

export const router = express.Router();

router.get('/presence', (req, res) => res.json(getPresence()));

router.post('/presence', (req, res) => {
  const state = (req.body || {}).state;
  if (state !== 'present' && state !== 'absent') {
    return res.status(400).json({ error: "state must be 'present' or 'absent'" });
  }
  res.json(setPresence(state, (req.body || {}).meta || {}));
});

export default router;
