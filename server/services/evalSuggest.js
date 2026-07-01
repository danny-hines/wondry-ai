// Close the eval loop: from a benchmark run's judge scores + the specific issues the
// judge flagged, ask the strong model to propose a MINIMAL revision to that kind's
// system prompt. Gated to the latest run produced under the CURRENT prompt — a
// suggestion is only sound when the evidence came from the prompt we'd be editing.
// A human reviews the diff and accepts (saved as an 'eval'-authored, revertible
// prompt version). On-demand only (one paid call).
import crypto from 'node:crypto';
import { getKV, evalRuns, listRunEvals, runSummary } from '../db.js';
import { runText } from './providers.js';
import { EVAL_DIMS } from './evalJudge.js';
import {
  DEFAULT_CHAT_SYSTEM_PROMPT,
  DEFAULT_ARTIFACT_SYSTEM_PROMPT,
  DEFAULT_READING_SYSTEM_PROMPT,
} from './systemPrompt.js';

// eval kind -> the editable system prompt it grades (KV key + saveConfig field + default).
export const KIND_PROMPT = {
  page: {
    key: 'artifact_system_prompt',
    field: 'systemPrompt',
    def: DEFAULT_ARTIFACT_SYSTEM_PROMPT,
    what: 'generates a self-contained interactive HTML learning page for a young child',
  },
  reading: {
    key: 'reading_system_prompt',
    field: 'readingSystemPrompt',
    def: DEFAULT_READING_SYSTEM_PROMPT,
    what: 'generates a structured reading-practice lesson as strict JSON',
  },
  chat: {
    key: 'chat_system_prompt',
    field: 'chatSystemPrompt',
    def: DEFAULT_CHAT_SYSTEM_PROMPT,
    what: "produces the avatar's short spoken replies to a child",
  },
};

export function promptHash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
}
export function promptKeyForKind(kind) {
  return KIND_PROMPT[kind]?.key || null;
}
// Hash of the live prompt a kind's outputs would be produced under right now.
export function currentPromptHash(kind) {
  const meta = KIND_PROMPT[kind];
  return meta ? promptHash(getKV(meta.key, meta.def)) : null;
}

const META_SYSTEM = `You are an expert prompt engineer improving the SYSTEM PROMPT of a children's learning device. You are given the current system prompt and concrete quality problems an independent AI judge found across a benchmark of real outputs produced by that exact prompt. Propose the smallest, most targeted revision to the system prompt that would fix the RECURRING problems.

HARD RULES:
- Preserve the output CONTRACT exactly: the required output format, JSON shape and keys, or HTML / no-external-resources rules must NOT change. Only improve the guidance, wording, emphasis, and constraints that shape quality.
- Make MINIMAL, surgical edits tied to the evidence — do not rewrite wholesale or add generic prompt-engineering boilerplate. Keep the prompt's existing voice, structure, and section order.
- Base every change on the RECURRING issues, not one-off or content-specific defects (a single wrong fact in one page is not a prompt problem).
- Only suggest a change if it is genuinely likely to help. If the issues aren't fixable by the prompt, or the prompt already covers them, set "changed": false.
- Confidence is "high" only when the issues are clearly recurring AND clearly addressable by a wording change; otherwise "medium". Never output "low" — if it would be low, set "changed": false.

Respond with ONLY compact JSON, no other text:
{"summary":"2-3 sentences on the main quality patterns in the evidence","changed":true,"confidence":"medium","rationale":"what you changed and why, tied to the issues","revisedPrompt":"the FULL revised system prompt"}
When no change is warranted, use "changed": false and "revisedPrompt": "".`;

const round = (v) => (v == null ? null : Math.round(v * 100) / 100);
const mapVals = (o, f) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, f(v)]));
function parseJson(raw) {
  try {
    const a = raw.indexOf('{'),
      b = raw.lastIndexOf('}');
    return JSON.parse(a >= 0 && b > a ? raw.slice(a, b + 1) : raw);
  } catch {
    return null;
  }
}

export async function suggestPromptImprovement(kind) {
  const meta = KIND_PROMPT[kind];
  if (!meta) throw new Error('unknown eval kind');
  const current = getKV(meta.key, meta.def);
  const curHash = promptHash(current);
  const base = {
    kind,
    field: meta.field,
    currentPrompt: current,
    changed: false,
    confidence: 'medium',
    summary: '',
    rationale: '',
    revisedPrompt: '',
  };

  // Only runs produced under a known prompt can ground a suggestion (benchmark runs and
  // chat-history; live content runs judge artifacts of mixed/unknown prompt → no hash).
  const run = evalRuns(kind, 50).find((r) => r.prompt_hash);
  if (!run)
    return {
      ...base,
      state: 'no-run',
      summary: 'Run a benchmark under the current prompt first, then ask for a suggestion.',
    };
  if (run.prompt_hash !== curHash)
    return {
      ...base,
      state: 'stale',
      runWhen: run.created_at,
      summary:
        'The prompt has changed since the last benchmark — re-run the benchmark so the suggestion reflects the current prompt.',
    };

  const summary = runSummary(run.id);
  const weakest = listRunEvals(kind, run.id, 300)
    .filter(
      (e) => (e.overall != null && e.overall < 4) || (e.issues && e.issues.length) || !e.safety_ok,
    )
    .slice(0, 14)
    .map((e) => ({
      item: e.subject || e.label || e.title || e.target_id,
      overall: e.overall,
      scores: e.scores,
      safety_ok: !!e.safety_ok,
      verdict: e.verdict,
      issues: e.issues || [],
    }));

  const evidence = {
    promptPurpose: meta.what,
    judgedDimensions: EVAL_DIMS[kind].map(([k, l]) => `${l} (${k})`).join(', '),
    itemsJudged: summary.n,
    snapshotAverages: { overall: round(summary.overall), ...mapVals(summary.dims, round) },
    safetyConcerns: summary.safetyConcerns,
    weakestItems: weakest,
  };
  const prompt =
    `CURRENT SYSTEM PROMPT (the one that ${meta.what}):\n"""\n${current}\n"""\n\n` +
    `JUDGE EVIDENCE from the latest benchmark run under this exact prompt (scores 1-5, higher is better):\n${JSON.stringify(evidence, null, 2)}\n\n` +
    `Propose the minimal prompt revision per the rules.`;

  let raw;
  try {
    raw = await runText('judge', { system: META_SYSTEM, prompt });
  } catch (e) {
    throw new Error('suggestion model call failed: ' + (e?.message || e));
  }
  const parsed = parseJson(raw);
  if (!parsed) throw new Error('could not parse the suggestion');

  const revised = typeof parsed.revisedPrompt === 'string' ? parsed.revisedPrompt.trim() : '';
  const changed = parsed.changed === true && !!revised && revised !== current.trim();
  return {
    ...base,
    state: 'ok',
    runWhen: run.created_at,
    changed,
    confidence: parsed.confidence === 'high' ? 'high' : 'medium',
    summary: String(parsed.summary || '').trim(),
    rationale: String(parsed.rationale || '').trim(),
    revisedPrompt: changed ? revised : '',
  };
}
