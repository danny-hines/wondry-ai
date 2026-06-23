// Parental/admin portal API. Password-gated.
import express from 'express';
import fs from 'node:fs';
import { db, uid, now, setKV, setAudience, audienceFor, readingSummary, usageSince, usageByModel, costByArtifact } from '../db.js';
import { ADMIN_PASSWORD, getConfig, getRichness, liveGenerationEnabled } from '../config.js';
import { selectedTierId, dailyCap } from '../services/richness.js';
import { startGeneration, startReadingGeneration, createArtifact, getArtifact, artifactPath } from '../services/generator.js';
import { getType, manifests, setTypeEnabled } from '../content/registry.js';
import { getWakeConfig, setWakeConfig } from '../services/wake.js';
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
  db.prepare('DELETE FROM profiles WHERE id=?').run(id);
  res.json({ ok: true });
});

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

router.post('/config', (req, res) => {
  const { systemPrompt, chatSystemPrompt, readingSystemPrompt, richness, dailyCap: cap, wake } = req.body || {};
  if (typeof systemPrompt === 'string') setKV('artifact_system_prompt', systemPrompt);
  if (typeof chatSystemPrompt === 'string') setKV('chat_system_prompt', chatSystemPrompt);
  if (typeof readingSystemPrompt === 'string') setKV('reading_system_prompt', readingSystemPrompt);
  if (typeof richness === 'string' && (getRichness().tiers || {})[richness]) setKV('content_richness', richness);
  if (cap !== undefined && cap !== null && cap !== '') setKV('richness_daily_cap', String(Math.max(0, parseInt(cap, 10) || 0)));
  if (wake && typeof wake === 'object') setWakeConfig(wake);
  res.json({ ok: true });
});

export default router;
