import { useRef, useState, useCallback, type RefObject } from 'react';
import type { AvatarEngine } from './avatarEngine';
import { ttsArrayBuffer } from '../lib/api';
import { stripMarkdown } from '../lib/markdown';

function splitSentences(t: string): string[] {
  return (t.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [t]).map((s) => s.trim()).filter(Boolean);
}

// Returns speak(text, profileId): strips markdown, splits into sentences, plays
// sentence i while fetching i+1, drives the avatar mouth from a real AnalyserNode,
// and supersedes any in-flight speech. Falls back to browser speech if no Piper.
export function useSpeech(avatarRef: RefObject<AvatarEngine | null>) {
  const ctxRef = useRef<AudioContext | null>(null);
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

  const playBuf = async (arrayBuffer: ArrayBuffer, id: number, onProgress?: (f: number) => void) => {
    const avatar = avatarRef.current; if (!avatar) return;
    if (!ctxRef.current) ctxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    const ctx = ctxRef.current!;
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
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
  const speak = useCallback(async (rawText: string, profileId?: string, token?: string, voice?: string, onProgress?: (f: number) => void) => {
    const avatar = avatarRef.current; if (!avatar) return;
    const text = stripMarkdown(rawText || '').trim(); if (!text) return;
    const id = ++genRef.current;
    stopAudio();
    setSpeakingId(token ?? null);
    try {
      const sentences = splitSentences(text);
      let next = ttsArrayBuffer(sentences[0], profileId, voice);
      for (let i = 0; i < sentences.length; i++) {
        if (id !== genRef.current) return;
        let buf: ArrayBuffer | null = null;
        try { buf = await next; } catch { buf = null; }
        next = (i + 1 < sentences.length) ? ttsArrayBuffer(sentences[i + 1], profileId, voice) : Promise.resolve(null);
        if (id !== genRef.current) return;
        if (buf === null) { await avatar.speakFallback(i === 0 ? text : sentences[i]); if (i === 0) return; continue; }
        await playBuf(buf, id, onProgress);
      }
    } finally {
      // Only clear if we're still the active speech — a newer speak() has already
      // set its own token and must not be cleared by this one finishing/aborting.
      if (id === genRef.current) setSpeakingId(null);
    }
  }, [avatarRef]);

  return { speak, speakingId };
}
