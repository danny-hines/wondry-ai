// whisper.cpp speech-to-text adapter, mirroring the Piper TTS pattern: configured
// via env, with a graceful "unavailable" result so in dev (and any host without
// whisper) the kiosk falls back to the browser's Web Speech API. Two backends:
//   WHISPER_HTTP_URL — a running whisper.cpp server's /inference endpoint.
//   WHISPER_CMD + WHISPER_MODEL — spawn the whisper-cli binary per call.
// e.g.  WHISPER_CMD="/opt/whisper.cpp/build/bin/whisper-cli"
//       WHISPER_MODEL="/opt/whisper.cpp/models/ggml-base.en.bin"
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function sttBackend() {
  if (process.env.WHISPER_HTTP_URL) return 'whisper-http';
  if (process.env.WHISPER_CMD && process.env.WHISPER_MODEL) return 'whisper-cli';
  return 'none';
}
export function sttAvailable() { return sttBackend() !== 'none'; }

const extFor = (mime) => (/webm/.test(mime) ? '.webm' : /ogg/.test(mime) ? '.ogg' : /mp4|m4a|aac/.test(mime) ? '.m4a' : '.wav');

// Transcribe an audio buffer (bytes captured by the browser). Returns { text }.
export async function transcribe(buf, { mime = 'audio/wav' } = {}) {
  if (!buf || !buf.length) return { text: '' };
  if (process.env.WHISPER_HTTP_URL) return transcribeHttp(buf, mime);
  if (process.env.WHISPER_CMD && process.env.WHISPER_MODEL) return transcribeCli(buf, mime);
  return { text: '' };
}

async function transcribeHttp(buf, mime) {
  // whisper.cpp `whisper-server`: multipart form with a 'file' field -> { text }.
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), 'audio' + extFor(mime));
  form.append('response_format', 'json');
  const r = await fetch(process.env.WHISPER_HTTP_URL, { method: 'POST', body: form });
  if (!r.ok) throw new Error('whisper http ' + r.status);
  const j = await r.json().catch(() => ({}));
  return { text: String(j.text || '').trim() };
}

function transcribeCli(buf, mime) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `wstt-${Date.now()}-${Math.random().toString(36).slice(2)}${extFor(mime)}`);
    const outBase = tmp + '.out';
    const cleanup = () => { for (const f of [tmp, outBase + '.txt']) { try { fs.rmSync(f, { force: true }); } catch {} } };
    try { fs.writeFileSync(tmp, buf); } catch (e) { return reject(e); }
    const cmd = process.env.WHISPER_CMD.trim().split(/\s+/);
    // whisper-cli -m <model> -f <audio> -nt -otxt -of <outBase>  -> writes <outBase>.txt
    const args = [...cmd.slice(1), '-m', process.env.WHISPER_MODEL, '-f', tmp, '-nt', '-otxt', '-of', outBase];
    let err = '', proc;
    try { proc = spawn(cmd[0], args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (e) { cleanup(); return reject(e); }
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => { cleanup(); reject(e); });
    proc.on('close', (code) => {
      let text = '';
      try { text = fs.readFileSync(outBase + '.txt', 'utf8').trim(); } catch {}
      cleanup();
      if (code !== 0 && !text) return reject(new Error(`whisper exit ${code}: ${err.slice(0, 200)}`));
      resolve({ text });
    });
  });
}
