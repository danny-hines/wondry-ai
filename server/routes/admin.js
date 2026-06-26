// Parental/admin portal API. Password-gated.
import express from 'express';
import fs from 'node:fs';
import { db, uid, now, getKV, setKV, setAudience, audienceFor, readingSummary, usageSince, usageByModel, costByArtifact, listEvals, evalSummary, addPromptVersion, promptVersions, latestPromptVersion, recordEvalRun, evalRuns, runSummary, listRunEvals, faceClustersForConsole, setFaceClusterProfile, deleteFaceCluster, releaseFaceClustersForProfile } from '../db.js';
import { ADMIN_PASSWORD, getConfig, getRichness, liveGenerationEnabled } from '../config.js';
import { selectedTierId, dailyCap } from '../services/richness.js';
import { startGeneration, startReadingGeneration, createArtifact, getArtifact, artifactPath } from '../services/generator.js';
import { runContentEvals, runMatrixEvals, runReadingMatrixEvals, runChatEvals, runChatHistoryEvals } from '../services/evalRunner.js';
import { EVAL_DIMS } from '../services/evalJudge.js';
import { suggestPromptImprovement, currentPromptHash, promptKeyForKind } from '../services/evalSuggest.js';
import { getType, manifests, setTypeEnabled } from '../content/registry.js';
import { getWakeConfig, setWakeConfig } from '../services/wake.js';
import { getTimezone, setTimezone, detectedTimezone, supportedTimezones } from '../services/timezone.js';
import '../content/index.js'; // ensure content types are registered
import {
  getArtifactSystemPrompt, DEFAULT_ARTIFACT_SYSTEM_PROMPT,
  getChatSystemPromptRaw, DEFAULT_CHAT_SYSTEM_PROMPT,
  getReadingSystemPrompt, DEFAULT_READING_SYSTEM_PROMPT,
} from '../services/systemPrompt.js';
import { emit } from '../events.js';

export const router = express.Router();

router.post('/login', (req, res) => {
  if ((req.body || {}).password === ADMIN_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false });
});

router.use((req, res, next) => {
  if (req.headers['x-admin-password'] === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'unauthorized' });
});

router.get('/log', (req, res) => {
  const messages = db.prepare(`
    SELECT m.*, p.name AS profile_name, p.initials, p.color, a.title AS artifact_title, a.status AS artifact_status
    FROM messages m
    JOIN profiles p ON p.id=m.profile_id
    LEFT JOIN artifacts a ON a.id=m.artifact_id
    ORDER BY m.created_at DESC LIMIT 200`).all();
  const safety = db.prepare('SELECT * FROM safety_log ORDER BY created_at DESC LIMIT 100').all();
  res.json({ messages, safety });
});

router.get('/artifacts', (req, res) => {
  const arts = db.prepare(`
    SELECT a.*, p.name AS profile_name FROM artifacts a
    LEFT JOIN profiles p ON p.id=a.profile_id
    WHERE a.source != 'eval'
    ORDER BY a.created_at DESC LIMIT 200`).all();
  const costs = costByArtifact(arts.map((a) => a.id));
  for (const a of arts) { a.audience = audienceFor(a.id); a.cost = costs[a.id] || 0; }
  const kids = db.prepare("SELECT id,name,initials,color FROM profiles ORDER BY name").all();
  res.json({ artifacts: arts, kids });
});

router.post('/artifacts/:id/audience', (req, res) => {
  const { profileId, on } = req.body || {};
  const a = getArtifact(req.params.id);
  if (!a || !profileId) return res.status(400).json({ error: 'need artifact + profileId' });
  setAudience(req.params.id, profileId, !!on);
  if (on && a.status === 'ready') emit('artifact.completed', { artifact: a, announce: true });
  res.json({ ok: true, audience: audienceFor(req.params.id) });
});

router.post('/artifacts/:id/delete', (req, res) => {
  const id = req.params.id;
  db.prepare('UPDATE messages SET artifact_id=NULL WHERE artifact_id=?').run(id);
  db.prepare('DELETE FROM engagement WHERE artifact_id=?').run(id);
  db.prepare('DELETE FROM artifact_audience WHERE artifact_id=?').run(id);
  db.prepare('DELETE FROM artifacts WHERE id=?').run(id);
  try { fs.rmSync(artifactPath(id)); } catch {}
  res.json({ ok: true });
});

router.post('/author', async (req, res) => {
  const { topic } = req.body || {};
  if (!topic || !topic.trim()) return res.status(400).json({ error: 'need topic' });
  const id = await startGeneration({ topic, profile: null, source: 'parent', audience: [] });
  res.json({ ok: true, artifactId: id });
});

