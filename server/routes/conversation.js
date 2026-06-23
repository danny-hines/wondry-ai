// A kid turn: transcript in -> input safety -> (affirmation? / intent?) -> chat reply OR
// kick off artifact generation. Recent conversation history is passed to chat, intent,
// and (for pronoun references like "make a page about that") topic resolution.
import express from 'express';
import { db, uid, now } from '../db.js';
import { runText, extractTopic } from '../services/providers.js';
import { checkInput } from '../services/safety.js';
import { startGeneration, createArtifact, getArtifact } from '../services/generator.js';
import { enabledTypes, isTypeEnabled } from '../content/registry.js';
import '../content/index.js'; // ensure content types are registered
import { getChatSystemPrompt, INTENT_SYSTEM_PROMPT, RESOLVE_TOPIC_SYSTEM_PROMPT } from '../services/systemPrompt.js';

export const router = express.Router();

const pendingOffers = new Map();       // conversationId -> { topic, at }
const OFFER_TTL = 10 * 60 * 1000;
const HISTORY_TURNS = 12;              // prior messages of context sent to the model

function activeConversation(profileId) {
  const recent = db.prepare(
    `SELECT * FROM conversations WHERE profile_id=? AND last_activity > ? ORDER BY last_activity DESC LIMIT 1`
  ).get(profileId, now() - 2 * 60 * 1000);
  if (recent) { db.prepare('UPDATE conversations SET last_activity=? WHERE id=?').run(now(), recent.id); return recent.id; }
  const id = uid();
  db.prepare('INSERT INTO conversations (id,profile_id,started_at,last_activity) VALUES (?,?,?,?)').run(id, profileId, now(), now());
  return id;
}
function conversationHistory(convId) {
  return db.prepare(
    `SELECT role, text FROM messages WHERE conversation_id=? AND text IS NOT NULL AND safety_flag=0 ORDER BY created_at DESC LIMIT ?`
  ).all(convId, HISTORY_TURNS).reverse().map((r) => ({ role: r.role === 'kid' ? 'user' : 'assistant', content: r.text }));
}
function addMessage(convId, profileId, role, text, kind = 'text', artifactId = null, flag = 0) {
  const id = uid();
  db.prepare(`INSERT INTO messages (id,conversation_id,profile_id,role,kind,text,artifact_id,safety_flag,created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(id, convId, profileId, role, kind, text, artifactId, flag, now());
  return id;
}

// The chat model is told to deflect grown-up/unsafe topics by redirecting to
// "something fun" (see DEFAULT_CHAT_SYSTEM_PROMPT). When it does, we must NOT
// offer to build a page about the topic the child actually asked about — the
// page offer keys off the raw question, which would be the deflected topic.
const looksDeflecting = (r) =>
  /\b(grown[- ]?up|ask (a|an|your) (grown|grown-up|adult|parent|teacher)|something (else|fun|different)|talk about something)\b/i.test(r || '');

const isAffirmation = (t) =>
  /^(yes|yeah|yep|yup|ya|yass+|sure|ok|okay|okey|please|yes please|yes plz|do it|build it|make it|i do|i would|sounds good|let'?s do it)\b/i.test((t || '').trim());

function isLearnable(text) {
  const p = (text || '').toLowerCase();
  if (/^(hi|hello|hey|yo|sup|howdy)\b/.test(p)) return false;
  if (/how('?s| is) it going|how are you|your name|who are you|good (morning|afternoon|evening)|thank|bye|love you|i'?m (good|fine|ok)/.test(p)) return false;
  if (/\b(time|what day|date)\b/.test(p)) return false;
  const topic = extractTopic(text);
  if (!topic || topic === 'something fun' || topic.length < 3) return false;
  return /\b(how|what|why|where|when|who|tell me|explain|teach|learn|about|made|work)\b/.test(p);
}

// Concrete topic for an artifact request. If the request is a bare reference ("that",
// "it"), resolve it from conversation history; otherwise just use the extracted topic.
async function resolveTopic(text, history) {
  const t = extractTopic(text);
  const isRef = !t || t === 'something fun' || t.length < 3 || /^(that|it|this|those|these|them|one|stuff)$/i.test(t);
  if (!isRef) return t;
  try {
    const r = (await runText('resolve', { system: RESOLVE_TOPIC_SYSTEM_PROMPT, prompt: text, history }) || '').trim();
    const cleaned = r.split('\n')[0].replace(/^["']+|["'.]+$/g, '').trim().slice(0, 60);
    return cleaned || t;
  } catch { return t; }
}

async function startArtifactTurn(convId, profile, topic, reply) {
  const artifactId = await startGeneration({ topic, profile, source: 'on_demand' });
  addMessage(convId, profile.id, 'avatar', reply, 'artifact', artifactId);
  return { kind: 'artifact', reply, artifactId, artifact: getArtifact(artifactId) };
}

router.post('/turn', async (req, res) => {
  const { profileId, text } = req.body || {};
  const profile = db.prepare('SELECT * FROM profiles WHERE id=?').get(profileId);
  if (!profile) return res.status(400).json({ error: 'unknown profile' });
  if (!text || !text.trim()) return res.status(400).json({ error: 'empty input' });

  const convId = activeConversation(profileId);
  const history = conversationHistory(convId);   // BEFORE adding the current message
  const safety = checkInput(text, profile);
  if (safety.verdict === 'block') {
    addMessage(convId, profileId, 'kid', text, 'text', null, 1);
    addMessage(convId, profileId, 'avatar', safety.deflection);
    return res.json({ kind: 'chat', reply: safety.deflection, blocked: true });
  }
  addMessage(convId, profileId, 'kid', text);

  // 1) "yes" to a recent offer -> build the topic we offered
  const pend = pendingOffers.get(convId);
  if (isAffirmation(text) && pend && now() - pend.at < OFFER_TTL) {
    pendingOffers.delete(convId);
    return res.json(await startArtifactTurn(convId, profile, pend.topic, `Yay! Let me make you a page about ${pend.topic}!`));
  }

  // 1.5) does an enabled content type claim this utterance? (reading, flashcards,
  // games…) Each type's matchIntent inspects the text and returns params or null.
  // Skip types turned off globally or for this specific child.
  const offForKid = new Set((profile.disabled_types || '').split(',').map((s) => s.trim()).filter(Boolean));
  for (const type of enabledTypes()) {
    if (offForKid.has(type.id) || !type.matchIntent) continue;
    const params = type.matchIntent(text);
    if (!params) continue;
    pendingOffers.delete(convId);
    const reply = type.intentReply ? type.intentReply(params) : "Okay, let's go!";
    const artifactId = await createArtifact({ typeId: type.id, params, profile, source: 'on_demand' });
    addMessage(convId, profile.id, 'avatar', reply, 'artifact', artifactId);
    return res.json({ kind: 'artifact', reply, artifactId, artifact: getArtifact(artifactId) });
  }

  // 2) explicit request to build a page? (intent sees history; topic resolves references)
  let intent = 'chat';
  try { intent = (JSON.parse(await runText('intent', { system: INTENT_SYSTEM_PROMPT, prompt: text, history })).intent) || 'chat'; }
  catch { intent = /\b(make|build|show|create|draw) (me )?(a |an )?(page|game|lesson|quiz|story|activity|picture)/i.test(text) ? 'artifact' : 'chat'; }
  if (intent === 'artifact' && isTypeEnabled('page') && !offForKid.has('page')) {
    pendingOffers.delete(convId);
    const topic = await resolveTopic(text, history);
    return res.json(await startArtifactTurn(convId, profile, topic, 'Ooh, let me build you something cool about that!'));
  }

  // 3) plain spoken answer (with history); offer a page only for explorable questions
  let reply = (await runText('chat', { system: getChatSystemPrompt(profile), prompt: text, history }) || '').trim();
  if (isLearnable(text) && !looksDeflecting(reply)) {
    pendingOffers.set(convId, { topic: extractTopic(text), at: now() });
    if (!/\bmake you a page\b/i.test(reply)) reply += ' Want me to make you a page about it?';
  } else {
    pendingOffers.delete(convId);
  }
  addMessage(convId, profileId, 'avatar', reply);
  res.json({ kind: 'chat', reply });
});

export default router;
