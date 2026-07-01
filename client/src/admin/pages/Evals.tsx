import { useEffect, useState } from 'react';
import { useAdmin } from '../AdminContext';
import type { EvalsResponse, EvalKind, EvalSuggestion } from '../../lib/types';
import { phWhen } from './common';
import { SubNav } from './SubNav';
import { EvalSnapshot } from './EvalSnapshot';
import { EvalSuggestions } from './EvalSuggestions';
import { EvalResultsTable } from './EvalResultsTable';

// Content-quality evals: an AI judge (Opus) scores generated content on accuracy,
// age-fit, engagement, and clarity. Read the weakest items, tighten the AI prompts in
// Settings, re-run, and watch the numbers move. Runs in the background; we poll.
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

      <EvalSnapshot data={data} busy={busy} isChat={isChat} tab={tab} err={err} onRun={run} />

      <EvalSuggestions
        data={data}
        tab={tab}
        busy={busy}
        suggBusy={suggBusy}
        suggMsg={suggMsg}
        sugg={sugg}
        onSuggest={suggest}
        onAccept={acceptSuggestion}
        onDismiss={() => {
          setSugg(null);
          setSuggMsg('');
        }}
      />

      <EvalResultsTable
        rows={rows}
        dims={dims}
        view={view}
        hasLatest={hasLatest}
        isChat={isChat}
        onView={setTableView}
      />
    </>
  );
}