// Author a reading-practice lesson. Optional `profileId` tailors the lesson to a
// child (interests + adapted level); otherwise a neutral lesson held for review.
router.post('/author-reading', async (req, res) => {
  const { interest, level, profileId } = req.body || {};
  const profile = profileId ? db.prepare('SELECT * FROM profiles WHERE id=?').get(profileId) : null;
  const id = await startReadingGeneration({
    profile, source: 'parent', audience: [],
    interest: (interest && String(interest).trim()) || undefined,
    level: Number(level) || undefined,
  });
  res.json({ ok: true, artifactId: id });
});

// Content-type registry for the console: manifests + global enable/disable.
router.get('/content-types', (req, res) => res.json({ types: manifests() }));
router.post('/content-types/:id', (req, res) => {
  const type = getType(req.params.id);
  if (!type) return res.status(404).json({ error: 'unknown content type' });
  setTypeEnabled(req.params.id, !!(req.body || {}).enabled);
  res.json({ ok: true });
});

// Generic authoring for any registered, authorable content type. Optional
// `profileId` tailors generation to a child (interests/level); the result is held
// for review under Pages. params are the type's createForm fields.
router.post('/content', async (req, res) => {
  const { typeId, params, profileId, richness } = req.body || {};
  const type = getType(typeId);
  if (!type) return res.status(400).json({ error: 'unknown content type' });
  const profile = profileId ? db.prepare('SELECT * FROM profiles WHERE id=?').get(profileId) : null;
  const id = await createArtifact({ typeId, params: params || {}, profile, source: 'parent', audience: [], richness: richness || undefined });
  res.json({ ok: true, artifactId: id });
});

// Estimated API usage + cost (from config.json per-model prices). today = since
// local midnight; week/month are rolling windows; lifetime is everything.
router.get('/usage', (req, res) => {
  const day = 86400000, t = now();
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  res.json({
    today: usageSince(midnight.getTime()),
    week: usageSince(t - 7 * day),
    month: usageSince(t - 30 * day),
    lifetime: usageSince(0),
    byModelMonth: usageByModel(t - 30 * day),
  });
});

// --- evals (AI-judge quality scores, by kind: page / reading / chat) ---
// A single in-flight batch; the Evals tab polls GET /evals for its status + results.
const EVAL_KINDS = ['page', 'reading', 'chat'];
let evalJob = { running: false, mode: null, kind: null, progress: null, lastResult: null, error: null };

router.get('/evals', (req, res) => {
  const kind = EVAL_KINDS.includes(req.query.kind) ? req.query.kind : 'page';
  // For chat-history scoping: when the chat prompt last changed (real replies before
  // this were made under an older prompt, so they're out of scope).
  const promptChangedAt = kind === 'chat' ? (latestPromptVersion('chat_system_prompt')?.created_at ?? null) : undefined;
  // Latest run, with the previous run OF THE SAME MODE for a meaningful before/after Δ
  // (benchmark vs benchmark, live vs live — same-mode runs judge comparable inputs).
  const runs = evalRuns(kind, 50);
  const latest = runs[0] || null;
  const prev = latest ? runs.find((r) => r.id !== latest.id && r.mode === latest.mode) : null;
  const latestRun = latest ? {
    batch: latest.id, mode: latest.mode, when: latest.created_at,
    promptHash: latest.prompt_hash,
    promptMatches: latest.prompt_hash ? latest.prompt_hash === currentPromptHash(kind) : null,
    summary: runSummary(latest.id),
    prevSummary: prev ? runSummary(prev.id) : null, prevWhen: prev ? prev.created_at : null,
  } : null;
  res.json({
    kind, dims: EVAL_DIMS[kind],
    evals: latest ? listRunEvals(kind, latest.id, 300) : [],   // the latest run's items (weakest first)
    allEvals: listEvals(kind, 300),                            // all-time latest-per-target (the "All" view)
    allTime: evalSummary(kind),
    latestRun,
    job: evalJob, live: liveGenerationEnabled(), promptChangedAt,
  });
});

