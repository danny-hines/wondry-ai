import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { initSchema } from './db.js';
import { PORT, liveGenerationEnabled } from './config.js';
import { bus } from './events.js';
import conversation from './routes/conversation.js';
import artifacts from './routes/artifacts.js';
import profiles from './routes/profiles.js';
import admin from './routes/admin.js';
import tts from './routes/tts.js';
import presence from './routes/presence.js';
import wake from './routes/wake.js';
import kiosk, { isManaged } from './routes/kiosk.js';
import schedule from './routes/schedule.js';
import { ttsAvailable, ensureServer } from './services/tts.js';
import { initScheduler } from './services/scheduler.js';

// Changes on every process start; the kiosk's parent menu watches this to know the
// server has restarted (e.g. after a self-update) so it can reload onto new code.
const BOOT_ID = Date.now();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
initSchema();
initScheduler();   // re-arm timers that were pending across a restart

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use('/api', conversation);
app.use('/api', artifacts);
app.use('/api', profiles);
app.use('/api', tts);
app.use('/api', presence);
app.use('/api', wake);
app.use('/api', kiosk);
app.use('/api', schedule);
app.use('/api/admin', admin);

app.get('/api/health', (req, res) =>
  res.json({ ok: true, boot: BOOT_ID, managed: isManaged(), liveGeneration: liveGenerationEnabled(), tts: ttsAvailable() }));

// Serve the built React app (client/dist) with SPA history fallback so a reload on
// /admin/pages etc. still loads the app. /api and /ws are excluded. In dev the
// frontend is served by Vite (npm run dev) which proxies /api + /ws here.
const DIST = path.join(__dirname, '..', 'client', 'dist');
const hasBuild = fs.existsSync(path.join(DIST, 'index.html'));
if (hasBuild) {
  app.use(express.static(DIST));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
    res.sendFile(path.join(DIST, 'index.html'));
  });
} else {
  app.get('/', (req, res) => res.type('html').send(
    '<body style="font-family:system-ui;padding:40px"><h2>Wondry</h2>' +
    '<p>No client build found. For development run <code>npm run dev</code> (Vite + HMR on :5173). ' +
    'For production run <code>npm run build</code> then <code>npm start</code>.</p></body>'));
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
bus.on('event', (evt) => {
  const msg = JSON.stringify(evt);
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
});
wss.on('connection', (ws) => ws.send(JSON.stringify({ type: 'hello', at: Date.now() })));

server.listen(PORT, () => {
  console.log(`\n  Wondry running → http://localhost:${PORT}`);
  console.log(`  Kiosk:  http://localhost:${PORT}/`);
  console.log(`  Admin:  http://localhost:${PORT}/admin/`);
  console.log(`  Frontend: ${hasBuild ? 'serving client/dist' : 'NOT built (run npm run build, or npm run dev for HMR)'}`);
  console.log(`  Generation: ${liveGenerationEnabled() ? 'LIVE (Claude)' : 'MOCK (no API key set)'}`);
  console.log(`  TTS: ${ttsAvailable() ? 'Piper (voices installed)' : 'browser fallback (run: npm run setup-piper)'}\n`);
  if (ttsAvailable()) ensureServer().then((up) => up && console.log('  TTS: warm Piper server ready')).catch(() => {});
});
