// LLM provider abstraction. Every "task" routes (via config) to a provider.
// Adapters: `anthropic` and `openai` (real APIs, same {base_url, model, api_key}
// shape) and `mock` (keyless, deterministic). A task points at whichever provider
// you configure in config.json — switching Claude↔GPT is a config edit, not code.
import { resolveProvider } from '../config.js';
import { recordUsage } from '../db.js';
import { currentArtifactId } from './usageContext.js';
import { mockArtifactHTML, mockReadingLesson } from './mockArtifact.js';

// Normalize the two usage shapes (Anthropic: input/output_tokens, OpenAI:
// prompt/completion_tokens) to { inTok, outTok }.
export function usageTokens(data) {
  const u = (data && data.usage) || {};
  return { inTok: u.input_tokens ?? u.prompt_tokens ?? 0, outTok: u.output_tokens ?? u.completion_tokens ?? 0 };
}

// Record token usage + estimated cost for one API call (prices in config.json),
// attributed to the artifact being generated (if any — see usageContext).
function track(provider, task, data) {
  try {
    const { inTok, outTok } = usageTokens(data);
    if (!inTok && !outTok) return;
    const price = provider.price || {};
    const cost = (inTok / 1e6) * (price.in || 0) + (outTok / 1e6) * (price.out || 0);
    recordUsage({ task, model: provider.model, artifactId: currentArtifactId(), inputTokens: inTok, outputTokens: outTok, costUsd: cost });
  } catch { /* never let accounting break generation */ }
}

// Dispatch a text completion to the right adapter for the provider.
function complete(provider, opts) {
  return provider.type === 'openai' ? openaiComplete(provider, opts) : anthropicComplete(provider, opts);
}

// Run a text task. `history` (optional) is prior turns [{role:'user'|'assistant',content}]
// so follow-up questions keep context. Mock ignores history.
export async function runText(task, { system, prompt, history }) {
  const provider = resolveProvider(task);
  if (provider.type === 'mock') return mockText(task, prompt);
  const messages = [...(history || []), { role: 'user', content: prompt }];
  return complete(provider, { system, messages, task });
}

// Vision completion: judge an image (a rendered-page screenshot). Anthropic-only —
// returns null on any other provider (incl. mock when there's no key) so the caller
// falls back to text judging. `prompt` is the instruction; the image leads the turn.
export async function runVision(task, { system, prompt, imageBase64, mediaType = 'image/png' }) {
  const provider = resolveProvider(task);
  if (provider.type !== 'anthropic' || !provider._apiKey) return null;
  const content = [
    { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
    { type: 'text', text: prompt },
  ];
  const res = await fetch(`${provider.base_url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': provider._apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: provider.model, max_tokens: provider.max_tokens || 4096, system: system || undefined, messages: [{ role: 'user', content }] }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Anthropic vision ${res.status}: ${t.slice(0, 300)}`); }
  const data = await res.json();
  track(provider, task, data);
  return (data.content || []).map((b) => b.text || '').join('');
}

// Generate an artifact: returns { html, title, emoji, color, plan }. `tier` is the
// resolved content-richness tier (provider, maxTokens, emphasis); when omitted we
// fall back to the routed 'artifact' provider with its default token budget.
export async function runArtifact({ topic, profile, system, tier }) {
  const provider = tier?.provider || resolveProvider('artifact');
  if (provider.type === 'mock') return mockArtifactHTML(topic, profile);
  const sys = tier?.emphasis ? `${system}\n\nCONTENT RICHNESS:\n${tier.emphasis}` : system;
  const userPrompt =
    `Create an interactive educational page for a child named ${profile.name || 'friend'}, age ${profile.age || 7}, ` +
    `reading level "${profile.reading_level || 'early reader'}". Topic: "${topic}".`;
  const html = await complete(provider, { system: sys, messages: [{ role: 'user', content: userPrompt }], maxTokens: tier?.maxTokens, task: 'artifact' });
  const m = html.match(/<title>([^<]+)<\/title>/i);
  return {
    html: stripFence(html),
    title: (m && m[1].trim()) || titleCase(extractTopic(topic)),
    emoji: pickEmoji(topic),
    color: profile.color || '#8b5cf6',
    plan: `An interactive page about ${extractTopic(topic)}.`,
  };
}

// Generate a reading-practice lesson: returns a validated lesson object
// { title, emoji, interest, level, pages: [{ illustration, lines: [string] }] }.
export async function runReading({ profile, interests, level = 2, system }) {
  const provider = resolveProvider('reading');
  if (provider.type === 'mock') return mockReadingLesson({ profile, interests, level });
  const userPrompt =
    `Write a reading-practice lesson for ${profile.name || 'a child'}, age ${profile.age || 7}, at level ${level} (1=easiest, 5=hardest).` +
    (interests ? ` The child loves: ${interests}. Theme the story around that.` : ' Pick a fun, wholesome theme.');
  const raw = await complete(provider, { system, messages: [{ role: 'user', content: userPrompt }], task: 'reading' });
  return normalizeLesson(extractJSON(raw), { interests, level });
}

