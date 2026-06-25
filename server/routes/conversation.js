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
import { getChatSystemPrompt, INTENT_SYSTEM_PROMPT, RESOLVE_TOPIC_SYSTEM_PROMPT, TOPIC_SAFETY_PROMPT } from '../services/systemPrompt.js';
import { parseTimer, formatDuration } from '../services/timerParse.js';
import { parseReminder } from '../services/reminderParse.js';
import { startTimer, startReminder, cancelSchedule, listActiveTimers, listActiveSchedules } from '../services/scheduler.js';
import { nextEpochForLocalTime, formatWhen, getTimezone, describeNow } from '../services/timezone.js';

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
// "it") or vague, resolve it from history; otherwise use the extracted topic. The model
// sometimes replies conversationally to a vague request ("I'd be happy to, but…") — we
// reject that so a clarification sentence never becomes the page title/subject.
async function resolveTopic(text, history) {
  const t = extractTopic(text);
  const isRef = !t || t === 'something fun' || t.length < 3 || /^(that|it|this|those|these|them|one|stuff)$/i.test(t);
  if (!isRef) return t;
  try {
    const r = (await runText('resolve', { system: RESOLVE_TOPIC_SYSTEM_PROMPT, prompt: text, history }) || '').trim();
    const cleaned = r.split('\n')[0].replace(/^["'.\s]+|["'.\s]+$/g, '').trim();
    const conversational = cleaned.length > 40 || cleaned.split(/\s+/).length > 6 || /[?!]/.test(cleaned)
      || /\b(i|i'?d|i'?m|sorry|but|need|understand|happy|can'?t|cannot|could you|what kind)\b/i.test(cleaned);
    if (cleaned && !conversational) return cleaned;
  } catch { /* fall through */ }
  return 'something fun';   // unresolvable/vague → a clean generic, never a garbled phrase
}

// Topic-appropriateness gate for content generation. The chat model already deflects
// sensitive topics; this applies the same judgment to "make me a page about X / it",
// which otherwise bypasses it (the keyword checkInput misses things like "the Holocaust").
async function topicAppropriate(topic, profile) {
  try {
    const r = (await runText('safety', { system: TOPIC_SAFETY_PROMPT(profile?.age), prompt: `Topic: ${topic}` }) || '').trim().toLowerCase();
    return r.startsWith('y');                 // clear "yes" allows; anything else blocks
  } catch { return true; }                    // fail open — chat deflection + output scan back this up
}
const TOPIC_DEFLECTION = "Hmm, that's a big topic to explore with a grown-up. Want me to make something fun instead — like animals, space, or a story?";

async function startArtifactTurn(convId, profile, topic, reply) {
  const artifactId = await startGeneration({ topic, profile, source: 'on_demand' });
  addMessage(convId, profile.id, 'avatar', reply, 'artifact', artifactId);
  return { kind: 'artifact', reply, artifactId, artifact: getArtifact(artifactId) };
}

// Timer + reminder responders, shared by the fast-path regex and the LLM intent
// fallback so both produce identical behavior. Each creates the schedule (the
// scheduler fires it over WS later), records the avatar line, and sends the turn.
const TIMER_MIN_MS = 3000, TIMER_MAX_MS = 6 * 3600000;
function respondTimer(res, convId, profileId, durationMs, label) {
  durationMs = Math.max(TIMER_MIN_MS, Math.min(TIMER_MAX_MS, Math.round(durationMs)));
  const timer = startTimer({ durationMs, label: label || null, createdBy: 'voice' });
  const pretty = formatDuration(durationMs);
  const reply = label
    ? `Okay! I'll remind you to ${label} in ${pretty}.`
    : `Okay! Timer set for ${pretty}. I'll let you know when it's done!`;
  addMessage(convId, profileId, 'avatar', reply, 'text');
  return res.json({ kind: 'timer', reply, timer });
}
// Returns the sent response, or null if no concrete future time could be resolved
// (so the caller falls through to chat).
const WEEKDAY_ABBR = { sunday: 'Sun', monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat' };
function normalizeDay(d) {
  if (!d) return null;
  const s = String(d).toLowerCase();
  if (s === 'today') return null;                    // resolver treats null as today
  if (s === 'tomorrow') return 'tomorrow';
  if (WEEKDAY_ABBR[s]) return WEEKDAY_ABBR[s];
  return Object.values(WEEKDAY_ABBR).find((a) => a.toLowerCase() === s) || null;  // already an abbrev
}
function respondReminder(res, convId, profileId, req) {
  const tz = getTimezone();
  const fireAt = nextEpochForLocalTime({ ...req, day: normalizeDay(req.day) }, tz);
  if (fireAt == null) return null;
  const reminder = startReminder({ fireAt, message: req.message || null, createdBy: 'voice' });
  const when = formatWhen(fireAt, tz);
  const reply = req.message
    ? `Okay! I'll remind you to ${req.message} ${when}.`
    : `Okay! Alarm set for ${when}.`;
  addMessage(convId, profileId, 'avatar', reply, 'text');
  return res.json({ kind: 'reminder', reply, reminder });
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

  // 1.2) timer? "set a timer for 5 minutes", "cancel my timer". Handled here (not as
  // a content type — a timer renders no page) and ahead of artifact intent so "set a
  // timer" never gets misread as "build a page". The scheduler fires it later over WS.
  const timerReq = parseTimer(text);
  if (timerReq) {
    pendingOffers.delete(convId);
    if (timerReq.action === 'cancel') {
      const active = listActiveTimers();
      active.forEach((t) => cancelSchedule(t.id));
      const reply = active.length ? 'Okay, I stopped your timer.' : "You don't have a timer running right now.";
      addMessage(convId, profileId, 'avatar', reply);
      return res.json({ kind: 'timer', reply });
    }
    return respondTimer(res, convId, profileId, timerReq.durationMs, timerReq.label);
  }

  // 1.3) reminder/alarm at a wall-clock time? "remind me to feed the fish at 5pm",
  // "set an alarm for 7am", "cancel my alarm". Resolved to the next future epoch in
  // the configured timezone; the scheduler announces it when it fires.
  const remReq = parseReminder(text);
  if (remReq) {
    pendingOffers.delete(convId);
    if (remReq.action === 'cancel') {
      const active = listActiveSchedules().filter((s) => s.kind === 'reminder');
      active.forEach((s) => cancelSchedule(s.id));
      const reply = active.length ? 'Okay, I cancelled your reminder.' : "You don't have any reminders set right now.";
      addMessage(convId, profileId, 'avatar', reply);
      return res.json({ kind: 'reminder', reply });
    }
    const sent = respondReminder(res, convId, profileId, remReq);
    if (sent) return sent;   // else couldn't resolve a future time — fall through to chat
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

  // 2) LLM intent: one classify-and-extract call routes the utterance to chat /
  // artifact / timer / reminder with params — the long-tail catch for phrasings the
  // fast-path regex above missed (e.g. "can you wake me a quarter past six"). It's a
  // single classification call, not native tool use: our code acts on the result;
  // the model never sees a tool result. Current local time lets it infer am/pm + day.
  let intentObj = { intent: 'chat' };
  try {
    const sys = `${INTENT_SYSTEM_PROMPT}\n\nThe current local time is ${describeNow(getTimezone())}.`;
    intentObj = JSON.parse(await runText('intent', { system: sys, prompt: text, history })) || { intent: 'chat' };
  } catch { intentObj = { intent: /\b(make|build|show|create|draw) (me )?(a |an )?(page|game|lesson|quiz|story|activity|picture)/i.test(text) ? 'artifact' : 'chat' }; }
  const intent = intentObj.intent || 'chat';
  if (intent === 'timer' && Number(intentObj.durationSeconds) > 0) {
    pendingOffers.delete(convId);
    return respondTimer(res, convId, profileId, Number(intentObj.durationSeconds) * 1000, intentObj.label);
  }
  if (intent === 'reminder') {
    pendingOffers.delete(convId);
    const sent = respondReminder(res, convId, profileId, intentObj);
    if (sent) return sent;   // else fall through to chat
  }
  if (intent === 'artifact' && isTypeEnabled('page') && !offForKid.has('page')) {
    pendingOffers.delete(convId);
    const topic = await resolveTopic(text, history);
    // Same appropriateness judgment the chat model applies — so "make me a page about
    // it/the Holocaust" can't bypass a deflection and quietly build a page.
    if (!(await topicAppropriate(topic, profile))) {
      addMessage(convId, profileId, 'avatar', TOPIC_DEFLECTION);
      return res.json({ kind: 'chat', reply: TOPIC_DEFLECTION, blocked: true });
    }
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
