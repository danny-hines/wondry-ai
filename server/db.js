// SQLite layer using Node's built-in node:sqlite (no native build needed).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.WONDRY_DB || path.join(__dirname, '..', 'data', 'wondry.db');

// The data/ dir is git-ignored, so on a fresh clone it won't exist yet — create it
// before opening the DB so seed/start work out of the box.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
export const db = new DatabaseSync(DB_PATH);
try { db.exec('PRAGMA journal_mode = WAL;'); } catch { /* keep default journal */ }
db.exec('PRAGMA foreign_keys = ON;');

export function uid() { return crypto.randomBytes(9).toString('base64url'); }
export const now = () => Date.now();

function ensureColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}

function dropColumn(table, col) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (cols.includes(col)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`);
}

export function initSchema() {
  // Timers generalized into `schedules` (timers + wall-clock reminders/alarms).
  // reminders carry no duration, so schedules.duration_ms must be nullable — but the
  // old `timers` table (and an in-place-renamed `schedules` from an earlier build) had
  // it NOT NULL. Normalize by stashing whatever exists into `_schedules_migrate`, let
  // the canonical CREATE below rebuild the nullable shape, then column-aware copy the
  // rows back (post-copy further down). PRAGMA on a missing table returns [] (no error).
  try {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    const notNull = (table, col) => {
      const c = db.prepare(`PRAGMA table_info(${table})`).all().find((x) => x.name === col);
      return c ? !!c.notnull : false;
    };
    if (!names.includes('_schedules_migrate')) {
      if (names.includes('timers') && !names.includes('schedules')) {
        const cols = db.prepare('PRAGMA table_info(timers)').all().map((c) => c.name);
        if (cols.includes('profile_id')) db.exec('DROP TABLE IF EXISTS timers');   // ancient per-child → throwaway
        else db.exec('DROP INDEX IF EXISTS idx_timers_status; ALTER TABLE timers RENAME TO _schedules_migrate');
      } else if (names.includes('schedules') && notNull('schedules', 'duration_ms')) {
        // Earlier build renamed timers→schedules in place, keeping duration_ms NOT NULL.
        db.exec('DROP INDEX IF EXISTS idx_schedules_status; ALTER TABLE schedules RENAME TO _schedules_migrate');
      }
    }
  } catch { /* no timers/schedules table yet */ }
  // The eval harness generalized content_evals → evals; its old rows are pre-rubric
  // exploratory scores (dropped, not migrated — they'll be re-judged).
  try { db.exec('DROP TABLE IF EXISTS content_evals'); } catch { /* none */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, initials TEXT NOT NULL, color TEXT NOT NULL,
      age INTEGER, reading_level TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id),
      started_at INTEGER NOT NULL, last_activity INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id),
      profile_id TEXT NOT NULL REFERENCES profiles(id), role TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'text', text TEXT, artifact_id TEXT REFERENCES artifacts(id),
      safety_flag INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT, profile_id TEXT REFERENCES profiles(id),
      source TEXT NOT NULL DEFAULT 'on_demand', status TEXT NOT NULL DEFAULT 'generating',
      subject TEXT, reading_level TEXT, plan TEXT, emoji TEXT, color TEXT, error TEXT,
      published INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, ready_at INTEGER
    );
    -- per-child publishing: a row means this artifact is published to this child.
    CREATE TABLE IF NOT EXISTS artifact_audience (
      artifact_id TEXT NOT NULL REFERENCES artifacts(id), profile_id TEXT NOT NULL REFERENCES profiles(id),
      created_at INTEGER NOT NULL, PRIMARY KEY (artifact_id, profile_id)
    );
    CREATE TABLE IF NOT EXISTS engagement (
      artifact_id TEXT NOT NULL REFERENCES artifacts(id), profile_id TEXT NOT NULL REFERENCES profiles(id),
      seen INTEGER NOT NULL DEFAULT 0, opened INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0,
      opened_at INTEGER, PRIMARY KEY (artifact_id, profile_id)
    );
    CREATE TABLE IF NOT EXISTS safety_log (
      id TEXT PRIMARY KEY, profile_id TEXT, stage TEXT NOT NULL, verdict TEXT NOT NULL,
      reason TEXT, sample TEXT, created_at INTEGER NOT NULL
    );
    -- Generic per-type progress log: one row per scored interaction (a reading
    -- line read aloud, a quiz answered, a game finished, ...). Columns: type is the
    -- content type id, kind the event kind, value a 0..1 score, data a JSON blob the
    -- type interprets. Drives per-type parent reports and difficulty adaptation.
    CREATE TABLE IF NOT EXISTS progress_events (
      id TEXT PRIMARY KEY, artifact_id TEXT REFERENCES artifacts(id),
      profile_id TEXT NOT NULL REFERENCES profiles(id),
      type TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'event',
      value REAL NOT NULL DEFAULT 0, data TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_progress_profile_type ON progress_events(profile_id, type);
    -- Cached media baked at generation time from trusted sources (Wikimedia, …).
    -- The model never sees URLs; it requests by description, an adapter fetches +
    -- validates, and we serve the local copy (keeps the runtime sealed + offline).
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY, source TEXT, query TEXT, mime TEXT NOT NULL, ext TEXT,
      alt TEXT, credit TEXT, license TEXT, source_url TEXT, bytes INTEGER, created_at INTEGER NOT NULL
    );
    -- Per-call LLM token usage + estimated cost, for the parent console's cost
    -- dashboard. One row per Anthropic API call (model prices are in config.json).
    CREATE TABLE IF NOT EXISTS api_usage (
      id TEXT PRIMARY KEY, task TEXT, model TEXT, artifact_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_created ON api_usage(created_at);
    -- Scheduled things that fire at an absolute time: countdown timers and wall-clock
    -- reminders/alarms. Device-global (a shared kiosk, not per child). fire_at is the
    -- absolute epoch-ms deadline so it survives a restart; the scheduler re-arms
    -- pending rows on boot. kind: timer | reminder. message: spoken on a reminder fire.
    -- recurrence: null (one-time) for now; reserved for daily/weekday repeats.
    -- duration_ms only meaningful for timers. status: pending | fired | cancelled.
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'timer', label TEXT, message TEXT,
      duration_ms INTEGER, fire_at INTEGER NOT NULL, recurrence TEXT,
      status TEXT NOT NULL DEFAULT 'pending', created_by TEXT NOT NULL DEFAULT 'voice',
      created_at INTEGER NOT NULL, fired_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_schedules_status ON schedules(status);
    -- AI-judge scores from the eval harness, generalized across content kinds. One row
    -- per judging; re-judging inserts a new row, so quality is tracked over time.
    -- kind: 'page' | 'reading' | 'chat'. target_id: artifact id, or a stable chat-suite
    -- key. scores: JSON {dimension: 1-5} (dimensions vary by kind). method: text|vision.
    -- prompt/response carry a conversation eval's input + the reply being graded.
    CREATE TABLE IF NOT EXISTS evals (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, target_id TEXT,
      label TEXT, prompt TEXT, response TEXT, batch TEXT, model TEXT, method TEXT,
      scores TEXT, overall REAL, safety_ok INTEGER NOT NULL DEFAULT 1,
      verdict TEXT, issues TEXT, raw TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evals_kind ON evals(kind, target_id);
    CREATE INDEX IF NOT EXISTS idx_evals_batch ON evals(batch);
    -- One row per eval batch (a "run"): groups its eval rows, records the run mode
    -- (benchmark = reproducible sample re-run to compare; live = real outputs) and a
    -- hash of the prompt it ran against — so the console shows the latest run distinctly
    -- and only offers prompt suggestions for runs produced under the current prompt.
    CREATE TABLE IF NOT EXISTS eval_runs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, mode TEXT NOT NULL,
      prompt_key TEXT, prompt_hash TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eval_runs_kind ON eval_runs(kind, created_at);
    -- Append-only history of editable system prompts, so a save can be rolled back to
    -- any prior version (not just the default). author: parent (console) | eval (a
    -- future self-improvement framework) | system. The live value still lives in KV;
    -- this is the audit/restore log.
    CREATE TABLE IF NOT EXISTS prompt_versions (
      id TEXT PRIMARY KEY, prompt_key TEXT NOT NULL, value TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'parent', note TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_versions ON prompt_versions(prompt_key, created_at);
    CREATE TABLE IF NOT EXISTS config_kv ( key TEXT PRIMARY KEY, value TEXT );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_profile ON artifacts(profile_id);
    CREATE INDEX IF NOT EXISTS idx_audience_profile ON artifact_audience(profile_id);
  `);

  // forward-looking per-kid customization (wired once Piper TTS lands)
  ensureColumn('profiles', 'voice', 'TEXT');
  ensureColumn('profiles', 'persona', 'TEXT');
  // per-kid kiosk appearance: 'light' (default) or 'dark'
  ensureColumn('profiles', 'theme', "TEXT NOT NULL DEFAULT 'light'");
  // free-text interests ("dinosaurs, Minecraft, space") — themes reading lessons.
  ensureColumn('profiles', 'interests', 'TEXT');
  // artifact kind: 'page' (sandboxed interactive HTML) or 'reading' (JSON lesson).
  ensureColumn('artifacts', 'type', "TEXT NOT NULL DEFAULT 'page'");
  // content types turned OFF for this child (comma-separated type ids).
  ensureColumn('profiles', 'disabled_types', 'TEXT');
  // reminder fields (defensive — the canonical CREATE already includes them).
  ensureColumn('schedules', 'kind', "TEXT NOT NULL DEFAULT 'timer'");
  ensureColumn('schedules', 'message', 'TEXT');
  ensureColumn('schedules', 'recurrence', 'TEXT');
  // Post-copy the stashed rows into the rebuilt (nullable) schedules, then drop the
  // stash. Column-aware so it works whether the stash is the old `timers` shape (no
  // kind/message/recurrence) or a half-migrated `schedules` shape (has them): present
  // columns copy across, an absent `kind` defaults to 'timer', other absent ones null.
  try {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_schedules_migrate'").get();
    if (has) {
      const src = new Set(db.prepare('PRAGMA table_info(_schedules_migrate)').all().map((c) => c.name));
      const dest = ['id', 'kind', 'label', 'message', 'duration_ms', 'fire_at', 'recurrence', 'status', 'created_by', 'created_at', 'fired_at'];
      const exprs = dest.map((c) => (src.has(c) ? c : c === 'kind' ? "'timer'" : 'NULL'));
      db.exec(`INSERT INTO schedules (${dest.join(',')}) SELECT ${exprs.join(',')} FROM _schedules_migrate;
               DROP TABLE _schedules_migrate;`);
    }
  } catch { /* nothing to migrate */ }
  // attribute LLM usage to the artifact it generated (added after api_usage shipped).
  ensureColumn('api_usage', 'artifact_id', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_artifact ON api_usage(artifact_id)');

  // Parents are no longer a distinct profile type — admin access is the shared
  // password, and multiple parents share it without needing individual profiles.
  // Drop the legacy flag from existing DBs (no-op on fresh ones).
  dropColumn('profiles', 'is_parent');

  // one-time backfill: existing published artifacts -> audience rows
  const aud = db.prepare('SELECT COUNT(*) n FROM artifact_audience').get().n;
  const arts = db.prepare('SELECT COUNT(*) n FROM artifacts').get().n;
  if (aud === 0 && arts > 0) {
    const rows = db.prepare("SELECT id, profile_id FROM artifacts WHERE published=1 AND profile_id IS NOT NULL").all();
    const ins = db.prepare('INSERT OR IGNORE INTO artifact_audience (artifact_id,profile_id,created_at) VALUES (?,?,?)');
    for (const r of rows) ins.run(r.id, r.profile_id, now());
  }
}

