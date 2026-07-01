import type { EvalsResponse } from '../../lib/types';
import { Score } from './evalParts';

export function EvalResultsTable({
  rows,
  dims,
  view,
  hasLatest,
  isChat,
  onView,
}: {
  rows: EvalsResponse['evals'];
  dims: EvalsResponse['dims'];
  view: 'latest' | 'all';
  hasLatest: boolean;
  isChat: boolean;
  onView: (v: 'latest' | 'all') => void;
}) {
  return rows.length > 0 ? (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: '1.05rem' }}>
          {view === 'latest' ? 'Latest run' : 'All outputs'} · weakest first
        </strong>
        <div className="subnav">
          <button
            className={view === 'latest' ? 'on' : ''}
            disabled={!hasLatest}
            onClick={() => onView('latest')}
          >
            Latest run
          </button>
          <button className={view === 'all' ? 'on' : ''} onClick={() => onView('all')}>
            All
          </button>
        </div>
      </div>
      <table
        className="evaltable"
        style={{ width: '100%', marginTop: 10, borderCollapse: 'collapse' }}
      >
        <thead>
          <tr style={{ textAlign: 'left' }}>
            <th>Overall</th>
            <th>{isChat ? 'Prompt → reply' : 'Content'}</th>
            {dims.map(([k, label]) => (
              <th key={k}>{label}</th>
            ))}
            <th>Judge notes</th>
            {!isChat && <th></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id} style={{ borderTop: '1px solid #eef0f3' }}>
              <td style={{ fontSize: '1.15rem' }}>
                <Score v={e.overall} />
              </td>
              <td style={{ maxWidth: 320 }}>
                {isChat ? (
                  <>
                    <div style={{ fontWeight: 600 }}>
                      {e.label}{' '}
                      <span className="muted" style={{ fontWeight: 400, fontSize: '.72rem' }}>
                        · {e.target_id?.startsWith('q') ? 'suite' : 'live'}
                      </span>
                    </div>
                    <div className="muted" style={{ fontSize: '.8rem' }}>
                      “{e.response}”
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontWeight: 600 }}>{e.subject || e.label || e.title}</div>
                    <div className="muted" style={{ fontSize: '.74rem' }}>
                      {e.reading_level || '—'}
                      {e.method === 'vision' ? ' · 👁 vision' : ''}
                      {e.safety_ok ? '' : ' · ⚠ safety'}
                    </div>
                  </>
                )}
              </td>
              {dims.map(([k]) => (
                <td key={k}>
                  <Score v={e.scores[k] ?? null} />
                </td>
              ))}
              <td style={{ maxWidth: 320 }}>
                <div>{e.verdict}</div>
                {e.issues?.length > 0 && (
                  <div className="muted" style={{ fontSize: '.78rem' }}>
                    {e.issues.join(' · ')}
                  </div>
                )}
              </td>
              {!isChat && (
                <td>
                  <a
                    className="act sec"
                    href={`/preview/${e.target_id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View
                  </a>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : null;
}
