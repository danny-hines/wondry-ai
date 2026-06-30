import { useRef, useState, useCallback, type RefObject } from 'react';
import type { AvatarEngine } from './avatarEngine';
import { ttsArrayBuffer } from '../lib/api';
import { stripMarkdown } from '../lib/markdown';
import { maskProfanity } from '../lib/profanity';
import { audioCtx } from './audio';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function splitSentences(t: string): string[] {
  return (t.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [t]).map((s) => s.trim()).filter(Boolean);
}

// Returns speak(text, …): strips markdown, splits into sentences, and plays them with
// a GAPLESS pipeline — it keeps a few syntheses in flight ahead of playback and, as
// each clip decodes, schedules it on the AudioContext timeline to start the instant
// the previous one ends (src.start(prevEnd)), so there's no decode/event-loop gap
// between sentences. Each Piper clip keeps its own natural trailing silence, so the
// pacing stays natural — we just remove the extra jitter. One analyser spans the whole
// utterance so the avatar's mouth is driven continuously. Falls back to browser speech
// if Piper isn't available. A newer speak()/stop() supersedes any in-flight speech.
export function useSpeech(avatarRef: RefObject<AvatarEngine | null>) {
  const genRef = useRef(0);
  const srcsRef = useRef<AudioBufferSourceNode[]>([]);
  // Key of the bubble currently being spoken (passed by the caller as `token`),
  // so the UI can animate that bubble for the duration of the speech.
  const [speakingId, setSpeakingId] = useState<string | null>(null);

  const stopAudio = () => {
    for (const s of srcsRef.current) { try { s.onended = null; s.stop(); } catch {} }
    srcsRef.current = [];
    avatarRef.current?.endSpeaking();
  };

  // Interrupt any in-progress (or queued) speech — e.g. when the child taps to talk so
  // the avatar doesn't speak over them. Bumping the generation supersedes the in-flight
  // pipeline in speak() so no further sentence is scheduled.
  const stop = useCallback(() => {
    genRef.current++;
    stopAudio();
    setSpeakingId(null);
  }, []);

  // `voice` overrides the per-profile voice (admin preview). `onProgress(0..1)` reports
  // OVERALL playback across the reply (for the bubble's word reveal / the Reader sweep).
  // `onStart` fires once the first audio is scheduled — the caller hands thinking→speaking.
  const speak = useCallback(async (rawText: string, profileId?: string, token?: string, voice?: string, onProgress?: (f: number) => void, onStart?: () => void) => {
    const avatar = avatarRef.current; if (!avatar) { onStart?.(); return; }
    // Final TTS gate: never speak profanity (chat replies, announcements, replays, a
    // page's tap-to-hear). Masked before markdown strip.
    const text = stripMarkdown(maskProfanity(rawText || '')).trim(); if (!text) { onStart?.(); return; }
    const id = ++genRef.current;
    stopAudio();
    setSpeakingId(token ?? null);
    let started = false;
    const markStarted = () => { if (!started) { started = true; onStart?.(); } };

    const sentences = splitSentences(text);
    // Keep a few syntheses in flight ahead of playback (the Pi serializes them, but is
    // never left idle waiting for the next request), so the next clip is ready in time.
    const LOOKAHEAD = 3;
    const fetches: (Promise<ArrayBuffer | null> | undefined)[] = [];
    const fire = (i: number) => { if (i < sentences.length && !fetches[i]) fetches[i] = ttsArrayBuffer(sentences[i], profileId, voice); };
    for (let i = 0; i < LOOKAHEAD; i++) fire(i);

    const ctx = audioCtx();   // shared warm context (kept alive to avoid the Pi's first-sound clipping)
    // One analyser for the whole utterance: every clip feeds it, so the avatar mouth is
    // driven continuously across sentence boundaries (no lip-sync gap).
    const analyser = ctx.createAnalyser(); analyser.fftSize = 1024; analyser.connect(ctx.destination);
    const data = new Uint8Array(analyser.fftSize);
    let firstStart = 0, endAt = 0, schedulingDone = false, raf = 0;
    const startLoop = () => {
      avatar.beginSpeaking();
      const tick = () => {
        if (id !== genRef.current) return;          // superseded
        analyser.getByteTimeDomainData(data);
        let sum = 0; for (let k = 0; k < data.length; k++) { const v = (data[k] - 128) / 128; sum += v * v; }
        avatar.setLevel(Math.min(1, Math.sqrt(sum / data.length) * 6));
        if (onProgress && firstStart && endAt > firstStart) onProgress(Math.min(1, (ctx.currentTime - firstStart) / (endAt - firstStart)));
        if (!schedulingDone || ctx.currentTime < endAt) raf = requestAnimationFrame(tick);
        else { avatar.setLevel(0); avatar.endSpeaking(); onProgress?.(1); }
      };
      tick();
    };

    let cursor = 0;   // ctx time at which the next clip should start
    try {
      for (let i = 0; i < sentences.length; i++) {
        fire(i);
        const ab = await fetches[i];
        fire(i + LOOKAHEAD);                        // keep the pipeline full
        if (id !== genRef.current) return;
        if (!ab) {                                   // synthesis failed / no Piper
          if (i === 0) { markStarted(); onProgress?.(1); await avatar.speakFallback(text); return; }
          continue;                                  // skip a mid-stream miss, keep the flow
        }
        let audioBuf: AudioBuffer;
        try { audioBuf = await ctx.decodeAudioData(ab.slice(0)); } catch { continue; }
        if (id !== genRef.current) return;
        const src = ctx.createBufferSource(); src.buffer = audioBuf; src.connect(analyser);
        // Gapless: start exactly when the previous clip ends; if synthesis fell behind,
        // start as soon as possible instead (a small catch-up gap, not a stall).
        const startAt = Math.max(ctx.currentTime + 0.02, cursor || 0);
        src.start(startAt);
        srcsRef.current.push(src);
        cursor = startAt + audioBuf.duration;
        endAt = cursor;
        if (!firstStart) { firstStart = startAt; markStarted(); startLoop(); }
      }
      schedulingDone = true;
      if (!firstStart) { markStarted(); return; }   // nothing got scheduled at all
      // Stay pending until playback finishes so speakingId (the speaking bubble) holds.
      while (id === genRef.current && ctx.currentTime < endAt) await sleep(60);
    } finally {
      schedulingDone = true;
      cancelAnimationFrame(raf);
      if (id === genRef.current) { setSpeakingId(null); srcsRef.current = []; avatar.endSpeaking(); }
    }
  }, [avatarRef]);

  return { speak, speakingId, stop };
}
