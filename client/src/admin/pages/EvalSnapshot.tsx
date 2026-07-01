import type { EvalsResponse, EvalKind } from '../../lib/types';
import { Score, Dim, runWhen } from './evalParts';

const BENCH_TIP: Record<EvalKind, string> = {
  page: 'Generate a fixed subject×level grid of fresh pages and judge them — reproducible, so re-run to compare before/after a prompt change.',
  reading:
    'Generate a fixed interest×level grid of fresh reading lessons and judge them — reproducible to re-run after a prompt change.',
  chat: 'Run the fixed conversation suite through the chat pipeline and judge each reply — reproducible to re-run after a prompt change.',
};
const LIVE_TIP: Record<EvalKind, string> = {
  page: 'Judge real pages your kids generated that haven’t been scored yet.',
  reading: 'Judge real reading lessons your kids generated that haven’t been scored yet.',
  chat: 'Judge real logged replies sent since the chat prompt last changed.',
};

export function EvalSnapshot({
  data,
  busy,
  isChat,
  tab,
  err,
  onRun,
}: {
  data: EvalsResponse | null;
  busy: boolean;
  isChat: boolean;
  tab: EvalKind;
  err: string;
  onRun: (mode: 'benchmark' | 'live', reeval?: boolean) => void;
}) {
  const job = data?.job;
  const dims = data?.dims || [];
  const latest = data?.latestRun || null;
  const allTime = data?.allTime;
  return (
    <div className="card">
      <div
        className="row"
        style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}
      >
        <div>
          {latest ? (
            <>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <strong style={{ fontSize: '1.05rem' }}>Latest run</strong>
                <span
                  className="tag"
                  style={{
                    background: latest.mode === 'benchmark' ? '#eef2ff' : '#f1f5f9',
                    color: latest.mode === 'benchmark' ? '#4f46e5' : '#475569',
                  }}
                >
                  {latest.mode}
                </span>
                <span className="muted" style={{ fontSize: '.8rem' }}>
                  · {runWhen(latest.when)} · {latest.summary.n} judged
                </span>
                {latest.promptMatches === false && (
                  <span className="tag" style={{ background: '#fef3c7', color: '#92400e' }}>
                    ⚠ prompt changed since
                  </span>
                )}
                {latest.promptMatches === true && (
                  <span className="muted" style={{ fontSize: '.74rem' }}>
                    ✓ current prompt
                  </span>
                )}
              </div>
              <div className="row" style={{ gap: 22, marginTop: 8 }}>
                <Dim
                  label="Overall"
                  v={latest.summary.overall}
                  prev={latest.prevSummary?.overall ?? null}
                />
                {dims.map(([k, label]) => (
                  <Dim
                    key={k}
                    label={label}
                    v={latest.summary.dims[k] ?? null}
                    prev={latest.prevSummary?.dims[k] ?? null}
                  />
                ))}
              </div>
              {latest.prevSummary && (
                <div className="muted" style={{ fontSize: '.74rem', marginTop: 4 }}>
                  Δ vs previous {latest.mode} run
                  {latest.prevWhen ? ` (${runWhen(latest.prevWhen)})` : ''}
                </div>
              )}
              {latest.summary.safetyConcerns > 0 && (
                <div className="muted" style={{ color: '#b91c1c', marginTop: 6 }}>
                  ⚠ {latest.summary.safetyConcerns} item(s) flagged for safety
                </div>
              )}
              {allTime && allTime.n > 0 && (
                <div className="muted" style={{ fontSize: '.78rem', marginTop: 8 }}>
                  All-time: <Score v={allTime.overall} /> overall across {allTime.n} judged
                </div>
              )}
            </>
          ) : allTime && allTime.n ? (
            <>
              <strong style={{ fontSize: '1.05rem' }}>Quality snapshot</strong>{' '}
              <span className="muted">· all-time · {allTime.n} judged</span>
              <div className="row" style={{ gap: 22, marginTop: 8 }}>
                <Dim label="Overall" v={allTime.overall} />
                {dims.map(([k, label]) => (
                  <Dim key={k} label={label} v={allTime.dims[k] ?? null} />
                ))}
              </div>
              <div className="muted" style={{ fontSize: '.78rem', marginTop: 8 }}>
                Run a benchmark to track latest-run quality with a before/after delta.
              </div>
            </>
          ) : (
            <span className="muted">
              No evals yet — run a benchmark or judge live outputs to get a snapshot.
            </span>
          )}
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button
            className="act"
            disabled={busy}
            onClick={() => onRun('benchmark')}
            title={BENCH_TIP[tab]}
          >
            Run benchmark
          </button>
          <button
            className="act sec"
            disabled={busy}
            onClick={() => onRun('live')}
            title={LIVE_TIP[tab]}
          >
            {isChat ? 'Judge recent chats' : 'Judge live'}
          </button>
          <button
            className="act sec"
            disabled={busy}
            onClick={() => onRun('live', true)}
            title="Re-score the live set with the current rubric — use after the judge/rubric changes"
          >
            Re-judge live
          </button>
        </div>
      </div>
      {job?.running && (
        <div className="eval-running">
          <span className="spinner" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>
              Running {job.mode}
              {job.kind ? ` · ${job.kind}` : ''} eval…{' '}
              {job.progress ? `${job.progress.done}/${job.progress.total}` : 'starting…'}
            </div>
            {job.progress?.label && (
              <div
                className="muted"
                style={{
                  fontSize: '.8rem',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {job.progress.label}
              </div>
            )}
            {job.progress && job.progress.total > 0 && (
              <div className="eval-bar">
                <span
                  style={{
                    width: `${Math.round((100 * job.progress.done) / job.progress.total)}%`,
                  }}
                />
              </div>
            )}
          </div>
        </div>
      )}
      {job && !job.running && job.error && (
        <div className="muted" style={{ color: '#b91c1c', marginTop: 8 }}>
          {job.error}
        </div>
      )}
      {err && (
        <div className="muted" style={{ color: '#b91c1c', marginTop: 8 }}>
          {err}
        </div>
      )}
    </div>
  );
}
