// The declarative widget kit: a small, vetted set of interactive primitives that
// declarative content types (flashcards, math, language, …) compose as JSON and
// the client's DeclarativeRenderer draws. Content is DATA, never code — so it's
// safe to generate and easy to validate. Add a widget here + in the client
// renderer to grow the kit. Image resolution (query -> local media) happens in a
// later media pass; here we just keep the request shape.
const str = (v, max = 600) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

// Curated silhouettes the client can draw behind a 'map' scene (the renderer owns
// the actual SVG; here we just allow the model to request one by name).
const SCENE_BACKDROPS = ['body', 'plant', 'globe'];

// --- Node icons: structured SVG, never raw markup ---------------------------
// A node may carry a tiny vector icon as a WHITELIST of primitive shapes the
// renderer maps to <path>/<circle>/… elements. We never accept raw SVG strings,
// script, href, style, or any attribute outside the lists below — so an icon can
// only ever DRAW, never execute or fetch. This is the security boundary.
const ICON_SHAPE_GEOM = {
  path: { req: ['d'] }, circle: { req: ['cx', 'cy', 'r'] }, ellipse: { req: ['cx', 'cy', 'rx', 'ry'] },
  rect: { req: ['x', 'y', 'width', 'height'], opt: ['rx', 'ry'] }, line: { req: ['x1', 'y1', 'x2', 'y2'] },
  polygon: { req: ['points'] }, polyline: { req: ['points'] },
};
const ICON_COLOR_RE = /^(#[0-9a-f]{3,8}|none|currentColor|transparent|white|black|red|orange|yellow|gold|green|blue|navy|purple|pink|brown|tan|gray|grey|silver)$/i;
const ICON_PATH_RE = /^[-0-9.,eE\s mlhvcsqtazMLHVCSQTAZ]+$/;     // path 'd' / points: digits + path commands only
const iconColor = (v) => { const s = String(v == null ? '' : v).trim(); return ICON_COLOR_RE.test(s) ? s : undefined; };
const iconCoord = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(-100, Math.min(200, Math.round(n * 1000) / 1000)) : undefined; };

function iconGeom(out, a, v, required) {
  if (a === 'd' || a === 'points') {
    const s = String(v == null ? '' : v).trim();
    if (!s) return !required;                                   // absent optional is fine; absent required isn't
    if (s.length > 1200 || !ICON_PATH_RE.test(s)) return false; // present but unsafe → reject the shape
    out[a] = s; return true;
  }
  if (v == null) return !required;
  const n = iconCoord(v);
  if (n == null) return false;
  out[a] = n; return true;
}
function iconShape(sh) {
  const spec = sh && ICON_SHAPE_GEOM[sh.type];
  if (!spec) return null;
  const out = { type: sh.type };
  for (const a of spec.req) if (!iconGeom(out, a, sh[a], true)) return null;
  for (const a of spec.opt || []) if (!iconGeom(out, a, sh[a], false)) return null;
  const fill = iconColor(sh.fill); if (fill) out.fill = fill;
  const stroke = iconColor(sh.stroke); if (stroke) out.stroke = stroke;
  const sw = Number(sh.strokeWidth); if (Number.isFinite(sw)) out.strokeWidth = Math.max(0, Math.min(8, sw));
  if (['round', 'butt', 'square'].includes(sh.strokeLinecap)) out.strokeLinecap = sh.strokeLinecap;
  if (['round', 'bevel', 'miter'].includes(sh.strokeLinejoin)) out.strokeLinejoin = sh.strokeLinejoin;
  const op = Number(sh.opacity); if (Number.isFinite(op)) out.opacity = Math.max(0, Math.min(1, op));
  return out;
}
function sceneIcon(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const shapes = arr(raw.shapes).slice(0, 16).map(iconShape).filter(Boolean);
  if (!shapes.length) return undefined;
  const vb = /^[-0-9.]+(\s+[-0-9.]+){3}$/.test(String(raw.viewBox || '').trim()) ? String(raw.viewBox).trim() : '0 0 24 24';
  return { viewBox: vb, shapes };
}

// One focusable thing in an explorable scene: a label + emoji, a one-line blurb the
// avatar speaks when it's focused, and a few short tap-to-hear facts. Optional
// position (x/y, 0-100) for 'map' layout and relative size for 'orbit'.
function sceneNode(n) {
  if (!n) return null;
  const label = str(n.label, 60);
  if (!label) return null;
  const node = {
    label,
    emoji: oneEmoji(n.emoji) || '•',
    blurb: str(n.blurb, 240),
    facts: arr(n.facts).map((f) => str(f, 200)).filter(Boolean).slice(0, 4),
  };
  if (n.x != null || n.y != null) { node.x = num(n.x, 0, 100, 50); node.y = num(n.y, 0, 100, 50); }
  if (n.size != null) node.size = num(n.size, 0.5, 2, 1);
  if (n.color) node.color = str(n.color, 16);
  const icon = sceneIcon(n.icon); if (icon) node.icon = icon;
  return node;
}

