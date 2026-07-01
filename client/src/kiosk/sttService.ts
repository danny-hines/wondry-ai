// Speech-to-text behind a tiny interface so the Reader doesn't care which engine
// transcribes. Today: the browser's Web Speech API (Chrome). On the Pi: capture
// audio and POST to /api/stt (whisper.cpp) — same `listen()` contract, so the
// Reader is unchanged. Promise-based "listen once": start, resolve on the final
// transcript (or empty on timeout/error so the UI can gently say "let's try again").
import { serverTranscribe } from '../lib/api';

export interface SttResult {
  transcript: string;
  backend: string;
}
export interface SttSession {
  result: Promise<SttResult>;
  stop(): void;
}
export interface LiveSession {
  stop(): void;
}
export interface SttEngine {
  available: boolean;
  live: boolean; // supports streaming (interim) transcripts for live word-matching
  backend: string;
  // onCaptureEnd fires the instant audio capture stops (tap-to-stop, silence
  // auto-stop, or timeout) — before transcription resolves — so the UI can show
  // "working on it" without waiting out a slow transcribe (whisper on the Pi).
  listen(maxMs?: number, onCaptureEnd?: () => void): SttSession;
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
      rec.onend = () => {
        if (!stopped) {
          try {
            rec.start();
          } catch {}
        }
      };
      try {
        rec.start();
      } catch {}
      const timer = setTimeout(() => {
        stopped = true;
        try {
          rec.stop();
        } catch {}
      }, maxMs);
      return {
        stop: () => {
          stopped = true;
          clearTimeout(timer);
          try {
            rec.stop();
          } catch {}
        },
      };
    },
    listen(maxMs = 12000, onCaptureEnd?: () => void): SttSession {
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
          onCaptureEnd?.();
          try {
            rec.stop();
          } catch {}
          resolve({ transcript, backend: 'webspeech' });
        };
        rec.onresult = (e: any) => finish(e?.results?.[0]?.[0]?.transcript || '');
        rec.onerror = () => finish('');
        rec.onend = () => finish('');
        timer = setTimeout(() => finish(''), maxMs);
        try {
          rec.start();
        } catch {
          finish('');
        }
      });
      return {
        result,
        stop: () => {
          try {
            rec.stop();
          } catch {}
        },
      };
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
    listen(maxMs = 11000, onCaptureEnd?: () => void): SttSession {
      let stop = () => {};
      const result = new Promise<SttResult>((resolve) => {
        if (!canCapture) {
          resolve({ transcript: '', backend: 'server' });
          return;
        }
        navigator.mediaDevices
          .getUserMedia({ audio: true })
          .then((stream) => {
            const chunks: BlobPart[] = [];
            const mr = new MediaRecorder(stream);
            let done = false,
              raf = 0;
            let ctx: AudioContext | null = null;
            let heard = false,
              vadActive = false; // shared with the VAD tick below
            const finish = async () => {
              if (done) return;
              done = true;
              onCaptureEnd?.();
              clearTimeout(timer);
              cancelAnimationFrame(raf);
              try {
                ctx?.close();
              } catch {}
              try {
                mr.stop();
              } catch {}
              stream.getTracks().forEach((t) => t.stop());
              // No speech the whole window: return empty instead of transcribing — whisper
              // hallucinates phrases on silence ("thank you", etc.), which would fake a turn
              // and loop the auto-listen-after-a-question. Empty makes the caller just stop.
              if (vadActive && !heard) {
                resolve({ transcript: '', backend: 'server' });
                return;
              }
              const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
              const r = await serverTranscribe(blob);
              resolve({ transcript: r.text || '', backend: 'server' });
            };
            mr.ondataavailable = (e) => {
              if (e.data.size) chunks.push(e.data);
            };
            mr.onstop = () => {
              void finish();
            };
            stop = () => {
              try {
                mr.stop();
              } catch {}
            };
            const timer = setTimeout(() => {
              try {
                mr.stop();
              } catch {}
            }, maxMs);

            // Voice-activity auto-stop: end ~SILENCE_MS after the child stops talking
            // (once we've heard speech) instead of waiting out the whole window. The
            // maxMs cap and tap-to-stop still apply. Tune SILENCE_MS to taste.
            try {
              ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
              const node = ctx.createMediaStreamSource(stream);
              const analyser = ctx.createAnalyser();
              analyser.fftSize = 1024;
              node.connect(analyser);
              const data = new Uint8Array(analyser.fftSize);
              const QUIET = 0.025; // RMS below this counts as silence
              const SILENCE_MS = 1500; // trailing silence before we stop (room to pause and think)
              const MIN_MS = 500; // give them a beat to start before arming
              const VOICED_MS = 220; // cumulative voiced audio needed before it counts as real
              // speech — ignores clicks/pops/fan noise that would otherwise
              // arm the silence-stop and cut the window to a couple seconds.
              vadActive = true;
              let quietAt = 0,
                voicedMs = 0,
                prev = performance.now();
              const t0 = performance.now();
              const tick = () => {
                analyser.getByteTimeDomainData(data);
                let sum = 0;
                for (let k = 0; k < data.length; k++) {
                  const v = (data[k] - 128) / 128;
                  sum += v * v;
                }
                const rms = Math.sqrt(sum / data.length),
                  now = performance.now();
                const dt = now - prev;
                prev = now;
                if (rms > QUIET) {
                  voicedMs += dt;
                  if (voicedMs >= VOICED_MS) heard = true;
                  quietAt = 0;
                } else if (heard && now - t0 > MIN_MS) {
                  if (!quietAt) quietAt = now;
                  else if (now - quietAt > SILENCE_MS) {
                    try {
                      mr.stop();
                    } catch {}
                    return;
                  }
                }
                raf = requestAnimationFrame(tick);
              };
              raf = requestAnimationFrame(tick);
            } catch {
              /* no AudioContext → fall back to maxMs / tap-to-stop */
            }

            mr.start();
          })
          .catch(() => resolve({ transcript: '', backend: 'server' }));
      });
      return { result, stop: () => stop() };
    },
    listenLive(): LiveSession {
      return { stop: () => {} };
    }, // whisper one-shot has no streaming
  };
}

// Prefer the browser's Web Speech engine in dev; on the Pi (whose kiosk Chromium has
// no Web Speech) force the whisper path with either a `?stt=server` URL param (the
// installer points the kiosk at that when whisper is set up) or localStorage.
export function getStt(): SttEngine {
  let forceServer = false;
  try {
    forceServer =
      new URLSearchParams(location.search).get('stt') === 'server' ||
      localStorage.getItem('wondry_stt') === 'server';
  } catch {
    /* no storage / no location */
  }
  if (forceServer) return serverEngine();
  return webSpeechEngine() || serverEngine();
}
