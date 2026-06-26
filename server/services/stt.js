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

// whisper emits non-speech markers as literal text on silence/noise — [BLANK_AUDIO],
// [ Silence ], (music), *laughs*, etc. Strip those bracketed/parenthesised/starred
// annotations; if nothing with a letter or digit remains, it wasn't speech → ''. This
// stops a silence marker from being sent as a turn (and looping the auto-listen).
export function cleanTranscript(text) {
  const t = String(text || '')
    .replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/\*[^*]*\*/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return /[a-z0-9]/i.test(t) ? t : '';
}

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
  return { text: cleanTranscript(j.text) };
}

// Spawn a process, capturing stderr; resolves { code, err } on close (never
// rejects on non-zero exit — callers decide what a bad code means), rejects only
// if the binary can't be spawned at all.
function runProc(file, args) {
  return new Promise((resolve, reject) => {
    let err = '', proc;
    try { proc = spawn(file, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (e) { return reject(e); }
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, err }));
  });
}

const FFMPEG = process.env.FFMPEG_CMD || 'ffmpeg';

async function transcribeCli(buf, mime) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const inFile = path.join(os.tmpdir(), `wstt-${stamp}${extFor(mime)}`);
  const wavFile = path.join(os.tmpdir(), `wstt-${stamp}.wav`);
  const outBase = path.join(os.tmpdir(), `wstt-${stamp}.out`);
  const cleanup = () => { for (const f of [inFile, wavFile, outBase + '.txt']) { try { fs.rmSync(f, { force: true }); } catch {} } };
  try {
    fs.writeFileSync(inFile, buf);
    // 1. Transcode whatever the browser sent (webm/opus, ogg, mp4…) to 16 kHz mono
    //    WAV — whisper.cpp's bundled miniaudio decoder only reads WAV/FLAC/MP3.
    const ff = await runProc(FFMPEG, ['-nostdin', '-loglevel', 'error', '-y', '-i', inFile, '-ar', '16000', '-ac', '1', '-f', 'wav', wavFile]);
    if (ff.code !== 0) throw new Error(`ffmpeg exit ${ff.code}: ${ff.err.slice(0, 200)}`);
    // 2. whisper-cli -m <model> -f <wav> -nt -otxt -of <outBase>  -> writes <outBase>.txt
    const cmd = process.env.WHISPER_CMD.trim().split(/\s+/);
    const args = [...cmd.slice(1), '-m', process.env.WHISPER_MODEL, '-f', wavFile, '-nt', '-otxt', '-of', outBase];
    const w = await runProc(cmd[0], args);
    let text = '';
    try { text = fs.readFileSync(outBase + '.txt', 'utf8').trim(); } catch {}
    if (w.code !== 0 && !text) throw new Error(`whisper exit ${w.code}: ${w.err.slice(0, 200)}`);
    return { text: cleanTranscript(text) };
  } finally {
    cleanup();
  }
}
