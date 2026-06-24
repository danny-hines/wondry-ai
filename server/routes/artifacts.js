// Artifact tray + engagement + the CSP-sandboxed serving route.
import express from 'express';
import fs from 'node:fs';
import { db, now } from '../db.js';
import { getArtifact, artifactPath, getContent } from '../services/generator.js';
import { mediaFile } from '../media/store.js';
import { getType, manifests } from '../content/registry.js';
import { sttAvailable, sttBackend, transcribe } from '../services/stt.js';
import '../content/index.js'; // ensure content types are registered

export const router = express.Router();

// Tray list for a child: artifacts published to them (audience), with seen state.
router.get('/artifacts', (req, res) => {
  const profileId = req.query.profileId || '';
  const rows = db.prepare(`
    SELECT a.*, COALESCE(e.seen,0) AS seen, COALESCE(e.finished,0) AS finished
    FROM artifacts a
    JOIN artifact_audience aud ON aud.artifact_id=a.id AND aud.profile_id=?
    LEFT JOIN engagement e ON e.artifact_id=a.id AND e.profile_id=?
    WHERE a.status IN ('ready','generating')
    ORDER BY a.created_at DESC`).all(profileId, profileId);
  const unseen = rows.filter((r) => r.status === 'ready' && !r.seen).length;
  res.json({ artifacts: rows, unseen });
});

router.get('/artifacts/:id', (req, res) => {
  const a = getArtifact(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json(a);
});

router.post('/artifacts/:id/seen', (req, res) => {
  const { profileId } = req.body || {};
  db.prepare(`INSERT INTO engagement (artifact_id,profile_id,seen) VALUES (?,?,1)
              ON CONFLICT(artifact_id,profile_id) DO UPDATE SET seen=1`).run(req.params.id, profileId);
  res.json({ ok: true });
});

router.post('/artifacts/:id/opened', (req, res) => {
  const { profileId } = req.body || {};
  db.prepare(`INSERT INTO engagement (artifact_id,profile_id,seen,opened,opened_at) VALUES (?,?,1,1,?)
              ON CONFLICT(artifact_id,profile_id) DO UPDATE SET seen=1, opened=1, opened_at=?`)
    .run(req.params.id, profileId, now(), now());
  res.json({ ok: true });
});

router.post('/artifacts/:id/finished', (req, res) => {
  const { profileId } = req.body || {};
  db.prepare(`INSERT INTO engagement (artifact_id,profile_id,seen,opened,finished) VALUES (?,?,1,1,1)
              ON CONFLICT(artifact_id,profile_id) DO UPDATE SET finished=1`).run(req.params.id, profileId);
  res.json({ ok: true });
});

// --- Structured content (native + declarative types) ---
// Manifests for the admin console (create forms, enable/disable).
router.get('/content-types', (req, res) => res.json({ types: manifests() }));

// Fetch a content type's structured JSON (reading lesson, flashcard deck, game
// config, …). Rendered natively by the kiosk, so the shell owns the interaction.
router.get('/content/:id', (req, res) => {
  const a = getArtifact(req.params.id);
  if (!a || a.status !== 'ready') return res.status(404).json({ error: 'not ready' });
  const content = getContent(req.params.id);
  if (!content) return res.status(404).json({ error: 'missing content' });
  res.json({ id: a.id, type: a.type, ...content });
});

// Record a scored interaction (e.g. a reading line, a quiz answer). The content
// type interprets the event and persists it to progress_events.
router.post('/content/:id/event', (req, res) => {
  const { profileId, event } = req.body || {};
  const a = getArtifact(req.params.id);
  if (!a || !profileId) return res.status(400).json({ error: 'need artifact + profileId' });
  const type = getType(a.type);
  if (type && type.recordEvent) type.recordEvent({ artifactId: a.id, profileId, event });
  res.json({ ok: true });
});

// Serve a baked media image same-origin (cached at generation time from a trusted
// source). Long-lived cache: media ids are immutable.
router.get('/media/:id', (req, res) => {
  const m = mediaFile(req.params.id);
  if (!m) return res.status(404).send('Not found');
  res.setHeader('Content-Type', m.mime);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(m.path);
});

// Speech-to-text endpoint. Transcribes posted audio via whisper.cpp when configured
// (WHISPER_HTTP_URL or WHISPER_CMD+WHISPER_MODEL); otherwise returns available:false
// so the client falls back to the browser's Web Speech API. The browser posts the
// captured audio as the raw request body with its audio/* content-type.
router.post('/stt', express.raw({ type: ['application/octet-stream', 'audio/*'], limit: '12mb' }), async (req, res) => {
  if (!sttAvailable()) {
    return res.json({ text: '', backend: 'none', available: false,
      note: 'Server STT not configured on this host; client uses the browser Web Speech fallback.' });
  }
  try {
    const mime = req.headers['content-type'] || 'audio/wav';
    const { text } = await transcribe(req.body, { mime });
    res.json({ text: text || '', backend: sttBackend(), available: true });
  } catch (e) {
    res.json({ text: '', backend: sttBackend(), available: false, error: String(e.message || e) });
  }
});

// The sandbox: serve artifact HTML same-origin under a strict CSP that lets the
// page call our own endpoints but makes it physically unable to reach the web.
router.get('/artifact/:id', (req, res) => {
  const a = getArtifact(req.params.id);
  if (!a || a.status !== 'ready') return res.status(404).send('Not ready');
  const p = artifactPath(req.params.id);
  if (!fs.existsSync(p)) return res.status(404).send('Missing file');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; " +
    "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
  res.send(injectTouchBase(fs.readFileSync(p, 'utf8')));
});

// Generated pages rarely include touch affordances, so give them a baseline: snappy
// taps (no double-tap-zoom / 300ms delay) and a generic pressed state on tappable
// things. Conservative (brightness only — no layout-shifting transforms). CSP already
// permits this inline style.
const TOUCH_BASE = '<style>*{touch-action:manipulation;-webkit-tap-highlight-color:transparent}'
  + 'button:active,a:active,[role=button]:active,[onclick]:active,summary:active,label:active,.btn:active,.card:active,.tile:active{filter:brightness(.9)}</style>';
function injectTouchBase(html) {
  if (html.includes('</head>')) return html.replace('</head>', TOUCH_BASE + '</head>');
  const m = html.match(/<body[^>]*>/i);
  if (m) return html.replace(m[0], m[0] + TOUCH_BASE);
  return TOUCH_BASE + html;
}

export default router;
