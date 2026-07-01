import { useEffect, useRef, useState } from 'react';
import { useAdmin } from '../AdminContext';
import { getSchedules, createTimer, createReminder, cancelSchedule } from '../../lib/api';
import type { AdminConfig, ScheduleItem } from '../../lib/types';

// Device-global scheduling: countdown timers + wall-clock reminders/alarms (a shared
// kiosk, not per child). Manages the timezone the wall-clock times are read in, shows
// the live server clock so a skewed OS clock is visible, and lists/cancels everything
// — including items set on the kiosk by voice.
export function Scheduling() {
  const api = useAdmin();
  const [cfg, setCfg] = useState<AdminConfig | null>(null);
  const [tz, setTz] = useState('');
  const [tzSaved, setTzSaved] = useState(false);
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const clockBase = useRef<{ server: number; at: number } | null>(null);
  // Timer + reminder drafts.
  const [mins, setMins] = useState('');
  const [timerLabel, setTimerLabel] = useState('');
  const [remAt, setRemAt] = useState('');
  const [remMsg, setRemMsg] = useState('');
  const [remErr, setRemErr] = useState('');

  const loadCfg = () =>
    api
      .config()
      .then((c) => {
        setCfg(c);
        setTz(c.timezone);
        clockBase.current = { server: c.serverTime, at: Date.now() };
      })
      .catch(() => {});
  const loadSch = () =>
    getSchedules()
      .then((r) => setSchedules(r.schedules))
      .catch(() => {});
  useEffect(() => {
    loadCfg();
    loadSch();
    const reload = setInterval(loadSch, 5000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(reload);
      clearInterval(tick);
    };
  }, [api]);

  // Live server clock = the server time we fetched + elapsed wall time since.
  const serverNow = clockBase.current
    ? clockBase.current.server + (now - clockBase.current.at)
    : now;
  const serverClock = (() => {
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: tz || undefined,
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      }).format(new Date(serverNow));
    } catch {
      return new Date(serverNow).toLocaleTimeString();
    }
  })();
  const countdown = (ms: number) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60),
      ss = s % 60;
    return h
      ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
      : `${m}:${String(ss).padStart(2, '0')}`;
  };

  const saveTz = async (z: string) => {
    setTz(z);
    await api.saveConfig({ timezone: z });
    setTzSaved(true);
    setTimeout(() => setTzSaved(false), 2000);
    loadCfg();
    loadSch();
  };
  const addTimer = async (minutes: number, label?: string) => {
    const ms = Math.round(minutes * 60000);
    if (!Number.isFinite(ms) || ms < 1000) return;
    await createTimer(ms, label?.trim() || null, 'parent');
    setMins('');
    setTimerLabel('');
    loadSch();
  };
  const addReminder = async () => {
    setRemErr('');
    if (!remAt) return;
    try {
      const r = await createReminder(remAt, remMsg.trim() || null);
      if (r?.error) {
        setRemErr(r.error);
        return;
      }
    } catch {
      setRemErr('Could not set reminder.');
      return;
    }
    setRemAt('');
    setRemMsg('');
    loadSch();
  };
  const cancel = async (id: string) => {
    await cancelSchedule(id);
    loadSch();
  };

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label>Timezone (wall-clock times are read in this zone)</label>
            <select
              value={tz}
              onChange={(e) => saveTz(e.target.value)}
              style={{ width: '100%', maxWidth: 360 }}
            >
              {cfg?.timezones?.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
            <div className="muted" style={{ marginTop: 4 }}>
              Detected on device: {cfg?.detectedTimezone || '…'}
              {tzSaved && <span style={{ color: '#16a34a' }}> · saved</span>}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <label>Server clock</label>
            <div
              style={{ fontSize: '1.15rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
            >
              {serverClock}
            </div>
            <div className="muted">If this is wrong, the kiosk's clock needs syncing (NTP).</div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong style={{ fontSize: '1.05rem' }}>New timer</strong>
          <div className="row" style={{ gap: 6 }}>
            {[5, 10, 15, 30].map((m) => (
              <button key={m} className="act sec" onClick={() => addTimer(m)}>
                {m} min
              </button>
            ))}
          </div>
        </div>
        <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
          <div>
            <label>Minutes</label>
            <input
              type="number"
              min="1"
              value={mins}
              onChange={(e) => setMins(e.target.value)}
              style={{ width: 90 }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <label>Label (optional)</label>
            <input
              value={timerLabel}
              onChange={(e) => setTimerLabel(e.target.value)}
              placeholder="clean up toys"
              style={{ width: '100%' }}
            />
          </div>
          <button
            className="act"
            disabled={!(Number(mins) > 0)}
            onClick={() => addTimer(Number(mins), timerLabel)}
          >
            Start timer
          </button>
        </div>
      </div>

      <div className="card">
        <strong style={{ fontSize: '1.05rem' }}>
          New reminder / alarm{' '}
          <span className="muted" style={{ fontWeight: 400 }}>
            · one-time
          </span>
        </strong>
        <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
          <div>
            <label>When</label>
            <input type="datetime-local" value={remAt} onChange={(e) => setRemAt(e.target.value)} />
          </div>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label>Message (optional — spoken aloud)</label>
            <input
              value={remMsg}
              onChange={(e) => setRemMsg(e.target.value)}
              placeholder="brush your teeth"
              style={{ width: '100%' }}
            />
          </div>
          <button className="act" disabled={!remAt} onClick={addReminder}>
            Set reminder
          </button>
        </div>
        {remErr && (
          <div className="muted" style={{ color: '#b91c1c', marginTop: 6 }}>
            {remErr}
          </div>
        )}
        <div className="muted" style={{ marginTop: 8 }}>
          Anyone at the kiosk can also say “set an alarm for 7am” or “remind me to feed the fish at
          5.”
        </div>
      </div>

      <div className="card">
        <strong style={{ fontSize: '1.05rem' }}>Scheduled</strong>
        <div style={{ marginTop: 10 }}>
          {schedules.length ? (
            schedules.map((s) => (
              <div
                className="row"
                key={s.id}
                style={{ justifyContent: 'space-between', padding: '5px 0' }}
              >
                {s.kind === 'timer' ? (
                  <span>
                    ⏰{' '}
                    <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {countdown(s.fire_at - serverNow)}
                    </strong>
                    {s.label ? ` — ${s.label}` : ` (${s.pretty})`}
                    {s.created_by === 'voice' && <span className="muted"> · set on kiosk</span>}
                  </span>
                ) : (
                  <span>
                    🔔 <strong>{s.when}</strong>
                    {s.message ? ` — ${s.message}` : ' — alarm'}
                    {s.created_by === 'voice' && <span className="muted"> · set on kiosk</span>}
                  </span>
                )}
                <button className="act warn" onClick={() => cancel(s.id)}>
                  Cancel
                </button>
              </div>
            ))
          ) : (
            <span className="muted">Nothing scheduled.</span>
          )}
        </div>
      </div>
    </>
  );
}
