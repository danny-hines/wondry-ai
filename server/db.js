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