// Generic structured-JSON generation for declarative content types. `mock` is the
// type's keyless fallback (returns the same shape). The caller validates/normalizes.
export async function runStructured(task, { system, prompt, mock, maxTokens }) {
  const provider = resolveProvider(task);
  if (provider.type === 'mock') return mock ? mock() : {};
  const raw = await complete(provider, { system, messages: [{ role: 'user', content: prompt }], maxTokens, task });
  return extractJSON(raw);
}

// Agentic structured generation: the model may call tools mid-generation (e.g.
// find_image) before returning its final JSON. `tools` are {name, description,
// input_schema, handler}. Runs the tool loop server-side; the model never sees
// URLs/APIs, only tool results. Falls back to `mock()` on the keyless provider.
export async function runAgentic(task, { system, prompt, tools = [], mock, maxTurns = 6 }) {
  const provider = resolveProvider(task);
  if (provider.type === 'mock') return mock ? mock() : {};
  if (provider.type === 'openai') return openaiAgentic(provider, { system, prompt, tools, maxTurns, task });
  const toolDefs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const messages = [{ role: 'user', content: prompt }];
  let finalText = '';
  for (let turn = 0; turn < maxTurns; turn++) {
    const data = await anthropicRaw(provider, { system, messages, tools: toolDefs, task });
    const blocks = data.content || [];
    finalText = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    if (data.stop_reason !== 'tool_use' || !toolUses.length) break;
    messages.push({ role: 'assistant', content: blocks });
    const results = [];
    for (const tu of toolUses) {
      let result;
      try { result = byName[tu.name] ? await byName[tu.name].handler(tu.input || {}) : { error: 'unknown tool' }; }
      catch (e) { result = { error: String(e.message || e) }; }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: results });
  }
  return extractJSON(finalText);
}

// Raw Anthropic call returning the full response (content blocks + stop_reason),
// for the tool-use loop. Messages may contain tool_use/tool_result blocks.
async function anthropicRaw(provider, { system, messages, tools, task }) {
  const res = await fetch(`${provider.base_url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': provider._apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: provider.model, max_tokens: provider.max_tokens || 4096,
      system: system || undefined, messages,
      tools: tools && tools.length ? tools : undefined,
    }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Anthropic API ${res.status}: ${t.slice(0, 300)}`); }
  const data = await res.json();
  track(provider, task, data);
  return data;
}

// Pull the first JSON object out of a model response (tolerates stray prose/fences).
function extractJSON(s) {
  const t = stripFence(String(s || '').trim());
  try { return JSON.parse(t); } catch {}
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch {} }
  throw new Error('Reading lesson was not valid JSON');
}

