// Piper TTS adapter with three speed wins:
//  1) WARM server: runs `python -m piper.http_server` once (model stays loaded) and POSTs
//     to it — no per-call model reload. Set PIPER_HTTP_URL to use an external server instead.
//  2) in-memory phrase CACHE: repeated lines (fillers, announcements) return instantly.
//  3) the kiosk chunks replies by sentence, so first audio starts after sentence 1.
// Falls back to spawn-per-call CLI, then to browser speech, if none of the above is available.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reserved "Robot" voice id. Robotic but instant — fits the dot-matrix look. We
// synthesize it server-side with espeak-ng (real WAV → reliable audio + avatar
// lip-sync through the normal pipeline). On a machine without espeak-ng (e.g. a
// dev laptop) the route falls back to the browser's SpeechSynthesis via a 204.
// The stored id stays 'browser' for back-compat with already-saved profiles.
export const BROWSER_VOICE = 'browser';

// ---- espeak-ng (server-side Robot voice) ----
const ESPEAK = process.env.ESPEAK_CMD || 'espeak-ng';
let _espeakOk;
export function espeakAvailable() {
  if (_espeakOk !== undefined) return _espeakOk;
  try { _espeakOk = spawnSync(ESPEAK, ['--version'], { timeout: 3000 }).status === 0; }
  catch { _espeakOk = false; }
  return _espeakOk;
}
export function synthViaEspeak(text) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `espeak-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
    // Defaults: US English, a touch slow, slightly raised pitch — clear for kids,
    // still robotic. Override via config.json -> tts.espeakArgs.
    const args = ['-w', tmp, ...((ttsCfg().espeakArgs || ['-v', 'en-us', '-s', '160', '-p', '55']).map(String)), String(text)];
    let err = '', proc;
    try { proc = spawn(ESPEAK, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (e) { return reject(e); }
    proc.on('error', reject);
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('close', (code) => {
      if (code !== 0) { try { fs.rmSync(tmp, { force: true }); } catch {} return reject(new Error(`espeak-ng exit ${code}: ${err.slice(0, 200)}`)); }
      try { const wav = fs.readFileSync(tmp); fs.rmSync(tmp, { force: true }); resolve(wav); }
      catch (e) { reject(e); }
    });
  });
}

const ttsCfg = () => getConfig().tts || {};
export function voicesDir() { return process.env.PIPER_VOICES_DIR || path.join(ROOT, ttsCfg().voicesDir || 'voices'); }

let _cmd;
export function piperCommand() {
  if (_cmd !== undefined) return _cmd;
  const env = process.env.PIPER_CMD;
  if (env && env.trim()) { _cmd = env.trim().split(/\s+/); return _cmd; }
  // Engine installed into a local venv by setup-piper — the Bookworm/PEP-668-safe
  // way, since system `pip install` is blocked on Pi OS Lite.
  const venvPy = path.join(ROOT, '.venv-piper', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
  if (fs.existsSync(venvPy)) { _cmd = [venvPy, '-m', 'piper']; return _cmd; }
  const bin = path.join(ROOT, 'vendor', 'piper', process.platform === 'win32' ? 'piper.exe' : 'piper');
  if (fs.existsSync(bin)) { _cmd = [bin]; return _cmd; }
  _cmd = [process.platform === 'win32' ? 'python' : 'python3', '-m', 'piper'];
  return _cmd;
}

export function listVoices() {
  try {
    return fs.readdirSync(voicesDir()).filter((f) => f.endsWith('.onnx')).map((f) => f.replace(/\.onnx$/, '')).sort();
  } catch { return []; }
}
function voiceFile(voiceId) {
  const dir = voicesDir();
  const want = voiceId && path.join(dir, `${voiceId}.onnx`);
  if (want && fs.existsSync(want)) return want;
  const def = path.join(dir, `${ttsCfg().defaultVoice || ''}.onnx`);
  if (fs.existsSync(def)) return def;
  const any = listVoices()[0];
  return any ? path.join(dir, `${any}.onnx`) : null;
}
export function ttsAvailable() {
  return !!process.env.PIPER_HTTP_URL || listVoices().length > 0;
}

// ---- in-memory phrase cache (capped) ----
const CACHE = new Map();
const CACHE_MAX = 60;
function cacheGet(k) { const v = CACHE.get(k); if (v) { CACHE.delete(k); CACHE.set(k, v); } return v; }
function cachePut(k, v) { CACHE.set(k, v); if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value); }

// ---- warm HTTP server ----
const PORT = Number(process.env.PIPER_HTTP_PORT || 5117);
let serverState; // undefined | Promise<bool> | 'up' | 'down'
let serverProc = null;
const baseUrl = () => process.env.PIPER_HTTP_URL || `http://127.0.0.1:${PORT}`;

