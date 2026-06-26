import { useRef, useState, useCallback, type RefObject } from 'react';
import type { AvatarEngine } from './avatarEngine';
import { ttsArrayBuffer } from '../lib/api';
import { stripMarkdown } from '../lib/markdown';
import { maskProfanity } from '../lib/profanity';
import { audioCtx } from './audio';

function splitSentences(t: string): string[] {
  return (t.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [t]).map((s) => s.trim()).filter(Boolean);
}

// Returns speak(text, profileId): strips markdown, splits into sentences, plays
// sentence i while fetching i+1, drives the avatar mouth from a real AnalyserNode,
// and supersedes any in-flight speech. Falls back to browser speech if no Piper.
export function useSpeech(avatarRef: RefObject<AvatarEngine | null>) {
  const genRef = useRef(0);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  // Key of the bubble currently being spoken (passed by the caller as `token`),
  // so the UI can animate that bubble for the duration of the speech.
  const [speakingId, setSpeakingId] = useState<string | null>(null);

  const stopAudio = () => {
    const s = srcRef.current;
    if (s) { try { s.onended = null; s.stop(); } catch {} srcRef.current = null; }
    avatarRef.current?.endSpeaking();
  };

  // Interrupt any in-progress (or queued) speech — e.g. when the child taps to talk so
  // the avatar doesn't speak over them. Bumping the generation supersedes the in-flight
  // sentence loop in speak() so the next sentence never starts.
  const stop = useCallback(() => {
    genRef.current++;
    stopAudio();
    setSpeakingId(null);
  }, []);

  const playBuf = async (arrayBuffer: ArrayBuffer, id: number, onProgress?: (f: number) => void) => {
    const avatar = avatarRef.current; if (!avatar) return;
    const ctx = audioCtx();   // shared warm context (kept alive to avoid the Pi's first-sound clipping)
    let audioBuf: AudioBuffer;
    try { audioBuf = await ctx.decodeAudioData(arrayBuffer.slice(0)); } catch { return; }
    if (id !== genRef.current) return;
    const src = ctx.createBufferSource(); src.buffer = audioBuf;
    const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    src.connect(analyser); analyser.connect(ctx.destination);
    const data = new Uint8Array(analyser.fftSize);
    srcRef.current = src;
    avatar.beginSpeaking();
    let raf = 0;
    let startedAt = 0;
    const dur = audioBuf.duration || 0;
    const loop = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0; for (let k = 0; k < data.length; k++) { const v = (data[k] - 128) / 128; sum += v * v; }
      avatar.setLevel(Math.min(1, Math.sqrt(sum / data.length) * 6));
      // Report playback fraction so callers (the Reader) can sweep a word highlight
      // in time with Piper audio — Piper gives no word timestamps, so this is the hook.
      if (onProgress && startedAt && dur) onProgress(Math.min(1, (ctx.currentTime - startedAt) / dur));
      raf = requestAnimationFrame(loop);
    };
    loop();
    await new Promise<void>((resolve) => { src.onended = () => resolve(); startedAt = ctx.currentTime; src.start(); });
    cancelAnimationFrame(raf);
    onProgress?.(1);
    if (srcRef.current === src) { srcRef.current = null; avatar.endSpeaking(); }
  };

  // `voice` overrides the per-profile voice (used by the admin preview to audition a
  // not-yet-saved selection); omit it and the server resolves the profile's voice.
  // `onProgress(0..1)` reports OVERALL playback across the reply's sentences (for the
  // bubble's word reveal). `onStart` fires once the first audio is actually ready —
  // the caller uses it to hand off thinking→speaking (TTS synth can lag a second or two).
  const speak = useCallback(async (rawText: string, profileId?: string, token?: string, voice?: string, onProgress?: (f: number) => void, onStart?: () => void) => {
    const avatar = avatarRef.current; if (!avatar) { onStart?.(); return; }
    // Final TTS gate: never speak profanity (covers chat replies, announcements,
    // replays, and a page's tap-to-hear postMessage). Masked before markdown strip.
    const text = stripMarkdown(maskProfanity(rawText || '')).trim(); if (!text) { onStart?.(); return; }
    const id = ++genRef.current;
    stopAudio();
    setSpeakingId(token ?? null);
    let started = false;
    const markStarted = () => { if (!started) { started = true; onStart?.(); } };
    try {
      const sentences = splitSentences(text);
      let next = ttsArrayBuffer(sentences[0], profileId, voice);
      for (let i = 0; i < sentences.length; i++) {
        if (id !== genRef.current) return;
        let buf: ArrayBuffer | null = null;
        try { buf = await next; } catch { buf = null; }
        next = (i + 1 < sentences.length) ? ttsArrayBuffer(sentences[i + 1], profileId, voice) : Promise.resolve(null);
        if (id !== genRef.current) return;
        markStarted();   // first audio (or fallback) is ready
        if (buf === null) { onProgress?.(1); await avatar.speakFallback(i === 0 ? text : sentences[i]); if (i === 0) return; continue; }
        await playBuf(buf, id, (f) => onProgress?.((i + f) / sentences.length));
      }
    } finally {
      // Only clear if we're still the active speech — a newer speak() has already
      // set its own token and must not be cleared by this one finishing/aborting.
      if (id === genRef.current) setSpeakingId(null);
    }
  }, [avatarRef]);

  return { speak, speakingId, stop };
}