// --- audience helpers (per-child publishing) ---
export function setAudience(artifactId, profileId, on) {
  if (on) {
    db.prepare('INSERT OR IGNORE INTO artifact_audience (artifact_id,profile_id,created_at) VALUES (?,?,?)').run(artifactId, profileId, now());
    db.prepare('INSERT OR IGNORE INTO engagement (artifact_id,profile_id,seen) VALUES (?,?,0)').run(artifactId, profileId);
  } else {
    db.prepare('DELETE FROM artifact_audience WHERE artifact_id=? AND profile_id=?').run(artifactId, profileId);
    db.prepare('DELETE FROM engagement WHERE artifact_id=? AND profile_id=?').run(artifactId, profileId);
  }
}
export function audienceFor(artifactId) {
  return db.prepare('SELECT profile_id FROM artifact_audience WHERE artifact_id=?').all(artifactId).map((r) => r.profile_id);
}

// --- media (baked images) ---
export function insertMedia(m) {
  db.prepare(`INSERT INTO media (id,source,query,mime,ext,alt,credit,license,source_url,bytes,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(m.id, m.source ?? null, m.query ?? null, m.mime, m.ext ?? null, m.alt ?? null,
         m.credit ?? null, m.license ?? null, m.source_url ?? null, m.bytes ?? null, now());
}
export function getMedia(id) { return db.prepare('SELECT * FROM media WHERE id=?').get(id); }

// --- API usage / cost accounting ---
export function recordUsage({ task, model, artifactId = null, inputTokens = 0, outputTokens = 0, costUsd = 0 }) {
  db.prepare(`INSERT INTO api_usage (id,task,model,artifact_id,input_tokens,output_tokens,cost_usd,created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(uid(), task ?? null, model ?? null, artifactId ?? null, Math.round(inputTokens) || 0, Math.round(outputTokens) || 0, Number(costUsd) || 0, now());
}
// Total estimated cost per artifact id (for the Content list). Returns { id: cost }.
export function costByArtifact(ids) {
  if (!ids || !ids.length) return {};
  const rows = db.prepare(`SELECT artifact_id, COALESCE(SUM(cost_usd),0) AS cost
    FROM api_usage WHERE artifact_id IN (${ids.map(() => '?').join(',')}) GROUP BY artifact_id`).all(...ids);
  return Object.fromEntries(rows.map((r) => [r.artifact_id, r.cost]));
}
// Totals since a timestamp (0 = lifetime).
export function usageSince(ts) {
  return db.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(input_tokens),0) AS inTok,
    COALESCE(SUM(output_tokens),0) AS outTok, COUNT(*) AS n FROM api_usage WHERE created_at >= ?`).get(ts);
}
export function usageByModel(ts) {
  return db.prepare(`SELECT model, COALESCE(SUM(cost_usd),0) AS cost, COUNT(*) AS n
    FROM api_usage WHERE created_at >= ? GROUP BY model ORDER BY cost DESC`).all(ts);
}

// --- schedules (device-global timers + wall-clock reminders/alarms) ---
export function createScheduleRow({ kind = 'timer', label = null, message = null, durationMs = null, fireAt, recurrence = null, createdBy = 'voice' }) {
  const id = uid();
  db.prepare(`INSERT INTO schedules (id,kind,label,message,duration_ms,fire_at,recurrence,status,created_by,created_at)
              VALUES (?,?,?,?,?,?,?, 'pending', ?, ?)`)
    .run(id, kind, label, message, durationMs == null ? null : Math.round(durationMs),
         Math.round(fireAt), recurrence, createdBy, now());
  return getScheduleRow(id);
}
export function getScheduleRow(id) { return db.prepare('SELECT * FROM schedules WHERE id=?').get(id); }
// All pending schedules, soonest first — drives the kiosk's countdown chips, the
// console list, and the boot re-arm. Device-global, not scoped to a profile.
export function activeSchedules() {
  return db.prepare("SELECT * FROM schedules WHERE status='pending' ORDER BY fire_at ASC").all();
}
export function setScheduleStatus(id, status, firedAt = null) {
  db.prepare('UPDATE schedules SET status=?, fired_at=? WHERE id=?').run(status, firedAt, id);
  return getScheduleRow(id);
}
// Re-arm a recurring schedule at its next occurrence (keeps the same row pending).
export function rescheduleRow(id, fireAt) {
  db.prepare("UPDATE schedules SET fire_at=?, status='pending', fired_at=NULL WHERE id=?").run(Math.round(fireAt), id);
  return getScheduleRow(id);
}

// --- evals (AI-judge scores, generalized across kinds: page / reading / chat) ---
const evalNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.min(5, v)) : null);
export function insertEval(e) {
  const id = uid();
  const scores = e.scores
    ? JSON.stringify(Object.fromEntries(Object.entries(e.scores).map(([k, v]) => [k, evalNum(v)])))
    : null;
  db.prepare(`INSERT INTO evals
      (id,kind,target_id,label,prompt,response,batch,model,method,scores,overall,safety_ok,verdict,issues,raw,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, e.kind, e.targetId ?? null, e.label ?? null, e.prompt ?? null, e.response ?? null,
         e.batch ?? null, e.model ?? null, e.method ?? 'text', scores,
         evalNum(e.overall), e.safety_ok === false ? 0 : 1, e.verdict ?? null,
         e.issues ? JSON.stringify(e.issues) : null, e.raw ?? null, now());
  return id;
}
// Target ids of a kind that already have an eval — to judge only un-evaluated items.
export function evaluatedTargetIds(kind) {
  return new Set(db.prepare('SELECT DISTINCT target_id FROM evals WHERE kind=?').all(kind).map((r) => r.target_id));
}
const LATEST_PER_TARGET = `e.id IN (SELECT id FROM evals e2 WHERE e2.kind=e.kind AND e2.target_id=e.target_id ORDER BY created_at DESC, id DESC LIMIT 1)`;
// Latest eval per target of a kind, worst overall first. Artifact kinds join in title/etc.
export function listEvals(kind, limit = 300) {
  const join = kind === 'chat' ? '' : 'LEFT JOIN artifacts a ON a.id = e.target_id';
  const cols = kind === 'chat' ? 'e.*' : 'e.*, a.title, a.subject, a.reading_level, a.source';
  return db.prepare(`SELECT ${cols} FROM evals e ${join}
    WHERE e.kind=? AND ${LATEST_PER_TARGET} ORDER BY e.overall ASC, e.created_at DESC LIMIT ?`).all(kind, limit)
    .map((r) => ({ ...r, scores: r.scores ? safeParse(r.scores) : {}, issues: r.issues ? safeParse(r.issues) : [] }));
}
// Aggregate a set of eval rows into a snapshot (overall + per-dimension averages).
function summarize(rows) {
  const n = rows.length;
  const acc = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.scores || {})) {
    if (v != null) { (acc[k] = acc[k] || { sum: 0, n: 0 }).sum += v; acc[k].n++; }
  }
  const dims = Object.fromEntries(Object.entries(acc).map(([k, d]) => [k, d.n ? d.sum / d.n : null]));
  return {
    n, overall: n ? rows.reduce((s, r) => s + (r.overall || 0), 0) / n : null,
    dims, safetyConcerns: rows.filter((r) => !r.safety_ok).length,
  };
}
// All-time snapshot: averages over the latest eval per target of a kind.
export function evalSummary(kind) {
  const rows = db.prepare(`SELECT e.* FROM evals e WHERE e.kind=? AND ${LATEST_PER_TARGET}`).all(kind)
    .map((r) => ({ ...r, scores: r.scores ? safeParse(r.scores) : {} }));
  return summarize(rows);
}
// Snapshot for one run (batch) — every eval row in that batch.
export function runSummary(batch) {
  const rows = db.prepare('SELECT overall, scores, safety_ok FROM evals WHERE batch=?').all(batch)
    .map((r) => ({ ...r, scores: r.scores ? safeParse(r.scores) : {} }));
  return summarize(rows);
}
// The eval rows of one run (weakest first), with artifact info joined for content kinds.
export function listRunEvals(kind, batch, limit = 300) {
  const join = kind === 'chat' ? '' : 'LEFT JOIN artifacts a ON a.id = e.target_id';
  const cols = kind === 'chat' ? 'e.*' : 'e.*, a.title, a.subject, a.reading_level, a.source';
  return db.prepare(`SELECT ${cols} FROM evals e ${join} WHERE e.kind=? AND e.batch=? ORDER BY e.overall ASC, e.created_at DESC LIMIT ?`)
    .all(kind, batch, limit).map((r) => ({ ...r, scores: r.scores ? safeParse(r.scores) : {}, issues: r.issues ? safeParse(r.issues) : [] }));
}

