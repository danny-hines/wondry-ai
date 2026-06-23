// Speech-to-text behind a tiny interface so the Reader doesn't care which engine
// transcribes. Today: the browser's Web Speech API (Chrome). On the Pi: capture
// audio and POST to /api/stt (whisper.cpp) — same `listen()` contract, so the
// Reader is unchanged. Promise-based "listen once": start, resolve on the final
// transcript (or empty on timeout/error so the UI can gently say "let's try again").
import { serverTranscribe } from '../lib/api';

export interface SttResult { transcript: string; backend: string }
export interface SttSession { result: Promise<SttResult>; stop(): void }
export interface LiveSession { stop(): void }
export interface SttEngine {
  available: boolean;
  live: boolean;        // supports streaming (interim) transcripts for live word-matching
  backend: string;
  listen(maxMs?: number): SttSession;
  // Streaming: calls onText with the cumulative transcript (final + interim) as the
  // child speaks, so the Reader can advance word-by-word. stop() ends the session.
  listenLive(onText: (text: string) => void, maxMs?: number): LiveSession;
}

function webSpeechEngine(): SttEngine | null {
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SR) return null;
  return {
    available: true,
    live: true,
    backend: 'webspeech',
    // Streaming session: continuous + interim results, auto-restarting if the engine
    // stops early, so the child can read at their own pace until the line is done.
    listenLive(onText, maxMs = 45000): LiveSession {
      const rec = new SR();
      rec.lang = 'en-US';
      rec.interimResults = true;
      rec.continuous = true;
      rec.maxAlternatives = 1;
      let stopped = false;
      let finalText = '';
      rec.onresult = (e: any) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += r[0].transcript + ' ';
          else interim += r[0].transcript + ' ';
        }
        onText((finalText + interim).trim());
      };
      rec.onerror = () => {};
      rec.onend = () => { if (!stopped) { try { rec.start(); } catch {} } };
      try { rec.start(); } catch {}
      const timer = setTimeout(() => { stopped = true; try { rec.stop(); } catch {} }, maxMs);
      return { stop: () => { stopped = true; clearTimeout(timer); try { rec.stop(); } catch {} } };
    },
    listen(maxMs = 12000): SttSession {
      const rec = new SR();
      rec.lang = 'en-US';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const result = new Promise<SttResult>((resolve) => {
        const finish = (transcript: string) => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          try { rec.stop(); } catch {}
          resolve({ transcript, backend: 'webspeech' });
        };
        rec.onresult = (e: any) => finish(e?.results?.[0]?.[0]?.transcript || '');
        rec.onerror = () => finish('');
        rec.onend = () => finish('');
        timer = setTimeout(() => finish(''), maxMs);
        try { rec.start(); } catch { finish(''); }
      });
      return { result, stop: () => { try { rec.stop(); } catch {} } };
    },
  };
}

// Server engine: records a line of audio with MediaRecorder and POSTs it to
// /api/stt (whisper.cpp on the Pi). One-shot only — whisper transcribes a whole
// clip — so `live` is false and the Reader uses its listen-once path. When whisper
// isn't configured the server returns empty and the Reader says "didn't catch that".
function serverEngine(): SttEngine {
  const canCapture = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  return {
    available: canCapture,
    live: false,
    backend: 'server',
    listen(maxMs = 8000): SttSession {
      let stop = () => {};
      const result = new Promise<SttResult>((resolve) => {
        if (!canCapture) { resolve({ transcript: '', backend: 'server' }); return; }
        navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
          const chunks: BlobPart[] = [];
          const mr = new MediaRecorder(stream);
          let done = false;
          const finish = async () => {
            if (done) return; done = true;
            clearTimeout(timer);
            try { mr.stop(); } catch {}
            stream.getTracks().forEach((t) => t.stop());
            const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
            const r = await serverTranscribe(blob);
            resolve({ transcript: r.text || '', backend: 'server' });
          };
          mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
          mr.onstop = () => { void finish(); };
          stop = () => { try { mr.stop(); } catch {} };
          const timer = setTimeout(() => { try { mr.stop(); } catch {} }, maxMs);
          mr.start();
        }).catch(() => resolve({ transcript: '', backend: 'server' }));
      });
      return { result, stop: () => stop() };
    },
    listenLive(): LiveSession { return { stop: () => {} }; }, // whisper one-shot has no streaming
  };
}

// Prefer the browser's Web Speech engine in dev; on the Pi (whose kiosk Chromium has
// no Web Speech) force the whisper path with either a `?stt=server` URL param (the
// installer points the kiosk at that when whisper is set up) or localStorage.
export function getStt(): SttEngine {
  let forceServer = false;
  try {
    forceServer = new URLSearchParams(location.search).get('stt') === 'server'
      || localStorage.getItem('wondry_stt') === 'server';
  } catch { /* no storage / no location */ }
  if (forceServer) return serverEngine();
  return webSpeechEngine() || serverEngine();
}
