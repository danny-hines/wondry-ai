import type { ScheduleItem } from '../lib/types';

export function TimerChips({
  timers,
  nowTick,
  onDismiss,
}: {
  timers: ScheduleItem[];
  nowTick: number;
  onDismiss: (id: string) => void;
}) {
  return timers.length ? (
    <div id="timers">
      {timers.map((t) => {
        const remain = Math.max(0, t.fire_at - nowTick);
        const s = Math.ceil(remain / 1000);
        const mmss = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        return (
          <button
            key={t.id}
            className={`timerChip${remain === 0 ? ' done' : ''}`}
            title="Tap to cancel"
            onClick={() => onDismiss(t.id)}
          >
            <span className="tcIcon" aria-hidden="true">
              ⏰
            </span>
            <span className="tcTime">{mmss}</span>
            {t.label && <span className="tcLabel">{t.label}</span>}
            <span className="tcX" aria-hidden="true">
              ✕
            </span>
          </button>
        );
      })}
    </div>
  ) : null;
}
