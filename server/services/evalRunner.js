// Batch eval orchestration, shared by the CLI and the admin trigger. Three flavors:
//   runContentEvals — judge existing artifacts of a kind (page → vision when available).
//   runMatrixEvals  — generate a subject×level grid of fresh pages and judge them.
//   runChatEvals    — run the fixed conversation suite through the chat pipeline + judge.
import {
  db,
  READING_LEVELS,
  evaluatedTargetIds,
  recentAvatarReplies,
  latestPromptVersion,
} from '../db.js';
import { createArtifact, getArtifact, NEUTRAL } from './generator.js';
import { judgeArtifact, judgeChat } from './evalJudge.js';
import { runText } from './providers.js';
import { getChatSystemPrompt } from './systemPrompt.js';
import { CHAT_EVAL_SUITE } from './chatEvalSuite.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bounded-concurrency map (preserves order, never rejects — errors are the fn's own).
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

const typeForKind = (kind) => (kind === 'reading' ? 'reading' : 'page');

export async function runContentEvals({
  kind = 'page',
  reeval = false,
  limit = 50,
  concurrency = 4,
  batch = 'existing',
  onProgress,
} = {}) {
  let rows = db
    .prepare("SELECT * FROM artifacts WHERE status='ready' AND type=? ORDER BY created_at DESC")
    .all(typeForKind(kind));
  if (!reeval) {
    const done = evaluatedTargetIds(kind);
    rows = rows.filter((r) => !done.has(r.id));
  }
  rows = rows.slice(0, limit);
  let judged = 0,
    skipped = 0;
  await pool(rows, concurrency, async (a, idx) => {
    const r = await judgeArtifact(a, { batch });
    if (r) judged++;
    else skipped++;
    onProgress?.({
      done: idx + 1,
      total: rows.length,
      judged,
      skipped,
      label: a.subject || a.title,
    });
  });
  return { mode: 'existing', kind, total: rows.length, judged, skipped, batch };
}

const DEFAULT_SUBJECTS = [
  'volcanoes',
  'the water cycle',
  'fractions',
  'dinosaurs',
  'the solar system',
  'photosynthesis',
  'sharks',
  'ancient Egypt',
  'simple machines',
  'the human heart',
];

async function waitReady(id, timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const a = getArtifact(id);
    if (!a || a.status === 'failed') return null;
    if (a.status === 'ready') return a;
    await sleep(1000);
  }
  return null;
}

export async function runMatrixEvals({
  subjects = DEFAULT_SUBJECTS,
  levels,
  concurrency = 3,
  batch,
  onProgress,
} = {}) {
  const lv = levels && levels.length ? levels : READING_LEVELS;
  const combos = [];
  for (const subject of subjects) for (const level of lv) combos.push({ subject, level });
  batch = batch || `matrix-${Date.now()}`;
  let judged = 0,
    failed = 0;
  await pool(combos, concurrency, async (c, idx) => {
    let art = null;
    try {
      const id = await createArtifact({
        typeId: 'page',
        params: { topic: c.subject },
        profile: { ...NEUTRAL, reading_level: c.level },
        source: 'eval',
      });
      art = await waitReady(id);
    } catch {
      /* generation threw */
    }
    const r = art ? await judgeArtifact(art, { batch }) : null;
    if (r) judged++;
    else failed++;
    onProgress?.({
      done: idx + 1,
      total: combos.length,
      judged,
      failed,
      label: `${c.subject} · ${c.level}`,
    });
  });
  return { mode: 'matrix', kind: 'page', total: combos.length, judged, failed, batch };
}

// Reading benchmark: generate fresh reading lessons across a fixed interest×level
// grid (so it's reproducible to re-run after a reading-prompt change), then judge each.
const DEFAULT_READING_INTERESTS = ['dinosaurs', 'space', 'animals', 'the ocean', 'a magic garden'];
const DEFAULT_READING_LEVELS = [1, 3, 5]; // pre-reader / developing / advanced — kept modest to bound cost
export async function runReadingMatrixEvals({
  interests = DEFAULT_READING_INTERESTS,
  levels = DEFAULT_READING_LEVELS,
  concurrency = 3,
  batch,
  onProgress,
} = {}) {
  const combos = [];
  for (const interest of interests) for (const level of levels) combos.push({ interest, level });
  batch = batch || `reading-bench-${Date.now()}`;
  let judged = 0,
    failed = 0;
  await pool(combos, concurrency, async (c, idx) => {
    let art = null;
    try {
      const id = await createArtifact({
        typeId: 'reading',
        params: { interest: c.interest, level: c.level },
        profile: { ...NEUTRAL },
        source: 'eval',
      });
      art = await waitReady(id);
    } catch {
      /* generation threw */
    }
    const r = art ? await judgeArtifact(art, { batch }) : null;
    if (r) judged++;
    else failed++;
    onProgress?.({
      done: idx + 1,
      total: combos.length,
      judged,
      failed,
      label: `${c.interest} · L${c.level}`,
    });
  });
  return { mode: 'reading-matrix', kind: 'reading', total: combos.length, judged, failed, batch };
}

// Conversation suite: generate the avatar's reply to each fixed prompt, then judge it.
// Always runs the whole suite (replies are fresh each time) — re-run after a chat
// system-prompt change to compare. Judged against the base (no-profile) chat prompt.
export async function runChatEvals({ concurrency = 4, batch, onProgress } = {}) {
  batch = batch || `chat-${Date.now()}`;
  const system = getChatSystemPrompt(null);
  const items = CHAT_EVAL_SUITE.map((prompt, index) => ({ prompt, index }));
  let judged = 0,
    failed = 0;
  await pool(items, concurrency, async (item, idx) => {
    let reply = '';
    try {
      reply = ((await runText('chat', { system, prompt: item.prompt })) || '').trim();
    } catch {
      /* generation failed */
    }
    const r = reply
      ? await judgeChat(
          { targetId: `q${item.index}`, prompt: item.prompt, response: reply },
          { batch },
        )
      : null;
    if (r) judged++;
    else failed++;
    onProgress?.({ done: idx + 1, total: items.length, judged, failed, label: item.prompt });
  });
  return { mode: 'chat', kind: 'chat', total: items.length, judged, failed, batch };
}

// Judge real logged avatar replies — but only those sent AFTER the chat system prompt
// last changed, so we never grade replies made under an older prompt (the cutoff comes
// straight from the prompt-version history). target_id is the message id, so re-judging
// keeps the latest score per reply.
export async function runChatHistoryEvals({
  limit = 50,
  reeval = false,
  concurrency = 4,
  batch,
  onProgress,
} = {}) {
  batch = batch || `chat-history-${Date.now()}`;
  const cutoff = latestPromptVersion('chat_system_prompt')?.created_at ?? 0;
  let rows = recentAvatarReplies(cutoff, 500);
  if (!reeval) {
    const done = evaluatedTargetIds('chat');
    rows = rows.filter((m) => !done.has(m.id));
  }
  rows = rows.slice(0, limit);
  let judged = 0,
    skipped = 0;
  await pool(rows, concurrency, async (m, idx) => {
    const r = await judgeChat(
      { targetId: m.id, prompt: m.prompt, response: m.response },
      { batch },
    );
    if (r) judged++;
    else skipped++;
    onProgress?.({ done: idx + 1, total: rows.length, judged, skipped, label: m.prompt });
  });
  return { mode: 'chat-history', kind: 'chat', total: rows.length, judged, skipped, cutoff, batch };
}
