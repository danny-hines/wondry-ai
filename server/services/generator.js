// Generation pipeline — now a thin dispatcher over the content-type registry.
// Event-driven so it outlives the conversation view:
//   create row (generating) -> emit artifact.created -> type.generate()
//   -> write content file -> mark ready -> emit artifact.completed
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, uid, now, setAudience } from '../db.js';
import { emit } from '../events.js';
import { getType } from '../content/registry.js';
import { usageContext } from './usageContext.js';
import '../content/index.js'; // register built-in content types (side effect)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'artifacts');
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

export const NEUTRAL = { id: null, name: null, color: '#8b5cf6', reading_level: null, age: null, interests: null };

export function getArtifact(id) { return db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id); }
export function artifactPath(id) { return path.join(ARTIFACT_DIR, `${id}.html`); }   // sandbox-html types
export function contentPath(id) { return path.join(ARTIFACT_DIR, `${id}.json`); }    // native/declarative types
export function getContent(id) {
  try { return JSON.parse(fs.readFileSync(contentPath(id), 'utf8')); } catch { return null; }
}

// Kick off generation for any registered content type. `audience` = profile ids to
// publish to when ready. Defaults: on_demand -> the asking kid; parent/proactive -> held.
export async function createArtifact({ typeId, params = {}, profile, source = 'on_demand', audience, richness }) {
  const type = getType(typeId);
  if (!type) throw new Error('unknown content type: ' + typeId);
  const prof = profile || NEUTRAL;
  const resolved = type.prepare ? await type.prepare({ params, profile: prof }) : params;
  const id = uid();
  // Run planning + generation inside the artifact's usage context so every LLM call
  // they make is cost-attributed to this artifact (see usageContext + providers.track).
  return usageContext.run({ artifactId: id }, async () => {
    const pl = (type.plan ? await type.plan({ params: resolved, profile: prof }) : {}) || {};
    const color = pl.color || prof.color || type.defaultColor || '#8b5cf6';

    db.prepare(`INSERT INTO artifacts
        (id,type,title,prompt,profile_id,source,status,subject,reading_level,plan,emoji,color,published,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, type.id, pl.title || type.label, pl.promptText ?? JSON.stringify(resolved), prof.id, source, 'generating',
           pl.subject ?? null, pl.reading_level ?? prof.reading_level ?? null, pl.plan ?? '', pl.emoji || type.emoji || '✨', color, 1, now());

    const aud = audience || (source === 'on_demand' && prof.id ? [prof.id] : []);
    for (const pid of aud) setAudience(id, pid, true);

    emit('artifact.created', { artifact: getArtifact(id) });
    finishArtifact(id, type, resolved, prof, { source, richness }).catch((e) => failArtifact(id, e.message));
    return id;
  });
}

async function finishArtifact(id, type, params, profile, ctx = {}) {
  const { data, meta = {} } = await type.generate({ params, profile, source: ctx.source, richness: ctx.richness });
  if (type.safetyScan) {
    const safe = type.safetyScan(data, profile);
    if (safe && safe.verdict === 'block') throw new Error('Content failed safety scan: ' + (safe.reasons || []).join(', '));
  }
  const file = type.ext === 'html' ? artifactPath(id) : contentPath(id);
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data), 'utf8');

  db.prepare(`UPDATE artifacts SET status='ready', title=?, emoji=?, color=?, subject=?, reading_level=?, plan=?, ready_at=? WHERE id=?`)
    .run(meta.title ?? type.label, meta.emoji ?? type.emoji, meta.color ?? (profile.color || type.defaultColor || '#8b5cf6'),
         meta.subject ?? null, meta.reading_level ?? profile.reading_level ?? null, meta.plan ?? '', now(), id);

  emit('artifact.completed', { artifact: getArtifact(id) });
}

function failArtifact(id, msg) {
  db.prepare(`UPDATE artifacts SET status='failed', error=? WHERE id=?`).run(msg, id);
  emit('artifact.failed', { artifact: getArtifact(id) });
}

// Back-compat wrappers (existing call sites keep working through the registry).
export const startGeneration = ({ topic, profile, source = 'on_demand', audience }) =>
  createArtifact({ typeId: 'page', params: { topic }, profile, source, audience });
export const startReadingGeneration = ({ profile, source = 'on_demand', audience, interest, level }) =>
  createArtifact({ typeId: 'reading', params: { interest, level }, profile, source, audience });