function canManageServer() {
  if (process.env.PIPER_HTTP_URL) return false;     // external server: don't manage
  const c = piperCommand();
  return c.length >= 3 && c[1] === '-m' && /(^|[\\/])piper$/.test(c[2]); // python -m piper form only
}

export async function ensureServer() {
  if (process.env.PIPER_HTTP_URL) return true;
  if (serverState === 'up') return true;
  if (serverState === 'down') return false;
  if (serverState && typeof serverState.then === 'function') return serverState;
  if (!canManageServer() || listVoices().length === 0) { serverState = 'down'; return false; }
  serverState = (async () => {
    const c = piperCommand();
    const args = ['-m', 'piper.http_server', '--data-dir', voicesDir(), '--port', String(PORT)];
    // Extra env for the warm server (config.json -> tts.serverEnv), e.g. OMP_NUM_THREADS
    // to tune onnxruntime threading on the Pi — a knob to experiment with on hardware.
    const env = { ...process.env };
    for (const [k, v] of Object.entries(ttsCfg().serverEnv || {})) env[k] = String(v);
    try { serverProc = spawn(c[0], args, { stdio: 'ignore', env }); }
    catch { serverState = 'down'; return false; }
    serverProc.on('exit', () => { serverState = 'down'; serverProc = null; });
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      try { const r = await fetch(baseUrl() + '/voices'); if (r.ok) { serverState = 'up'; return true; } } catch {}
      await sleep(400);
    }
    serverState = 'down'; return false;
  })();
  return serverState;
}

function synthParams(body) {
  const s = ttsCfg().synthesis || {};
  for (const k of ['length_scale', 'noise_scale', 'noise_w_scale']) if (s[k] != null) body[k] = s[k];
  return body;
}

async function synthViaHttp(text, voiceId) {
  const body = synthParams({ text });
  const v = voiceId || ttsCfg().defaultVoice;
  if (v) body.voice = v;
  const r = await fetch(baseUrl() + '/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('piper http ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

function synthViaSpawn(text, voiceId) {
  return new Promise((resolve, reject) => {
    const model = voiceFile(voiceId);
    if (!model) return reject(new Error('no voice model installed (run: npm run setup-piper)'));
    const cmd = piperCommand();
    const tmp = path.join(os.tmpdir(), `piper-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
    const args = [...cmd.slice(1), '-m', model, '-f', tmp, ...((ttsCfg().synthArgs || []).map(String))];
    let err = '', proc;
    try { proc = spawn(cmd[0], args, { stdio: ['pipe', 'ignore', 'pipe'] }); }
    catch (e) { return reject(e); }
    proc.on('error', reject);
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('close', (code) => {
      if (code !== 0) { try { fs.rmSync(tmp, { force: true }); } catch {} return reject(new Error(`piper exit ${code}: ${err.slice(0, 200)}`)); }
      try { const wav = fs.readFileSync(tmp); fs.rmSync(tmp, { force: true }); resolve(wav); }
      catch (e) { reject(e); }
    });
    proc.stdin.write(text); proc.stdin.end();
  });
}

export async function synthesize(text, voiceId) {
  const key = (voiceId || ttsCfg().defaultVoice || '') + '|' + text;
  const hit = cacheGet(key);
  if (hit) return hit;
  const wav = (await ensureServer()) ? await synthViaHttp(text, voiceId) : await synthViaSpawn(text, voiceId);
  cachePut(key, wav);
  return wav;
}
