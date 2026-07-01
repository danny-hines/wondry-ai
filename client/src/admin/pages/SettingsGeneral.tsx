import { useEffect, useState } from 'react';
import { useAdmin } from '../AdminContext';
import type { AdminConfig, UsageReport } from '../../lib/types';

export function SettingsGeneral({ config }: { config: AdminConfig }) {
  const api = useAdmin();
  const [usage, setUsage] = useState<UsageReport | null>(null);
  useEffect(() => {
    api
      .usage()
      .then(setUsage)
      .catch(() => {});
  }, [api]);
  return (
    <>
      <div className="card">
        <h3 style={{ marginBottom: 6 }}>Generation</h3>
        <p className="muted">
          Currently:{' '}
          <b>
            {config.liveGeneration
              ? 'LIVE — using Claude'
              : 'MOCK — set ANTHROPIC_API_KEY to go live'}
          </b>
          . Per-task routing (edit in config.json):
        </p>
        {Object.entries(config.routing).map(([k, v]) => (
          <div className="row" key={k}>
            <span style={{ minWidth: 110, fontWeight: 600 }}>{k}</span>
            <span className="muted">{v}</span>
          </div>
        ))}
      </div>
      <div className="card">
        <h3 style={{ marginBottom: 6 }}>API usage (estimated cost)</h3>
        <p className="muted" style={{ marginBottom: 10 }}>
          Estimated spend from generation, using the per-model prices in <code>config.json</code>.
          Estimates only — check your provider dashboard for exact billing.
        </p>
        {usage ? (
          <>
            <div className="row" style={{ gap: 24, flexWrap: 'wrap' }}>
              {(
                [
                  ['Today', 'today'],
                  ['Last 7 days', 'week'],
                  ['Last 30 days', 'month'],
                  ['Lifetime', 'lifetime'],
                ] as const
              ).map(([label, key]) => {
                const b = usage[key];
                return (
                  <div key={key} style={{ minWidth: 108 }}>
                    <label>{label}</label>
                    <div style={{ fontSize: '1.5rem', fontWeight: 800 }}>${b.cost.toFixed(2)}</div>
                    <div className="muted" style={{ fontSize: '.8rem' }}>
                      {b.n} call{b.n === 1 ? '' : 's'} · {Math.round((b.inTok + b.outTok) / 1000)}k
                      tok
                    </div>
                  </div>
                );
              })}
            </div>
            {usage.byModelMonth.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <label>By model (last 30 days)</label>
                {usage.byModelMonth.map((m) => (
                  <div className="row" key={m.model || '?'}>
                    <span style={{ minWidth: 240 }}>{m.model || 'unknown'}</span>
                    <span className="muted">
                      ${m.cost.toFixed(2)} · {m.n} call{m.n === 1 ? '' : 's'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <p className="muted">
            No usage recorded yet (or running on the mock provider — mock generation is free).
          </p>
        )}
      </div>
    </>
  );
}