// --- eval runs (one row per batch) ---
export function recordEvalRun({ id, kind, mode, promptKey = null, promptHash = null }) {
  db.prepare('INSERT OR IGNORE INTO eval_runs (id,kind,mode,prompt_key,prompt_hash,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, kind, mode, promptKey, promptHash, now());
  return id;
}
export function evalRuns(kind, limit = 50) {
  return db.prepare('SELECT * FROM eval_runs WHERE kind=? ORDER BY created_at DESC, id DESC LIMIT ?').all(kind, limit);
}

// Real avatar chat replies (for judging actual conversation history), each paired
// with the kid message it answered, created at/after `sinceTs` (the cutoff used to
// only judge replies made under the current system prompt). Skips page-announcement
// messages (kind!='text') and replies with no preceding kid turn.
export function recentAvatarReplies(sinceTs = 0, limit = 200) {
  return db.prepare(`
    SELECT a.id, a.text AS response, a.created_at, a.profile_id,
      (SELECT k.text FROM messages k WHERE k.conversation_id=a.conversation_id
        AND k.role='kid' AND k.safety_flag=0 AND k.created_at < a.created_at
        ORDER BY k.created_at DESC LIMIT 1) AS prompt
    FROM messages a
    WHERE a.role='avatar' AND a.kind='text' AND a.text IS NOT NULL AND a.safety_flag=0 AND a.created_at >= ?
    ORDER BY a.created_at DESC LIMIT ?`).all(sinceTs, limit).filter((r) => r.prompt);
}

// --- prompt version history ---
export function latestPromptVersion(key) {
  return db.prepare('SELECT * FROM prompt_versions WHERE prompt_key=? ORDER BY created_at DESC, id DESC LIMIT 1').get(key);
}
// Records a saved prompt, skipping a no-op save (identical to the latest version).
export function addPromptVersion({ key, value, author = 'parent', note = null }) {
  const latest = latestPromptVersion(key);
  if (latest && latest.value === value) return latest.id;
  const id = uid();
  db.prepare('INSERT INTO prompt_versions (id,prompt_key,value,author,note,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, key, value, author, note, now());
  return id;
}
export function promptVersions(key, limit = 50) {
  return db.prepare('SELECT id,prompt_key,value,author,note,created_at FROM prompt_versions WHERE prompt_key=? ORDER BY created_at DESC, id DESC LIMIT ?').all(key, limit);
}

export function getKV(key, fallback = null) {
  const row = db.prepare('SELECT value FROM config_kv WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
export function setKV(key, value) {
  db.prepare('INSERT INTO config_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// --- reading practice ---
// The 5 reading-level labels (shared with the admin Kids editor) mapped to a
// numeric scale so generation can step difficulty up/down a notch.
export const READING_LEVELS = ['pre-reader', 'early reader', 'developing reader', 'fluent reader', 'advanced reader'];
export function readingLevelNum(label) {
  const i = READING_LEVELS.indexOf((label || '').trim());
  return i >= 0 ? i + 1 : 2; // default: early reader
}

// Generic progress event — any content type can record scored interactions.
export function recordProgressEvent({ artifactId, profileId, type, kind = 'event', value = 0, data }) {
  const id = uid();
  db.prepare(`INSERT INTO progress_events (id,artifact_id,profile_id,type,kind,value,data,created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, artifactId || null, profileId, type, kind, typeof value === 'number' ? value : 0,
         data != null ? JSON.stringify(data) : null, now());
  return id;
}
export function progressEvents(profileId, type, limit = 400) {
  return db.prepare('SELECT value, data, created_at FROM progress_events WHERE profile_id=? AND type=? ORDER BY created_at DESC LIMIT ?')
    .all(profileId, type, limit)
    .map((r) => ({ value: r.value, data: r.data ? safeParse(r.data) : null, created_at: r.created_at }));
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

// Reading-specific helpers, now backed by the generic progress_events table.
export function recordReadingAttempt({ artifactId, profileId, pageIndex = 0, lineIndex = 0, expected, transcript, score, perWord }) {
  return recordProgressEvent({ artifactId, profileId, type: 'reading', kind: 'line', value: score,
    data: { pageIndex, lineIndex, expected, transcript: transcript ?? null, perWord: perWord || null } });
}

// Aggregate a child's recent reading: overall + recent-window accuracy, attempt
// count, and the words they most often miss (for the report and adaptation).
export function readingSummary(profileId, recentWindow = 40) {
  const rows = progressEvents(profileId, 'reading');
  const count = rows.length;
  const avg = count ? rows.reduce((s, r) => s + r.value, 0) / count : null;
  const recent = rows.slice(0, recentWindow);
  const recentAvg = recent.length ? recent.reduce((s, r) => s + r.value, 0) / recent.length : null;
  const miss = {};
  for (const r of recent) {
    const pw = r.data && r.data.perWord;
    if (!pw) continue;
    for (const w of pw) if (w && w.ok === false && w.word) miss[w.word] = (miss[w.word] || 0) + 1;
  }
  const missWords = Object.entries(miss).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([word, n]) => ({ word, n }));
  return { count, avg, recentAvg, recentCount: recent.length, missWords };
}

// Difficulty for the NEXT lesson: start from the child's set reading level, then
// nudge ±1 based on recent accuracy (consistently easy -> harder; struggling -> easier).
export function adaptiveReadingLevel(profileId, baseLabel) {
  let lvl = readingLevelNum(baseLabel);
  const { recentAvg, recentCount } = readingSummary(profileId);
  if (recentCount >= 5 && recentAvg != null) {
    if (recentAvg >= 0.9) lvl += 1;
    else if (recentAvg < 0.6) lvl -= 1;
  }
  return Math.max(1, Math.min(5, lvl));
}
