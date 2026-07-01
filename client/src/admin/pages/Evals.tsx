import { useEffect, useState } from 'react';
import { useAdmin } from '../AdminContext';
import type { EvalsResponse, EvalKind, EvalSuggestion } from '../../lib/types';
import { phWhen } from './common';
import { SubNav } from './SubNav';

// Content-quality evals: an AI judge (Opus) scores generated content on accuracy,
// age-fit, engagement, and clarity. Read the weakest items, tighten the AI prompts in
// Settings, re-run, and watch the numbers move. Runs in the background; we poll.
const scoreColor = (v: number | null) =>
  v == null ? '#9ca3af' : v < 3 ? '#dc2626' : v < 4 ? '#d97706' : '#16a34a';
const Score = ({ v }: { v: number | null }) => (
  <span style={{ color: scoreColor(v), fontWeight: 700 }}>{v == null ? '—' : v.toFixed(1)}</span>
);
// A change vs the previous run, shown next to a score (green up / red down).
const Delta = ({ v, prev }: { v: number | null; prev?: number | null }) => {
  if (v == null || prev == null) return null;
  const d = v - prev;
  if (Math.abs(d) < 0.005)
    return (
      <span className="muted" style={{ fontSize: '.66rem', marginLeft: 4 }}>
        ±0
      </span>
    );
  return (
    <span
      style={{
        fontSize: '.66rem',
        fontWeight: 700,
        marginLeft: 4,
        color: d > 0 ? '#16a34a' : '#dc2626',
      }}
    >
      {d > 0 ? '▲' : '▼'}
      {Math.abs(d).toFixed(2)}
    </span>
  );
};
const Dim = ({ label, v, prev }: { label: string; v: number | null; prev?: number | null }) => (
  <div>
    <div className="muted" style={{ fontSize: '.72rem', textTransform: 'uppercase' }}>
      {label}
    </div>
    <div style={{ fontSize: '1.5rem', fontWeight: 800, color: scoreColor(v) }}>
      {v == null ? '—' : v.toFixed(2)}
      <Delta v={v} prev={prev} />
    </div>
  </div>
);
const runWhen = (t: number) =>
  new Date(t).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
// Line-level diff (LCS) for reviewing a suggested prompt against the current one.
type DiffLine = { type: 'same' | 'add' | 'del'; text: string };
function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split('\n'),
    B = b.split('\n'),
    m = A.length,
    n = B.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let jj = n - 1; jj >= 0; jj--)
      dp[i][jj] = A[i] === B[jj] ? dp[i + 1][jj + 1] + 1 : Math.max(dp[i + 1][jj], dp[i][jj + 1]);
  const out: DiffLine[] = [];
  let i = 0,
    j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) {
      out.push({ type: 'same', text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: A[i] });
      i++;
    } else {
      out.push({ type: 'add', text: B[j] });
      j++;
    }
  }
  while (i < m) out.push({ type: 'del', text: A[i++] });
  while (j < n) out.push({ type: 'add', text: B[j++] });
  return out;
}
const ConfBadge = ({ c }: { c: 'medium' | 'high' }) => (
  <span
    className="tag"
    style={{
      background: c === 'high' ? '#d1fae5' : '#fef3c7',
      color: c === 'high' ? '#065f46' : '#92400e',
    }}
  >
    {c} confidence
  </span>
);

const EVAL_TABS: [EvalKind, string][] = [
  ['page', 'Pages'],
  ['reading', 'Reading'],
  ['chat', 'Conversation'],
];
const EVAL_BLURB: Record<EvalKind, string> = {
  page: 'An AI judge scores generated pages. Where Playwright is installed it judges a screenshot of the rendered page — catching layout, label-positioning, and empty-section bugs the source alone would hide; otherwise it reads the source.',
  reading:
    'An AI judge scores generated reading lessons for accuracy, age-fit, engagement, and clarity.',
  chat: 'Runs a fixed set of kid messages through the chat pipeline and judges each spoken reply for accuracy, age-fit, helpfulness, and tone (including whether it redirects sensitive topics kindly).',
};
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

