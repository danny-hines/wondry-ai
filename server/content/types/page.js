// Content type: 'page' — the original sandboxed interactive HTML lesson. This is
// the generic "build me something about X" type and the freeform escape hatch:
// the model writes arbitrary HTML, served behind the CSP sandbox.
import { runArtifact, runText, pickEmoji, titleCase, extractTopic } from '../../services/providers.js';
import { getArtifactSystemPrompt } from '../../services/systemPrompt.js';
import { resolveRichness } from '../../services/richness.js';
import { checkOutputHTML } from '../../services/safety.js';

export default {
  id: 'page',
  label: 'Interactive page',
  emoji: '✨',
  renderer: 'sandbox-html',
  ext: 'html',
  uses: {},
  defaultColor: '#8b5cf6',
  createForm: [{ key: 'topic', label: 'Describe the page', type: 'textarea', placeholder: 'e.g. A gentle bedtime story about the moon, calm and short, with a counting game at the end.' }],
  // 'page' is the generic build target reached via the LLM intent classifier, so
  // it intentionally has no matchIntent — the router falls back to it.

  async plan({ params }) {
    const topic = params.topic;
    try {
      const j = JSON.parse(await runText('plan', { prompt: `Topic: ${topic}` }));
      return { title: j.title || titleCase(extractTopic(topic)), emoji: j.emoji || pickEmoji(topic), plan: j.plan || '', subject: extractTopic(topic), promptText: topic };
    } catch {
      return { title: titleCase(extractTopic(topic)), emoji: pickEmoji(topic), plan: '', subject: extractTopic(topic), promptText: topic };
    }
  },

  async generate({ params, profile, source, richness }) {
    const tier = resolveRichness({ source, override: richness });
    const r = await runArtifact({ topic: params.topic, profile, system: getArtifactSystemPrompt(), tier });
    const safe = checkOutputHTML(r.html, profile);
    if (safe.verdict === 'block') throw new Error('Output failed safety scan: ' + safe.reasons.join(', '));
    return {
      data: r.html,
      meta: { title: r.title, emoji: r.emoji, color: r.color, plan: r.plan || '', subject: extractTopic(params.topic) },
    };
  },
};
