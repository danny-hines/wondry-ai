// Text-to-speech: POST /api/tts -> audio/wav.
// Voice precedence: explicit `voice` (admin preview) > the child's profile voice > default.
// GET /api/voices -> installed voice list (for the admin per-kid dropdown).
import express from 'express';
import { db } from '../db.js';
import { synthesize, ttsAvailable, listVoices } from '../services/tts.js';

export const router = express.Router();

router.get('/voices', (req, res) => {
  res.json({ voices: listVoices(), available: ttsAvailable() });
});

router.post('/tts', async (req, res) => {
  const { text, profileId, voice } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'no text' });
  if (!ttsAvailable()) return res.status(503).json({ error: 'tts not configured' });
  let v = voice || null;
  if (!v && profileId) {
    const p = db.prepare('SELECT voice FROM profiles WHERE id=?').get(profileId);
    v = p && p.voice;
  }
  try {
    const wav = await synthesize(String(text).slice(0, 800), v);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    res.send(wav);
  } catch (e) {
    res.status(503).json({ error: String((e && e.message) || e) });
  }
});

export default router;
