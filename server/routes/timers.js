// Timer endpoints. Timers are device-global (not per child) — the kiosk lists/cancels
// them and the admin console can start one. Voice-set timers go through the
// conversation route (which calls startTimer directly), so this is mostly read +
// parent control.
import express from 'express';
import { startTimer, cancelTimer, listActiveTimers } from '../services/scheduler.js';
import { formatDuration } from '../services/timerParse.js';

export const router = express.Router();

const MAX_MS = 6 * 3600000;   // mirror the parser's cap

router.get('/timers', (req, res) => {
  res.json({ timers: listActiveTimers() });
});

router.post('/timers', (req, res) => {
  const { durationMs, label, createdBy } = req.body || {};
  const ms = Number(durationMs);
  if (!Number.isFinite(ms) || ms < 1000 || ms > MAX_MS) return res.status(400).json({ error: 'durationMs out of range' });
  const timer = startTimer({ durationMs: ms, label: label || null, createdBy: createdBy === 'parent' ? 'parent' : 'voice' });
  res.json({ timer, pretty: formatDuration(ms) });
});

router.post('/timers/:id/cancel', (req, res) => {
  const timer = cancelTimer(req.params.id);
  if (!timer) return res.status(404).json({ error: 'unknown timer' });
  res.json({ timer });
});

export default router;
