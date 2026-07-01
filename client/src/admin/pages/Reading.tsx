import { useEffect, useState } from 'react';
import { useAdmin } from '../AdminContext';
import type { ReadingReportRow } from '../../lib/types';

// Per-child read-aloud progress: accuracy and the words they most often miss.
export function Reading() {
  const api = useAdmin();
  const [report, setReport] = useState<ReadingReportRow[]>([]);
  useEffect(() => {
    api
      .readingReport()
      .then((d) => setReport(d.report))
      .catch(() => {});
  }, [api]);
  const pct = (x: number | null) => (x == null ? '—' : Math.round(x * 100) + '%');
  return (
    <>
      <div className="card">
        <h3 style={{ marginBottom: 6 }}>Reading progress</h3>
        <p className="muted">
          How each child is doing reading aloud. Accuracy is scored per line and kept gentle — it's
          for encouragement and to adapt difficulty, not to grade.
        </p>
      </div>
      {report.length === 0 && <p className="muted">No children yet.</p>}
      {report.map((r) => (
        <div className="card" key={r.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <span className="pill" style={{ background: r.color }}>
                {r.initials}
              </span>{' '}
              <b>{r.name}</b> <span className="muted">· {r.reading_level || 'level not set'}</span>
            </div>
            <div className="muted">
              {r.count} line{r.count === 1 ? '' : 's'} read
            </div>
          </div>
          {r.count === 0 ? (
            <p className="muted" style={{ marginTop: 8 }}>
              No reading yet. Create a reading lesson and publish it to {r.name}.
            </p>
          ) : (
            <>
              <div className="row" style={{ marginTop: 12, gap: 28 }}>
                <div>
                  <label>Recent accuracy</label>
                  <div style={{ fontSize: '1.5rem', fontWeight: 800 }}>{pct(r.recentAvg)}</div>
                </div>
                <div>
                  <label>All-time</label>
                  <div style={{ fontSize: '1.5rem', fontWeight: 800 }}>{pct(r.avg)}</div>
                </div>
              </div>
              {r.missWords.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <label>Tricky words</label>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                    {r.missWords.map((w) => (
                      <span
                        key={w.word}
                        className="chip"
                        style={{ borderColor: '#fca5a5', color: '#dc2626' }}
                      >
                        {w.word}
                        {w.n > 1 ? ` ×${w.n}` : ''}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      ))}
    </>
  );
}
