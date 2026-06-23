// Content type: 'flashcards' — the first DECLARATIVE type. The model composes a
// document from the widget kit (intro text + a flashcard deck + a quiz); the
// kiosk renders it with the shared DeclarativeRenderer. Foundation for math,
// language, and other study-style content.
import { runStructured, runAgentic, pickEmoji, titleCase, extractTopic } from '../../services/providers.js';
import { getFlashcardsSystemPrompt } from '../../services/systemPrompt.js';
import { mockFlashcardsDoc } from '../../services/mockArtifact.js';
import { checkDeclarativeContent } from '../../services/safety.js';
import { normalizeDoc, collectText } from '../declarative.js';
import { resolveDocImages, imageSourceHints, mediaAgenticEnabled, imageTool, validateDocMedia } from '../../media/resolve.js';

const wantsFlashcards = (t) =>
  /\b(flash ?cards?|study (set|cards)|quiz me|practi[sc]e (my )?(words|vocab|spelling|facts))\b/i.test((t || '').trim());
function flashcardsTopic(text) {
  const m = (text || '').match(/\b(?:about|on|for|with)\s+(.+)$/i);
  return m ? m[1].replace(/[?.!]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 50) : '';
}

export default {
  id: 'flashcards',
  label: 'Flashcards',
  emoji: '🧠',
  renderer: 'declarative',
  ext: 'json',
  uses: {},
  defaultColor: '#0ea5e9',
  triggersHelp: 'e.g. "make flashcards about animals", "quiz me on shapes"',
  createForm: [{ key: 'topic', label: 'Topic', type: 'text', placeholder: 'e.g. farm animals, shapes, addition' }],

  matchIntent: (text) => (wantsFlashcards(text) ? { topic: flashcardsTopic(text) || undefined } : null),
  intentReply: (params) => (params.topic ? `Fun! Let's make flashcards about ${params.topic}!` : `Fun! Let's make some flashcards!`),

  prepare: ({ params }) => ({ topic: (params.topic && String(params.topic).trim()) || 'fun facts' }),

  plan: ({ params, profile }) => ({
    title: `${titleCase(params.topic).slice(0, 36)} Flashcards`,
    emoji: pickEmoji(params.topic),
    color: profile.color || '#0ea5e9',
    subject: params.topic,
    plan: `Flashcards about ${params.topic}.`,
    promptText: params.topic,
  }),

  async generate({ params, profile }) {
    const base = `Create a flashcards study set for a child named ${profile.name || 'friend'}, age ${profile.age || 7}, ` +
      `reading level "${profile.reading_level || 'early reader'}". Topic: "${params.topic}".`;
    const norm = { title: `${titleCase(params.topic)} Flashcards`, emoji: pickEmoji(params.topic), subject: extractTopic(params.topic) };
    let doc;
    if (mediaAgenticEnabled()) {
      // Agentic: let the model call find_image and embed the returned mediaId.
      const raw = await runAgentic('flashcards', {
        system: getFlashcardsSystemPrompt(),
        prompt: base + `\n\nYou may call find_image once to fetch a real photo illustrating the topic; if it returns available:true, add an {"type":"image","mediaId":"<the returned id>","alt":"..."} block right after the intro.`,
        tools: [imageTool()],
        mock: () => mockFlashcardsDoc({ topic: params.topic }),
      });
      doc = validateDocMedia(normalizeDoc(raw, norm)); // drop any invented mediaIds
    } else {
      const hints = imageSourceHints();
      const raw = await runStructured('flashcards', {
        system: getFlashcardsSystemPrompt(),
        prompt: base + (hints ? `\n\nYou MAY add ONE {"type":"image","query":"...","alt":"..."} block right after the intro to illustrate the topic. Describe a real, factual photo. Available image sources:\n${hints}` : ''),
        mock: () => mockFlashcardsDoc({ topic: params.topic }),
      });
      doc = normalizeDoc(raw, norm);
    }
    const safe = checkDeclarativeContent(collectText(doc), profile);
    if (safe.verdict === 'block') throw new Error('Flashcards failed safety scan: ' + safe.reasons.join(', '));
    if (!mediaAgenticEnabled()) await resolveDocImages(doc); // bake image requests -> local cached media
    const nCards = doc.blocks.filter((b) => b.type === 'flashcards').reduce((s, b) => s + b.cards.length, 0);
    return {
      data: doc,
      meta: { title: doc.title, emoji: doc.emoji, color: profile.color || '#0ea5e9', subject: doc.subject, plan: `${nCards} flashcards about ${doc.subject}.` },
    };
  },
};
