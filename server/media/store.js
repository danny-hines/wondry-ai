// Local media store: writes fetched image bytes under artifacts/media/<id>.<ext>
// and records metadata in the media table. Served same-origin via /api/media/:id,
// so generated content stays sealed and works offline once baked.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uid, insertMedia, getMedia } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR = path.join(__dirname, '..', '..', 'artifacts', 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

export function saveMedia({ source, query, bytes, mime, ext = 'jpg', alt, credit, license, sourceUrl }) {
  const id = uid();
  fs.writeFileSync(path.join(MEDIA_DIR, `${id}.${ext}`), Buffer.from(bytes));
  insertMedia({ id, source, query, mime, ext, alt, credit, license, source_url: sourceUrl, bytes: bytes.byteLength ?? bytes.length });
  return id;
}

// Resolve a media id to its file path + metadata for serving (null if missing).
export function mediaFile(id) {
  const m = getMedia(id);
  if (!m) return null;
  const file = path.join(MEDIA_DIR, `${id}.${m.ext}`);
  if (!fs.existsSync(file)) return null;
  return { ...m, path: file };
}
