// Audio keepalive config + live tuning. The kiosk fetches the params on boot and
// applies them; `wondry audio` (over SSH) or the parent console POSTs new values, which we persist
// and broadcast over the websocket so the kiosk retunes the inaudible keepalive tone
// live — no reload. /audio/test fires a sharp test sound on the kiosk so you can hear
// whether the start clips while tuning. See client/src/kiosk/audio.ts for the why.
import express from 'express';
import { getKV, setKV } from '../db.js';
import { emit } from '../events.js';

export const router = express.Router();

// Default OFF (warmHz 0) — enabled/tuned per device (via `wondry audio` or the console)
// where clipping occurs, so dev stays silent and there's a single source of truth.
function audioConfig() {
  return {
    warmHz: parseFloat(getKV('warm_hz', '0')) || 0,
    warmGain: parseFloat(getKV('warm_gain', '0.02')) || 0,
  };
}

router.get('/audio', (req, res) => res.json(audioConfig()));

router.post('/audio', (req, res) => {
  const { warmHz, warmGain } = req.body || {};
  if (Number.isFinite(warmHz)) setKV('warm_hz', String(Math.max(0, warmHz)));
  if (Number.isFinite(warmGain)) setKV('warm_gain', String(Math.max(0, Math.min(1, warmGain))));
  const cfg = audioConfig();
  emit('audio', cfg); // kiosks retune live
  res.json(cfg);
});

// Fire a test sound on connected kiosks (to listen for clipping while tuning).
router.post('/audio/test', (req, res) => {
  emit('audio.test', {});
  res.json({ ok: true });
});

export default router;
