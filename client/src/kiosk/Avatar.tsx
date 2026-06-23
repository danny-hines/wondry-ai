import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { AvatarEngine, type Mood } from './avatarEngine';

// Thin React wrapper around the canvas AvatarEngine. The imperative handle DELEGATES
// to the live engine ref, so calls work even though the engine is created in a passive
// effect (which runs after this layout-phase handle is set).
export const Avatar = forwardRef<AvatarEngine, { className?: string }>(function Avatar(_props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<AvatarEngine | null>(null);
  useEffect(() => {
    if (!canvasRef.current) return;
    const engine = new AvatarEngine(canvasRef.current);
    engineRef.current = engine;
    return () => engine.destroy();
  }, []);
  useImperativeHandle(ref, () => ({
    setMood: (m: Mood) => engineRef.current?.setMood(m),
    setColor: (c: string) => engineRef.current?.setColor(c),
    beginSpeaking: () => engineRef.current?.beginSpeaking(),
    setLevel: (v: number) => engineRef.current?.setLevel(v),
    endSpeaking: () => engineRef.current?.endSpeaking(),
    speakFallback: (t: string) => engineRef.current?.speakFallback(t) ?? Promise.resolve(),
  } as AvatarEngine), []);
  return <canvas ref={canvasRef} width={600} height={600} />;
});
