// In-process timer scheduler. Holds a setTimeout per pending timer and, when one
// elapses, marks it fired and emits `timer.fired` on the shared bus — which the
// websocket layer broadcasts to the kiosk (the same channel artifacts use). Timers
// are persisted (fire_at is absolute), so on boot we re-arm everything still
// pending and immediately fire anything whose deadline passed while we were down.
import { createTimerRow, getTimerRow, setTimerStatus, activeTimers, now } from '../db.js';
import { formatDuration } from './timerParse.js';
import { emit } from '../events.js';

const handles = new Map();   // timer id -> setTimeout handle

// setTimeout caps at ~24.8 days (2^31-1 ms); timers are short, but clamp to be safe.
const MAX_DELAY = 2 ** 31 - 1;

// Public shape sent to clients: snake_case row + a friendly duration string.
export function publicTimer(row) {
  if (!row) return null;
  return {
    id: row.id, label: row.label,
    duration_ms: row.duration_ms, fire_at: row.fire_at, status: row.status,
    created_by: row.created_by, pretty: formatDuration(row.duration_ms),
  };
}

function fire(id) {
  handles.delete(id);
  const row = getTimerRow(id);
  if (!row || row.status !== 'pending') return;   // cancelled/fired meanwhile
  const fired = setTimerStatus(id, 'fired', now());
  emit('timer.fired', { timer: publicTimer(fired) });
}

function arm(row) {
  if (handles.has(row.id)) return;
  const delay = Math.max(0, Math.min(MAX_DELAY, row.fire_at - now()));
  handles.set(row.id, setTimeout(() => fire(row.id), delay));
}

// Create + arm a timer. durationMs is relative to now; fire_at is derived here so
// the DB row is the single source of truth for when it goes off.
export function startTimer({ durationMs, label = null, createdBy = 'voice' }) {
  const row = createTimerRow({ label, durationMs, fireAt: now() + durationMs, createdBy });
  arm(row);
  emit('timer.created', { timer: publicTimer(row) });
  return publicTimer(row);
}

export function cancelTimer(id) {
  const h = handles.get(id);
  if (h) { clearTimeout(h); handles.delete(id); }
  const row = getTimerRow(id);
  if (!row || row.status !== 'pending') return publicTimer(row);
  const cancelled = setTimerStatus(id, 'cancelled');
  emit('timer.cancelled', { timer: publicTimer(cancelled) });
  return publicTimer(cancelled);
}

export function listActiveTimers() {
  return activeTimers().map(publicTimer);
}

// Boot: re-arm survivors. Anything already past due fires on the next tick (a short
// stagger so a pile of missed timers doesn't announce all in the same frame).
export function initScheduler() {
  const rows = activeTimers();
  let overdue = 0;
  for (const row of rows) {
    if (row.fire_at <= now()) {
      const at = ++overdue;
      handles.set(row.id, setTimeout(() => fire(row.id), 250 * at));
    } else {
      arm(row);
    }
  }
  if (rows.length) console.log(`  Timers: re-armed ${rows.length} pending${overdue ? ` (${overdue} overdue, firing now)` : ''}`);
}