// Kick off a run in the background (runs can be long). mode: 'benchmark' (reproducible
// sample — matrix for page/reading, suite for chat) or 'live' (judge real outputs —
// existing artifacts, or logged chat replies). reeval re-scores within the live set.
router.post('/evals/run', (req, res) => {
  if (evalJob.running) return res.status(409).json({ error: 'an eval run is already in progress' });
  if (!liveGenerationEnabled()) return res.status(400).json({ error: 'no API key set — the judge needs a live model' });
  const { mode, kind, reeval } = req.body || {};
  const k = EVAL_KINDS.includes(kind) ? kind : 'page';
  const isBench = mode === 'benchmark';
  const runMode = isBench ? 'benchmark' : 'live';
  const batch = `${runMode}-${k}-${Date.now()}`;
  // Stamp the prompt the outputs are produced under so suggestions can be gated to it:
  // benchmark generates fresh under the current prompt; chat 'live' judges replies made
  // since the last prompt change (also current). Live content judges pre-existing
  // artifacts of mixed/unknown prompt → no hash.
  recordEvalRun({ id: batch, kind: k, mode: runMode, promptKey: promptKeyForKind(k), promptHash: (isBench || k === 'chat') ? currentPromptHash(k) : null });

  const onProgress = (p) => { evalJob.progress = p; };
  evalJob = { running: true, mode: runMode, kind: k, progress: null, lastResult: null, error: null };
  const run = isBench
    ? (k === 'chat' ? runChatEvals({ batch, onProgress })
      : k === 'reading' ? runReadingMatrixEvals({ batch, onProgress })
        : runMatrixEvals({ batch, concurrency: 3, onProgress }))
    : (k === 'chat' ? runChatHistoryEvals({ batch, reeval: !!reeval, limit: 100, onProgress })
      : runContentEvals({ kind: k, batch, reeval: !!reeval, limit: 200, onProgress }));
  run.then((r) => { evalJob = { running: false, mode: runMode, kind: k, progress: null, lastResult: r, error: null }; })
    .catch((e) => { evalJob = { running: false, mode: runMode, kind: k, progress: null, lastResult: null, error: String(e?.message || e) }; });
  res.json({ started: true });
});