// Coerce/clean a generated lesson into the strict shape the Reader expects.
const oneEmoji = (s, fb) => { const m = String(s || '').match(/\p{Extended_Pictographic}/u); return m ? m[0] : fb; };
function normalizeLesson(obj, { interests, level }) {
  const pages = (Array.isArray(obj?.pages) ? obj.pages : [])
    .map((pg) => ({
      illustration: oneEmoji(pg?.illustration, '📖'),
      lines: (Array.isArray(pg?.lines) ? pg.lines : [])
        .map((l) => String(l || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean),
    }))
    .filter((pg) => pg.lines.length);
  if (!pages.length) throw new Error('Reading lesson had no readable pages');
  return {
    title: (obj?.title && String(obj.title).trim().slice(0, 80)) || titleCase(interests || 'A Reading Story'),
    emoji: oneEmoji(obj?.emoji, pickEmoji(interests || 'story')),
    interest: (obj?.interest && String(obj.interest).trim().slice(0, 40)) || interests || 'reading',
    level: Math.max(1, Math.min(5, Number(obj?.level) || level)),
    pages,
  };
}

// Anthropic Messages API requires messages to start with 'user' and alternate roles;
// normalize (drop leading assistant turns, merge consecutive same-role).
function normalizeMessages(msgs) {
  const out = [];
  for (const m of msgs) {
    if (!m || !m.content) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (out.length === 0 && role !== 'user') continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += '\n' + m.content;
    else out.push({ role, content: m.content });
  }
  return out.length ? out : [{ role: 'user', content: ' ' }];
}

async function anthropicComplete(provider, { system, messages, maxTokens, task }) {
  const res = await fetch(`${provider.base_url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': provider._apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: maxTokens || provider.max_tokens || 4096,
      system: system || undefined,
      messages: normalizeMessages(messages),
    }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Anthropic API ${res.status}: ${t.slice(0, 300)}`); }
  const data = await res.json();
  track(provider, task, data);
  return (data.content || []).map((b) => b.text || '').join('');
}
// --- OpenAI (Chat Completions) adapter ---
// Same {base_url, model, api_key_env, price} provider shape; system goes in as the
// first message. `token_param` lets you switch to 'max_completion_tokens' for newer
// models. base_url points at any OpenAI-compatible endpoint (OpenAI, Azure, local).
export function openaiBody(provider, { system, messages, maxTokens, tools }) {
  const norm = normalizeMessages(messages);
  const all = system ? [{ role: 'system', content: system }, ...norm] : norm;
  const body = { model: provider.model, messages: all };
  body[provider.token_param || 'max_tokens'] = maxTokens || provider.max_tokens || 4096;
  if (tools && tools.length) body.tools = tools;
  return body;
}
export function parseOpenaiText(data) {
  return ((((data.choices || [])[0] || {}).message || {}).content) || '';
}
async function openaiCall(provider, body) {
  const res = await fetch(`${provider.base_url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${provider._apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`OpenAI API ${res.status}: ${t.slice(0, 300)}`); }
  return res.json();
}
async function openaiComplete(provider, { system, messages, maxTokens, task }) {
  const data = await openaiCall(provider, openaiBody(provider, { system, messages, maxTokens }));
  track(provider, task, data);
  return parseOpenaiText(data);
}
// OpenAI tool-use loop (mirrors the Anthropic one): function tools, tool_calls,
// role:'tool' results. Server-side; the model only ever sees tool results.
async function openaiAgentic(provider, { system, prompt, tools, maxTurns, task }) {
  const toolDefs = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }];
  let finalText = '';
  for (let turn = 0; turn < maxTurns; turn++) {
    const data = await openaiCall(provider, openaiBody(provider, { messages, tools: toolDefs.length ? toolDefs : undefined }));
    track(provider, task, data);
    const msg = ((data.choices || [])[0] || {}).message || {};
    if (msg.content) finalText = msg.content;
    const calls = msg.tool_calls || [];
    if (!calls.length) break;
    messages.push(msg);
    for (const c of calls) {
      let result;
      try { const args = JSON.parse((c.function && c.function.arguments) || '{}'); result = byName[c.function.name] ? await byName[c.function.name].handler(args) : { error: 'unknown tool' }; }
      catch (e) { result = { error: String(e.message || e) }; }
      messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) });
    }
  }
  return extractJSON(finalText);
}

function stripFence(s) { return s.replace(/^```[a-z]*\n/i, '').replace(/\n```\s*$/i, '').trim(); }

// --- Mock text adapter (dev / keyless) ---
function mockText(task, prompt) {
  const p = (prompt || '').toLowerCase();
  if (task === 'intent') {
    const buildVerb = /\b(build|make|create|show|draw|give)\b/.test(p);
    const pageNoun = /\b(page|lesson|game|quiz|story|activity|picture|app)\b/.test(p);
    const explicit = (buildVerb && pageNoun) || /\b(make|build|show|draw) me\b/.test(p) || /\bi (want|wanna) to see\b/.test(p);
    return JSON.stringify({ intent: explicit ? 'artifact' : 'chat' });
  }
  if (task === 'plan') {
    return JSON.stringify({ title: titleCase(extractTopic(prompt)), emoji: pickEmoji(prompt), plan: `Let's explore ${extractTopic(prompt)} together!` });
  }
  if (task === 'resolve') return extractTopic(prompt);
  if (task === 'safety') {
    // Deterministic stand-in for the topic-appropriateness gate: block an obvious
    // blocklist, allow everything else. The real provider uses TOPIC_SAFETY_PROMPT.
    return /\b(holocaust|genocide|war|weapon|gun|kill|suicide|murder|drug|sex|porn|nazi|terroris)/.test(p) ? 'no' : 'yes';
  }
  if (task === 'summarize') return `Recent interests: ${extractTopic(prompt)}.`;
  if (/^(hi|hello|hey|yo|sup|howdy|how('?s| is) it going|how are you|good (morning|afternoon|evening))/.test(p))
    return "Hi there! I'm so happy to see you. What would you like to explore today?";
  if (/\b(time|clock|what day|date)\b/.test(p)) return "I don't have a clock, but it's always a great time to learn something fun!";
  if (/\b(your name|who are you)\b/.test(p)) return "I'm your learning buddy! I love helping you discover cool things.";
  return `Ooh, ${extractTopic(prompt)} — that's a fun thing to wonder about!`;
}

export function extractTopic(prompt = '') {
  let t = prompt
    .replace(/^(can you |could you |please |hey |um |uh )/gi, '')
    .replace(/(build|make|show|teach|tell|create|give)( me)?( a| an| the)? (page|lesson|game|quiz|story|activity|something|artifact)?( about| on| for)?/gi, '')
    .replace(/(i (want|wanna|would like) to )?(learn|know|hear|see)( about| more about)?/gi, '')
    .replace(/[?.!]/g, '')
    .trim();
  return t || 'something fun';
}

const EMOJI = { rock: '🪨', volcano: '🌋', space: '🚀', moon: '🌙', star: '⭐', dino: '🦕', dinosaur: '🦕',
  ocean: '🌊', fish: '🐟', plant: '🌱', tree: '🌳', count: '🔢', number: '🔢', pig: '🐷', story: '📖',
  animal: '🐾', weather: '🌦️', water: '💧', body: '🫀', math: '➗', music: '🎵', color: '🎨', glass: '🪟', cloud: '☁️' };
export function pickEmoji(s = '') {
  s = s.toLowerCase();
  for (const k of Object.keys(EMOJI)) if (s.includes(k)) return EMOJI[k];
  return '✨';
}
export function titleCase(s = '') { return s.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 60); }
