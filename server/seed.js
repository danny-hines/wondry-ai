// Seeds default profiles + a few ready sample lessons so the app has content
// to show on first boot. Safe to re-run (idempotent on profiles).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, uid, now, initSchema, setAudience } from './db.js';
import { runArtifact, pickEmoji } from './services/providers.js';
import { getArtifactSystemPrompt } from './services/systemPrompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = path.join(__dirname, '..', 'artifacts');
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

initSchema();

// --- profiles (placeholder kids; edit in the portal) ---
const PROFILES = [
  { name: 'Theo',   initials: 'TH', color: '#16b8a6', age: 7, reading_level: 'early reader', theme: 'light' },
  { name: 'Ella',   initials: 'EL', color: '#3b82f6', age: 5, reading_level: 'pre-reader',  theme: 'dark'  },
];
const existing = db.prepare('SELECT COUNT(*) n FROM profiles').get().n;
const ids = {};
if (existing === 0) {
  for (const p of PROFILES) {
    const id = uid();
    ids[p.name] = id;
    db.prepare('INSERT INTO profiles (id,name,initials,color,age,reading_level,theme,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, p.name, p.initials, p.color, p.age, p.reading_level, p.theme || 'light', now());
  }
  console.log('Seeded profiles:', Object.keys(ids).join(', '));
} else {
  for (const r of db.prepare('SELECT id,name FROM profiles').all()) ids[r.name] = r.id;
  console.log('Profiles already exist, skipping.');
}

// --- sample lessons ---
const SAMPLES = [
  { who: 'Theo', topic: 'the rock cycle', source: 'on_demand' },
  { who: 'Theo', topic: 'a trip through space', source: 'parent' },
  { who: 'Ella', topic: 'the three little pigs', source: 'parent' },
  { who: 'Ella', topic: "let's count to ten", source: 'on_demand' },
  { who: 'Theo', topic: 'under the ocean', source: 'proactive' },
];

const haveArtifacts = db.prepare('SELECT COUNT(*) n FROM artifacts').get().n;
if (haveArtifacts === 0) {
  for (const s of SAMPLES) {
    const profileId = ids[s.who];
    const profile = db.prepare('SELECT * FROM profiles WHERE id=?').get(profileId);
    const r = await runArtifact({ topic: s.topic, profile, system: getArtifactSystemPrompt() });
    const id = uid();
    fs.writeFileSync(path.join(ARTIFACT_DIR, `${id}.html`), r.html, 'utf8');
    db.prepare(`INSERT INTO artifacts
      (id,title,prompt,profile_id,source,status,subject,reading_level,plan,emoji,color,published,created_at,ready_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, r.title, s.topic, profileId, s.source, 'ready', s.topic, profile.reading_level,
           r.plan || '', r.emoji || pickEmoji(s.topic), r.color || profile.color, 1, now(), now());
    setAudience(id, profileId, true); // publish to the kid it was made for
    console.log('Seeded lesson:', r.title, `(${s.who})`);
  }
} else {
  console.log('Artifacts already exist, skipping sample lessons.');
}
console.log('Seed complete.');
