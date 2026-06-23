// Content-type registry: the framework that lets Wondry grow new kinds of content
// (pages, reading, flashcards, games, …) as drop-in modules instead of hard-coded
// branches. Each type is an object registered here; the generator, conversation
// router, and admin console all dispatch through this registry.
//
// A content type module looks like:
//   {
//     id: 'reading', label: 'Reading practice', emoji: '📖',
//     renderer: 'native' | 'declarative' | 'sandbox-html',  // how the CLIENT renders it
//     ext: 'json' | 'html',                                  // stored content file extension
//     uses: { mic?, media?, network? },                      // capability surface (vetting)
//     defaultColor, createForm, triggersHelp,
//     matchIntent(text) -> params | null,    // kid utterance -> this type (else null)
//     intentReply(params) -> string,         // what the avatar says when starting it
//     prepare({params, profile}) -> params,  // resolve/augment params once (optional)
//     plan({params, profile}) -> {title, emoji, color, subject, plan, reading_level}, // placeholder card (optional)
//     generate({params, profile}) -> {data, meta},   // REQUIRED: produce content + final meta
//     safetyScan(content, profile) -> {verdict},      // optional extra scan
//     recordEvent({artifactId, profileId, event}),    // optional progress capture
//     summary(profileId) -> {...},                     // optional parent-report rollup
//   }
import { getKV, setKV } from '../db.js';

const types = new Map();

export function registerType(t) {
  if (!t || !t.id) throw new Error('content type needs an id');
  types.set(t.id, t);
}
export function getType(id) { return types.get(id); }
export function allTypes() { return [...types.values()]; }

// Admin enable/disable, persisted in config_kv. Defaults to enabled.
export function isTypeEnabled(id) { return getKV(`type_enabled_${id}`, '1') !== '0'; }
export function setTypeEnabled(id, on) { setKV(`type_enabled_${id}`, on ? '1' : '0'); }
export function enabledTypes() { return allTypes().filter((t) => isTypeEnabled(t.id)); }

// Client-facing manifest (no server functions) for the admin console & create forms.
export function manifest(t) {
  return {
    id: t.id, label: t.label, emoji: t.emoji, renderer: t.renderer,
    uses: t.uses || {}, createForm: t.createForm || [],
    triggersHelp: t.triggersHelp || null, authorable: t.authorable !== false,
    enabled: isTypeEnabled(t.id),
  };
}
export function manifests() { return allTypes().map(manifest); }