export function Evals() {
  const api = useAdmin();
  const [tab, setTab] = useState<EvalKind>('page');
  const [data, setData] = useState<EvalsResponse | null>(null);
  const [err, setErr] = useState('');
  const [sugg, setSugg] = useState<EvalSuggestion | null>(null);
  const [suggBusy, setSuggBusy] = useState(false);
  const [suggMsg, setSuggMsg] = useState('');
  const [tableView, setTableView] = useState<'latest' | 'all'>('latest');
  const load = (k: EvalKind = tab) =>
    api
      .evals(k)
      .then(setData)
      .catch(() => {});
  useEffect(() => {
    setData(null);
    setErr('');
    setSugg(null);
    setSuggMsg('');
    load(tab); /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [tab, api]);
  // Poll while a batch is running so the snapshot + table fill in live.
  const running = data?.job.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => load(), 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  const run = async (mode: 'benchmark' | 'live', reeval = false) => {
    setErr('');
    const r = await api.runEvals({ mode, kind: tab, reeval });
    if (r?.error) {
      setErr(r.error);
      return;
    }
    setTimeout(() => load(), 400);
  };

  const suggest = async () => {
    setSuggBusy(true);
    setSugg(null);
    setSuggMsg('');
    try {
      const r = await api.suggestPrompt(tab);
      if (r.error) setSuggMsg(r.error);
      else setSugg(r);
    } catch {
      setSuggMsg('Could not get a suggestion.');
    } finally {
      setSuggBusy(false);
    }
  };
  const acceptSuggestion = async () => {
    if (!sugg || sugg.state !== 'ok' || !sugg.changed) return;
    // Save as an 'eval'-authored prompt version (tracked + revertible in Settings).
    await api.saveConfig({ [sugg.field]: sugg.revisedPrompt, promptAuthor: 'eval' } as Parameters<
      typeof api.saveConfig
    >[0]);
    setSugg(null);
    setSuggMsg(
      'Prompt updated. Re-run the benchmark to see the effect — revert any time in Settings → prompt history.',
    );
  };

  const job = data?.job,
    dims = data?.dims || [];
  const latest = data?.latestRun || null,
    allTime = data?.allTime;
  const isChat = tab === 'chat';
  const busy = job?.running || !data?.live;
  const hasLatest = (data?.evals?.length || 0) > 0;
  const view = hasLatest ? tableView : 'all';
  const rows = (view === 'latest' ? data?.evals : data?.allEvals) || [];

  return (
    <>
      <SubNav tabs={EVAL_TABS} active={tab} onSelect={setTab} />
      <p className="muted" style={{ margin: '10px 0 6px' }}>
        {EVAL_BLURB[tab]}
      </p>
      <p className="muted" style={{ margin: '0 0 8px', fontSize: '.8rem' }}>
        <strong>Benchmark</strong> = a fixed sample you re-run to compare before/after a prompt
        change. <strong>Judge live</strong> = score your real{' '}
        {isChat ? 'logged replies' : tab === 'reading' ? 'reading lessons' : 'pages'}. The snapshot
        shows the latest run with a delta vs the previous run of the same type.
      </p>
      {isChat && data && (
        <p className="muted" style={{ margin: '0 0 12px', fontSize: '.8rem' }}>
          “Judge recent chats” grades real logged replies{' '}
          {data.promptChangedAt ? (
            <>
              sent since the chat prompt last changed (
              <strong>{phWhen(data.promptChangedAt)}</strong>)
            </>
          ) : (
            '(the chat prompt hasn’t been edited, so all logged replies are in scope)'
          )}{' '}
          — so you never grade replies made under an older prompt.
        </p>
      )}
      {data && !data.live && (
        <div className="card">
          <span className="muted" style={{ color: '#b91c1c' }}>
            No API key set — the judge needs a live model (set ANTHROPIC_API_KEY).
          </span>
        </div>
      )}

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
              onClick={() => run('benchmark')}
              title={BENCH_TIP[tab]}
            >
              Run benchmark
            </button>
            <button
              className="act sec"
              disabled={busy}
              onClick={() => run('live')}
              title={LIVE_TIP[tab]}
            >
              {isChat ? 'Judge recent chats' : 'Judge live'}
            </button>
            <button
              className="act sec"
              disabled={busy}
              onClick={() => run('live', true)}
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

      {allTime && allTime.n > 0 && (
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
            <button className="act" disabled={busy || suggBusy} onClick={suggest}>
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
                  <div
                    className="row"
                    style={{ gap: 10, marginBottom: 10, alignItems: 'flex-start' }}
                  >
                    <ConfBadge c={sugg.confidence} />
                    <span className="muted" style={{ fontSize: '.84rem', flex: 1 }}>
                      {sugg.rationale}
                    </span>
                  </div>
                  <div className="diff">
                    {lineDiff(sugg.currentPrompt, sugg.revisedPrompt).map((d, i) => (
                      <div key={i} className={`d-${d.type}`}>
                        {(d.type === 'add' ? '+ ' : d.type === 'del' ? '− ' : '  ') +
                          (d.text || ' ')}
                      </div>
                    ))}
                  </div>
                  <div className="row" style={{ gap: 8, marginTop: 10 }}>
                    <button className="act" onClick={acceptSuggestion}>
                      Accept &amp; save prompt
                    </button>
                    <button
                      className="act sec"
                      onClick={() => {
                        setSugg(null);
                        setSuggMsg('');
                      }}
                    >
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
      )}

      {rows.length > 0 && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: '1.05rem' }}>
              {view === 'latest' ? 'Latest run' : 'All outputs'} · weakest first
            </strong>
            <div className="subnav">
              <button
                className={view === 'latest' ? 'on' : ''}
                disabled={!hasLatest}
                onClick={() => setTableView('latest')}
              >
                Latest run
              </button>
              <button className={view === 'all' ? 'on' : ''} onClick={() => setTableView('all')}>
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
      )}
    </>
  );
}
