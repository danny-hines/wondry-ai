// Content type: 'explorable' — a DECLARATIVE scene the kiosk renders as an animated,
// focusable diagram (the widget kit's 'scene' block). The model emits pure DATA
// (a set of focusable things + spoken facts + a layout); the trusted Scene renderer
// does all the motion. This is the "rich visual" path: e.g. "show me the solar
// system" becomes planets orbiting the sun you tap to focus on and hear about —
// not a flat list of cards. Generalizes to the body, plant parts, the water cycle,
// food chains, maps, and more, all through one safe, reusable widget.
import { runStructured, pickEmoji, titleCase, extractTopic } from '../../services/providers.js';
import { getExplorableSystemPrompt } from '../../services/systemPrompt.js';
import { mockExplorableDoc } from '../../services/mockArtifact.js';
import { checkDeclarativeContent } from '../../services/safety.js';
import { overCap } from '../../services/richness.js';
import { normalizeDoc, collectText } from '../declarative.js';

// Trigger on clear requests to SEE/EXPLORE a diagram, map, or known explorable
// subject — gated so ordinary questions go to chat and explicit asks for another
// kind of content ("make me a PAGE/STORY/GAME about…") keep their own type.
const SCENE_NOUNS = /\b(solar system|the planets|water cycle|life ?cycle|food chain|food web|rock cycle|the seasons)\b/i;
const VISUAL_VERB = /\b(show|see|draw|explore|diagram|map|visuali[sz]e)\b/i;
const OTHER_TYPE = /\b(page|story|flash ?cards?|memory|matching|game|quiz|read(ing)?|lesson)\b/i;
function wantsScene(text) {
  const s = (text || '').trim();
  if (OTHER_TYPE.test(s)) return false;                                 // they asked for a different kind
  if (/\b(diagram|map|model|tour) of\b/i.test(s)) return true;          // "a diagram of X"
  if (/\bexplore\b/i.test(s)) return true;                              // "explore the X"
  if (SCENE_NOUNS.test(s) && VISUAL_VERB.test(s)) return true;          // strong topic + show/see/draw/…
  return false;
}
function sceneTopic(text) {
  const m = (text || '').match(/\b(?:of|about|for|the)\s+(.+)$/i);
  const raw = m ? m[1] : extractTopic(text);
  return String(raw || '').replace(/^(the|a|an|our|my)\s+/i, '').replace(/[?.!]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 50);
}

export default {
  id: 'explorable',
  label: 'Explorable diagram',
  emoji: '🪐',
  renderer: 'declarative',
  ext: 'json',
  uses: {},
  defaultColor: '#0891b2',
  triggersHelp: 'e.g. "show me a diagram of the solar system", "explore the human body"',
  createForm: [{ key: 'topic', label: 'Topic', type: 'text', placeholder: 'e.g. the solar system, the human body, the water cycle' }],

  matchIntent: (text) => (wantsScene(text) ? { topic: sceneTopic(text) || undefined } : null),
  intentReply: (params) => (params.topic ? `Ooh, let's explore ${params.topic}!` : `Ooh, let's explore something cool!`),

  prepare: ({ params }) => ({ topic: (params.topic && String(params.topic).trim()) || 'the solar system' }),

  plan: ({ params, profile }) => ({
    title: titleCase(params.topic).slice(0, 40),
    emoji: pickEmoji(params.topic),
    color: profile.color || '#0891b2',
    subject: params.topic,
    plan: `An explorable diagram of ${params.topic}.`,
    promptText: params.topic,
  }),

  async generate({ params, profile, source, richness }) {
    // Drawn icons are the expensive part (much larger JSON). Past the daily cap, an
    // on-demand scene skips them to keep cost down (parent-authored scenes never do).
    const lite = overCap({ source, override: richness });
    const prompt = `Create an explorable interactive diagram for a child named ${profile.name || 'friend'}, age ${profile.age || 7}, ` +
      `reading level "${profile.reading_level || 'early reader'}". Topic: "${params.topic}". Pick the layout that best fits the topic.` +
      (lite ? ' Keep it lightweight: do NOT include any node "icon" fields — use emoji only.' : '');
    const raw = await runStructured('explorable', {
      system: getExplorableSystemPrompt(),
      prompt,
      // Icons make the JSON much larger; give it room so it isn't truncated (less when lite).
      maxTokens: lite ? 6000 : 16000,
      mock: () => mockExplorableDoc({ topic: params.topic }),
    });
    const doc = normalizeDoc(raw, { title: titleCase(params.topic), emoji: pickEmoji(params.topic), subject: extractTopic(params.topic) });
    if (lite) for (const b of doc.blocks) if (b.type === 'scene') { if (b.center) delete b.center.icon; for (const n of b.nodes) delete n.icon; }
    if (!doc.blocks.some((b) => b.type === 'scene')) throw new Error('Explorable doc had no scene block');
    const safe = checkDeclarativeContent(collectText(doc), profile);
    if (safe.verdict === 'block') throw new Error('Explorable failed safety scan: ' + safe.reasons.join(', '));
    const scene = doc.blocks.find((b) => b.type === 'scene');
    return {
      data: doc,
      meta: { title: doc.title, emoji: doc.emoji, color: profile.color || '#0891b2', subject: doc.subject, plan: `Explore ${scene.nodes.length} things about ${doc.subject}.` },
    };
  },
};
