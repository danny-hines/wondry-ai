import type { EvalsResponse, EvalKind, EvalSuggestion } from '../../lib/types';
import { ConfBadge, lineDiff } from './evalParts';

export function EvalSuggestions({
  data,
  tab,
  busy,
  suggBusy,
  suggMsg,
  sugg,
  onSuggest,
  onAccept,
  onDismiss,
}: {
  data: EvalsResponse | null;
  tab: EvalKind;
  busy: boolean;
  suggBusy: boolean;
  suggMsg: string;
  sugg: EvalSuggestion | null;
  onSuggest: () => void;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const allTime = data?.allTime;
  return allTime && allTime.n > 0 ? (
    <div className="card">
      <div
        className="row"
        style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12 }}
      >
        <div>
          <strong style={{ fontSize: '1.05rem' }}>Prompt suggestions</strong>
          <div className="muted" style={{ fontSize: '.82rem' }}>
            From the latest benchmark run under the current prompt, have the judge propose a
            targeted edit to the{' '}
            {tab === 'chat' ? 'chat' : tab === 'reading' ? 'reading-lesson' : 'page-generation'}{' '}
            system prompt.
          </div>
        </div>
        <button className="act" disabled={busy || suggBusy} onClick={onSuggest}>
          {suggBusy ? 'Analyzing…' : sugg ? 'Re-analyze' : 'Suggest a prompt update'}
        </button>
      </div>
      {suggMsg && <div style={{ marginTop: 10, color: '#16a34a' }}>{suggMsg}</div>}
      {sugg && sugg.state === 'no-run' && (
        <div className="muted" style={{ marginTop: 10 }}>
          {sugg.summary}
        </div>
      )}
      {sugg && sugg.state === 'stale' && (
        <div style={{ marginTop: 10, color: '#92400e' }}>⚠ {sugg.summary}</div>
      )}
      {sugg && sugg.state === 'ok' && (
        <div style={{ marginTop: 12 }}>
          <p style={{ margin: '0 0 8px' }}>{sugg.summary}</p>
          {sugg.changed ? (
            <>
              <div className="row" style={{ gap: 10, marginBottom: 10, alignItems: 'flex-start' }}>
                <ConfBadge c={sugg.confidence} />
                <span className="muted" style={{ fontSize: '.84rem', flex: 1 }}>
                  {sugg.rationale}
                </span>
              </div>
              <div className="diff">
                {lineDiff(sugg.currentPrompt, sugg.revisedPrompt).map((d, i) => (
                  <div key={i} className={`d-${d.type}`}>
                    {(d.type === 'add' ? '+ ' : d.type === 'del' ? '− ' : '  ') + (d.text || ' ')}
                  </div>
                ))}
              </div>
              <div className="row" style={{ gap: 8, marginTop: 10 }}>
                <button className="act" onClick={onAccept}>
                  Accept &amp; save prompt
                </button>
                <button className="act sec" onClick={onDismiss}>
                  Dismiss
                </button>
              </div>
            </>
          ) : (
            <div className="muted">
              <ConfBadge c={sugg.confidence} /> No prompt change suggested. {sugg.rationale}
            </div>
          )}
        </div>
      )}
    </div>
  ) : null;
}
