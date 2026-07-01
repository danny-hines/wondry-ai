// Text-to-speech: POST /api/tts -> audio/wav.
// Voice precedence: explicit `voice` (admin preview) > the child's profile voice > default.
// GET /api/voices -> installed voice list (for the admin per-kid dropdown).
import express from 'express';
import { db } from '../db.js';
import {
  synthesize,
  ttsAvailable,
  listVoices,
  BROWSER_VOICE,
  espeakAvailable,
  synthViaEspeak,
} from '../services/tts.js';

export const router = express.Router();

router.get('/voices', (req, res) => {
  res.json({ voices: listVoices(), available: ttsAvailable(), browserVoice: BROWSER_VOICE });
});

router.post('/tts', async (req, res) => {
  const { text, profileId, voice } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'no text' });
  let v = voice || null;
  if (!v && profileId) {
    const p = db.prepare('SELECT voice FROM profiles WHERE id=?').get(profileId);
    v = p && p.voice;
  }
  // Robot voice: synthesize server-side with espeak-ng (real WAV → reliable audio +
  // avatar lip-sync). If espeak-ng isn't installed (e.g. a dev laptop), fall back to
  // a 204 so the client speaks it via the browser's SpeechSynthesis. Handled before
  // the ttsAvailable guard so the Robot voice works with no Piper installed.
  if (v === BROWSER_VOICE) {
    if (espeakAvailable()) {
      try {
        const wav = await synthViaEspeak(String(text).slice(0, 800));
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Cache-Control', 'no-store');
        return res.send(wav);
      } catch {
        /* fall through to the browser fallback below */
      }
    }
    res.setHeader('X-TTS-Mode', 'browser');
    return res.status(204).end();
  }
  if (!ttsAvailable()) return res.status(503).json({ error: 'tts not configured' });
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