// Close the loop: propose a minimal revision to this kind's system prompt from the
// recent judge scores + issues. One model call; the console diffs it and the parent
// accepts (saved as an 'eval'-authored prompt version, revertible from Settings).
router.post('/evals/suggest', async (req, res) => {
  if (!liveGenerationEnabled()) return res.status(400).json({ error: 'no API key set — suggestions need a live model' });
  const kind = EVAL_KINDS.includes((req.body || {}).kind) ? req.body.kind : 'page';
  try { res.json(await suggestPromptImprovement(kind)); }
  catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

// Per-child reading progress for the parent report.
router.get('/reading-report', (req, res) => {
  const kids = db.prepare('SELECT id,name,initials,color,reading_level FROM profiles ORDER BY name').all();
  const report = kids.map((k) => ({ ...k, ...readingSummary(k.id) }));
  res.json({ report });
});

router.get('/profiles', (req, res) => {
  res.json({ profiles: db.prepare('SELECT * FROM profiles ORDER BY name').all() });
});

router.post('/profiles', (req, res) => {
  const { id, name, initials, color, age, reading_level, voice, persona, theme, interests, disabledTypes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const th = theme === 'dark' ? 'dark' : 'light';
  const disabled = Array.isArray(disabledTypes) ? disabledTypes.join(',') : undefined;
  if (id && db.prepare('SELECT 1 FROM profiles WHERE id=?').get(id)) {
    db.prepare('UPDATE profiles SET name=?,initials=?,color=?,age=?,reading_level=?,voice=?,persona=?,theme=?,interests=?,disabled_types=COALESCE(?,disabled_types) WHERE id=?')
      .run(name, initials, color, age ?? null, reading_level ?? null, voice ?? null, persona ?? null, th, interests ?? null, disabled ?? null, id);
    return res.json({ ok: true, id });
  }
  const newId = id || uid();
  db.prepare('INSERT INTO profiles (id,name,initials,color,age,reading_level,voice,persona,theme,interests,disabled_types,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(newId, name, initials || name.slice(0, 2).toUpperCase(), color || '#8b5cf6', age ?? null, reading_level ?? null, voice ?? null, persona ?? null, th, interests ?? null, disabled ?? null, now());
  res.json({ ok: true, id: newId });
});

router.post('/profiles/:id/delete', (req, res) => {
  const id = req.params.id;
  const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(id);
  if (!p) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE artifacts SET profile_id=NULL WHERE profile_id=?').run(id);
  db.prepare('DELETE FROM artifact_audience WHERE profile_id=?').run(id);
  db.prepare('DELETE FROM engagement WHERE profile_id=?').run(id);
  db.prepare('DELETE FROM messages WHERE profile_id=?').run(id);
  db.prepare('DELETE FROM conversations WHERE profile_id=?').run(id);
  db.prepare('DELETE FROM safety_log WHERE profile_id=?').run(id);
  releaseFaceClustersForProfile(id);   // release enrolled faces back to 'pending' (FK + keep the faces)
  db.prepare('DELETE FROM profiles WHERE id=?').run(id);
  res.json({ ok: true });
});

// --- Familiar faces: parent reviews clusters of look-alike faces and maps each to a
// child (or ignores strangers). The clusters themselves come from the vision sidecar. ---
router.get('/faces', (req, res) => {
  res.json({
    enabled: getKV('faces_enabled', '0') === '1',
    clusters: faceClustersForConsole(2),   // hide single-frame noise; assigned shown regardless
    kids: db.prepare('SELECT id,name,initials,color FROM profiles ORDER BY name').all(),
  });
});
router.post('/faces/clusters/:id/assign', (req, res) => {
  const { profileId } = req.body || {};
  if (!profileId || !db.prepare('SELECT 1 FROM profiles WHERE id=?').get(profileId)) return res.status(400).json({ error: 'unknown profile' });
  setFaceClusterProfile(req.params.id, profileId, 'assigned');
  res.json({ ok: true });
});
router.post('/faces/clusters/:id/ignore', (req, res) => { setFaceClusterProfile(req.params.id, null, 'ignored'); res.json({ ok: true }); });
router.post('/faces/clusters/:id/unassign', (req, res) => { setFaceClusterProfile(req.params.id, null, 'pending'); res.json({ ok: true }); });
router.post('/faces/clusters/:id/delete', (req, res) => { deleteFaceCluster(req.params.id); res.json({ ok: true }); });

// --- Config: editable chat + artifact system prompts; read-only routing view ---
router.get('/config', (req, res) => {
  const cfg = getConfig();
  const r = getRichness();
  res.json({
    systemPrompt: getArtifactSystemPrompt(),
    defaultSystemPrompt: DEFAULT_ARTIFACT_SYSTEM_PROMPT,
    chatSystemPrompt: getChatSystemPromptRaw(),
    defaultChatSystemPrompt: DEFAULT_CHAT_SYSTEM_PROMPT,
    readingSystemPrompt: getReadingSystemPrompt(),
    defaultReadingSystemPrompt: DEFAULT_READING_SYSTEM_PROMPT,
    routing: cfg.routing,
    providers: Object.keys(cfg.providers),
    liveGeneration: liveGenerationEnabled(),
    wake: getWakeConfig(),
    facesEnabled: getKV('faces_enabled', '0') === '1',
    kioskPin: getKV('kiosk_pin', '0000'),
    // Scheduling clock: the configured zone, the OS-detected default, the full IANA
    // list for the picker, and current server time so a skewed OS clock is visible.
    timezone: getTimezone(),
    detectedTimezone: detectedTimezone(),
    timezones: supportedTimezones(),
    serverTime: Date.now(),
    richness: {
      selected: selectedTierId(),
      default: r.default || 'standard',
      dailyCap: dailyCap(),
      tiers: Object.entries(r.tiers || {}).map(([id, t]) => ({
        id, label: t.label || id, description: t.description || '', provider: t.provider, maxTokens: t.maxTokens,
      })),
    },
  });
});

// Editable prompts that keep a version history (config field -> KV key).
const PROMPT_FIELDS = { systemPrompt: 'artifact_system_prompt', chatSystemPrompt: 'chat_system_prompt', readingSystemPrompt: 'reading_system_prompt' };

router.get('/prompt-history', (req, res) => {
  const key = req.query.key;
  if (!Object.values(PROMPT_FIELDS).includes(key)) return res.status(400).json({ error: 'unknown prompt key' });
  res.json({ versions: promptVersions(key, 50) });
});

router.post('/config', (req, res) => {
  const { richness, dailyCap: cap, wake, facesEnabled, kioskPin, timezone, promptAuthor } = req.body || {};
  // Save each prompt to KV (the live value) and append a history entry (deduped).
  const author = promptAuthor === 'eval' ? 'eval' : 'parent';
  for (const [field, key] of Object.entries(PROMPT_FIELDS)) {
    const val = req.body[field];
    if (typeof val === 'string') { setKV(key, val); addPromptVersion({ key, value: val, author }); }
  }
  if (typeof richness === 'string' && (getRichness().tiers || {})[richness]) setKV('content_richness', richness);
  if (cap !== undefined && cap !== null && cap !== '') setKV('richness_daily_cap', String(Math.max(0, parseInt(cap, 10) || 0)));
  if (wake && typeof wake === 'object') setWakeConfig(wake);
  if (typeof facesEnabled === 'boolean') setKV('faces_enabled', facesEnabled ? '1' : '0');
  if (typeof kioskPin === 'string' && /^\d{4}$/.test(kioskPin)) setKV('kiosk_pin', kioskPin);
  if (typeof timezone === 'string') { try { setTimezone(timezone); } catch { return res.status(400).json({ error: 'invalid timezone' }); } }
  res.json({ ok: true });
});

export default router;
