// Dev simulator for the familiar-faces pipeline — no camera or Hailo needed. It
// pretends to be the Pi vision sidecar: a few synthetic "people" (each a stable
// random embedding + a solid-colour thumbnail) POSTed to /api/faces/observe, so you
// can watch the parent console's "Familiar faces" tab fill up, assign clusters to
// kids, then see the kiosk auto-switch. Run the app (npm start or npm run dev) first.
//
//   node tools/faces-sim.mjs seed           # bank several frames of each person -> clusters
//   node tools/faces-sim.mjs walk <name>    # one identify frame -> kiosk switches (if enrolled)
//   node tools/faces-sim.mjs list           # show the people it can simulate
//   WONDRY_URL=http://localhost:5173 node tools/faces-sim.mjs seed   # point at the Vite dev server
//
// `seed` also flips the faces_enabled toggle on (needs the admin password; default
// "wondry", override with WONDRY_ADMIN_PW).
import zlib from 'node:zlib';

const URL = process.env.WONDRY_URL || 'http://localhost:8080';
const PW = process.env.WONDRY_ADMIN_PW || 'wondry';
const DIM = 512;

const PEOPLE = [
  { name: 'Ada', color: [239, 68, 68] },
  { name: 'Bram', color: [34, 197, 94] },
  { name: 'Cleo', color: [59, 130, 246] },
];

// --- vectors: a stable base per person (seeded) + small per-frame noise ---
const hash = (s) => {
  let h = 2166136261;
  for (const c of s) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const normalize = (v) => {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  return v.map((x) => x / s);
};
const baseVec = (name) => {
  const r = rng(hash(name));
  return normalize(Array.from({ length: DIM }, () => r() - 0.5));
};
const noisy = (base, eps = 0.04) => normalize(base.map((x) => x + eps * (Math.random() - 0.5)));

// --- a real solid-colour PNG data-URI (dep-free, via node:zlib) for the thumbnail ---
const CRC = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function pngDataUri(w, h, [r, g, b]) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // 8-bit RGB
  const row = Buffer.concat([
    Buffer.from([0]),
    ...Array.from({ length: w }, () => Buffer.from([r, g, b])),
  ]);
  const idat = zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)));
  const buf = Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return 'data:image/png;base64,' + buf.toString('base64');
}

const post = (p, body, headers = { 'content-type': 'application/json' }) =>
  fetch(URL + p, { method: 'POST', headers, body: JSON.stringify(body) })
    .then((r) => r.json())
    .catch((e) => ({ error: String(e) }));

async function seed() {
  const cfg = await post(
    '/api/admin/config',
    { facesEnabled: true },
    { 'content-type': 'application/json', 'x-admin-password': PW },
  );
  console.log(
    cfg.error
      ? `(could not auto-enable — turn on Familiar faces in the console)`
      : '✓ Familiar faces enabled',
  );
  for (const p of PEOPLE) {
    const base = baseVec(p.name),
      thumb = pngDataUri(24, 24, p.color);
    for (let i = 0; i < 8; i++)
      await post('/api/faces/observe', {
        faces: [{ embedding: noisy(base), thumb, quality: 0.9, trackId: 'sim-' + p.name }],
      });
    console.log(`✓ banked 8 frames of ${p.name}`);
  }
  console.log(
    `\nOpen the parent console → Familiar faces. You'll see ${PEOPLE.length} clusters to assign to your kids.`,
  );
  console.log(
    `Then:  node tools/faces-sim.mjs walk <name>   (e.g. ${PEOPLE[0].name}) to make the kiosk switch.`,
  );
}

async function walk(name) {
  const p = PEOPLE.find((x) => x.name.toLowerCase() === (name || '').toLowerCase());
  if (!p) {
    console.error(`Unknown person "${name}". Try: ${PEOPLE.map((x) => x.name).join(', ')}`);
    process.exit(1);
  }
  const out = await post('/api/faces/observe', {
    faces: [{ embedding: noisy(baseVec(p.name)), trackId: 'walkup' }],
  });
  if (out.error || out.enabled === false)
    return console.log('Faces are off — run `seed` first (or enable in the console).');
  if (out.identified?.length)
    console.log(
      `✓ Recognized ${p.name} (conf ${out.identified[0].confidence.toFixed(3)}). If the kiosk is on the idle screen, it should switch to that child now.`,
    );
  else
    console.log(
      `${p.name} isn't enrolled yet — assign their cluster to a kid in the console, then try again.`,
    );
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'seed') await seed();
else if (cmd === 'walk') await walk(arg);
else if (cmd === 'list') console.log('Simulated people:', PEOPLE.map((p) => p.name).join(', '));
else
  console.log(
    'Usage: node tools/faces-sim.mjs <seed | walk <name> | list>   (app must be running; URL=' +
      URL +
      ')',
  );