// Each builder coerces one raw block into a clean, known-good block (or null).
const BLOCKS = {
  heading: (b) => { const text = str(b.text, 120); return text ? { type: 'heading', text } : null; },
  text: (b) => { const text = str(b.text, 800); return text ? { type: 'text', text } : null; },
  flashcards: (b) => {
    const cards = arr(b.cards)
      .map((c) => ({ front: str(c.front, 120), back: str(c.back, 300), hint: c.hint ? str(c.hint, 160) : undefined }))
      .filter((c) => c.front && c.back);
    return cards.length ? { type: 'flashcards', cards } : null;
  },
  quiz: (b) => {
    const options = arr(b.options).map((o) => str(o, 160)).filter(Boolean);
    const question = str(b.question, 240);
    if (!question || options.length < 2) return null;
    let answer = Number.isInteger(b.answer) ? b.answer : 0;
    if (answer < 0 || answer >= options.length) answer = 0;
    return { type: 'quiz', question, options, answer };
  },
  // Explorable scene: a spatial diagram of focusable things the child taps to zoom
  // in on and hear about, with the avatar narrating. `layout` picks how they're
  // arranged: 'orbit' (nodes revolve around a center, e.g. the solar system),
  // 'map' (nodes at fixed x/y, e.g. parts of the body), 'cycle' (a loop/sequence,
  // e.g. the water cycle). Pure data — the trusted Scene renderer does the motion.
  scene: (b) => {
    const layout = ['orbit', 'map', 'cycle'].includes(b.layout) ? b.layout : 'map';
    const nodes = arr(b.nodes).map(sceneNode).filter(Boolean).slice(0, 10);
    if (nodes.length < 2) return null;
    const center = b.center ? sceneNode(b.center) : null;
    const out = { type: 'scene', layout, nodes };
    if (center) out.center = center;
    // Optional curated silhouette drawn behind a 'map' scene so it reads as a real
    // figure (the body, a plant, the globe) rather than scattered icons.
    if (layout === 'map' && SCENE_BACKDROPS.includes(b.backdrop)) out.backdrop = b.backdrop;
    const caption = str(b.caption, 200);
    if (caption) out.caption = caption;
    return out;
  },
  // Image: either an already-baked mediaId (agentic find_image tool) or a query
  // the post-pass resolves to a cached local mediaId from a trusted source.
  image: (b) => {
    if (b.mediaId) return { type: 'image', mediaId: str(b.mediaId, 40), alt: str(b.alt, 160), caption: b.caption ? str(b.caption, 160) : undefined, credit: b.credit ? str(b.credit, 180) : undefined };
    const query = str(b.query, 160); if (!query) return null;
    return { type: 'image', query, alt: str(b.alt || b.query, 160), caption: b.caption ? str(b.caption, 160) : undefined };
  },
};

// Coerce a raw model object into a clean declarative doc. Drops unknown/invalid
// blocks; throws if nothing renderable survives.
export function normalizeDoc(obj, { title, emoji, subject } = {}) {
  const blocks = arr(obj && obj.blocks).map((b) => (b && BLOCKS[b.type] ? BLOCKS[b.type](b) : null)).filter(Boolean);
  if (!blocks.length) throw new Error('declarative content had no renderable blocks');
  return {
    title: str(obj && obj.title, 80) || title || 'Lesson',
    emoji: oneEmoji(obj && obj.emoji) || emoji || '🧩',
    subject: str(obj && obj.subject, 60) || subject || '',
    blocks,
  };
}

// All human-readable text in a doc (for the safety scan).
export function collectText(doc) {
  const out = [];
  for (const b of (doc && doc.blocks) || []) {
    if (b.text) out.push(b.text);
    if (b.question) out.push(b.question);
    if (b.options) out.push(b.options.join(' '));
    if (b.cards) for (const c of b.cards) out.push(c.front, c.back, c.hint || '');
    if (b.type === 'scene') {
      if (b.caption) out.push(b.caption);
      for (const n of [...(b.center ? [b.center] : []), ...(b.nodes || [])]) {
        out.push(n.label, n.blurb || '', ...(n.facts || []));
      }
    }
  }
  return out.join(' ');
}

function oneEmoji(s) { const m = String(s || '').match(/\p{Extended_Pictographic}/u); return m ? m[0] : ''; }
