// Schedule endpoints: countdown timers + wall-clock reminders/alarms. Everything is
// device-global (not per child). The kiosk lists/cancels timers (for its countdown
// chips); the admin console lists all schedules and creates timers/reminders. Voice
// goes through the conversation route (which calls the scheduler directly), so this
// is mostly read + parent control.
import express from 'express';
import {
  startTimer,
  startReminder,
  cancelSchedule,
  listActiveTimers,
  listActiveSchedules,
} from '../services/scheduler.js';
import { formatDuration } from '../services/timerParse.js';
import { localInputToEpoch, getTimezone } from '../services/timezone.js';

export const router = express.Router();

const MAX_TIMER_MS = 6 * 3600000; // mirror the parser's cap

// Kiosk: just the countdown timers (reminders are hours/days out, not shown as chips).
router.get('/timers', (req, res) => {
  res.json({ timers: listActiveTimers() });
});
// Console: every active schedule (timers + reminders), soonest first.
router.get('/schedules', (req, res) => {
  res.json({ schedules: listActiveSchedules() });
});

router.post('/timers', (req, res) => {
  const { durationMs, label, createdBy } = req.body || {};
  const ms = Number(durationMs);
  if (!Number.isFinite(ms) || ms < 1000 || ms > MAX_TIMER_MS)
    return res.status(400).json({ error: 'durationMs out of range' });
  const timer = startTimer({
    durationMs: ms,
    label: label || null,
    createdBy: createdBy === 'parent' ? 'parent' : 'voice',
  });
  res.json({ schedule: timer, pretty: formatDuration(ms) });
});

// Reminder/alarm at a wall-clock time. The client sends a datetime-local value
// ("YYYY-MM-DDTHH:mm"); we interpret it in the configured timezone → absolute epoch.
router.post('/reminders', (req, res) => {
  const { atLocal, message, label, createdBy } = req.body || {};
  const fireAt = localInputToEpoch(atLocal, getTimezone());
  if (fireAt == null) return res.status(400).json({ error: 'atLocal must be YYYY-MM-DDTHH:mm' });
  if (fireAt < Date.now() - 60000)
    return res.status(400).json({ error: 'that time is in the past' });
  const reminder = startReminder({
    fireAt,
    message: message || null,
    label: label || null,
    createdBy: createdBy === 'voice' ? 'voice' : 'parent',
  });
  res.json({ schedule: reminder });
});

router.post('/schedules/:id/cancel', (req, res) => {
  const schedule = cancelSchedule(req.params.id);
  if (!schedule) return res.status(404).json({ error: 'unknown schedule' });
  res.json({ schedule });
});

export default router;
