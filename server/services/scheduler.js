// In-process scheduler for everything that fires at an absolute time: countdown
// timers and wall-clock reminders/alarms. Holds a setTimeout per pending row and,
// when one elapses, marks it fired and emits `schedule.fired` on the shared bus —
// which the websocket layer broadcasts to the kiosk (the same channel artifacts use).
// Rows are persisted with an absolute fire_at, so on boot we re-arm everything still
// pending and immediately fire anything whose deadline passed while we were down.
import {
  createScheduleRow,
  getScheduleRow,
  setScheduleStatus,
  activeSchedules,
  now,
} from '../db.js';
import { formatDuration } from './timerParse.js';
import { formatWhen } from './timezone.js';
import { emit } from '../events.js';

const handles = new Map(); // schedule id -> setTimeout handle

// setTimeout caps at ~24.8 days (2^31-1 ms); chunk longer waits by re-arming so a
// reminder days out still fires (timers are short; reminders can be far off).
const MAX_DELAY = 2 ** 31 - 1;

// Public shape sent to clients: snake_case row + friendly derived fields.
export function publicSchedule(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    message: row.message,
    duration_ms: row.duration_ms,
    fire_at: row.fire_at,
    recurrence: row.recurrence,
    status: row.status,
    created_by: row.created_by,
    pretty: row.duration_ms != null ? formatDuration(row.duration_ms) : null, // timers
    when: formatWhen(row.fire_at), // reminders/alarms
  };
}

function fire(id) {
  handles.delete(id);
  const row = getScheduleRow(id);
  if (!row || row.status !== 'pending') return; // cancelled/fired meanwhile
  // One-time (recurrence == null) for now: mark fired. Recurring will recompute the
  // next occurrence here and re-arm instead — the rescheduleRow hook is ready for it.
  const fired = setScheduleStatus(id, 'fired', now());
  emit('schedule.fired', { schedule: publicSchedule(fired) });
}

function arm(row) {
  if (handles.has(row.id)) return;
  const delay = Math.min(MAX_DELAY, Math.max(0, row.fire_at - now()));
  // For far-future reminders past the setTimeout ceiling, re-arm in chunks.
  if (row.fire_at - now() > MAX_DELAY) {
    handles.set(
      row.id,
      setTimeout(() => {
        handles.delete(row.id);
        arm(getScheduleRow(row.id) || row);
      }, MAX_DELAY),
    );
    return;
  }
  handles.set(
    row.id,
    setTimeout(() => fire(row.id), delay),
  );
}

// Create + arm a countdown timer. durationMs is relative to now; fire_at derived here.
export function startTimer({ durationMs, label = null, createdBy = 'voice' }) {
  const row = createScheduleRow({
    kind: 'timer',
    label,
    durationMs,
    fireAt: now() + durationMs,
    createdBy,
  });
  arm(row);
  emit('schedule.created', { schedule: publicSchedule(row) });
  return publicSchedule(row);
}

// Create + arm a wall-clock reminder/alarm. fireAt is an absolute epoch (the caller
// converts wall-clock → epoch via the timezone util). message is spoken when it fires.
export function startReminder({
  fireAt,
  message = null,
  label = null,
  recurrence = null,
  createdBy = 'parent',
}) {
  const row = createScheduleRow({
    kind: 'reminder',
    message,
    label,
    fireAt,
    recurrence,
    createdBy,
  });
  arm(row);
  emit('schedule.created', { schedule: publicSchedule(row) });
  return publicSchedule(row);
}

export function cancelSchedule(id) {
  const h = handles.get(id);
  if (h) {
    clearTimeout(h);
    handles.delete(id);
  }
  const row = getScheduleRow(id);
  if (!row || row.status !== 'pending') return publicSchedule(row);
  const cancelled = setScheduleStatus(id, 'cancelled');
  emit('schedule.cancelled', { schedule: publicSchedule(cancelled) });
  return publicSchedule(cancelled);
}

export function listActiveSchedules() {
  return activeSchedules().map(publicSchedule);
}
// Kiosk countdown chips show timers only (reminders are hours/days out).
export function listActiveTimers() {
  return activeSchedules()
    .filter((r) => r.kind === 'timer')
    .map(publicSchedule);
}

// Boot: re-arm survivors. Anything already past due fires on the next tick (a short
// stagger so a pile of missed items doesn't announce all in the same frame).
export function initScheduler() {
  const rows = activeSchedules();
  let overdue = 0;
  for (const row of rows) {
    if (row.fire_at <= now()) {
      const at = ++overdue;
      handles.set(
        row.id,
        setTimeout(() => fire(row.id), 250 * at),
      );
    } else {
      arm(row);
    }
  }
  if (rows.length)
    console.log(
      `  Schedules: re-armed ${rows.length} pending${overdue ? ` (${overdue} overdue, firing now)` : ''}`,
    );
}
