// Standalone preview of any artifact, opened from the parent console's Pages tab.
// Declarative/native types (flashcards, memory, reading, explorable) are React-
// rendered — they have no servable HTML file — so previewing them needs the real
// renderer, not the CSP iframe (that only serves 'page' sandbox-html artifacts,
// which is why previewing anything else used to 404 with "Missing file"). Speech
// uses the browser's built-in voice so tap-to-hear works without the avatar shell.
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { rendererFor } from '../content/registry';
import { readableOn } from '../lib/contrast';
import type { Artifact } from '../lib/types';
import '../kiosk/kiosk.css';

export default function Preview() {
  const { id = '' } = useParams();
  const [art, setArt] = useState<Artifact | null>(null);
  const [err, setErr] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const tokenRef = useRef(0);

  useEffect(() => {
    fetch(`/api/artifacts/${id}`).then((r) => (r.ok ? r.json() : Promise.reject())).then(setArt).catch(() => setErr(true));
    return () => { try { window.speechSynthesis?.cancel(); } catch {} };
  }, [id]);

  // Matches ContentRendererProps.speak; uses Web Speech so previews are audible.
  const speak = (text: string, _pid?: string, token?: string, _voice?: string, onProgress?: (f: number) => void) =>
    new Promise<void>((resolve) => {
      const tag = token || 'pv';
      const my = ++tokenRef.current;
      try {
        const synth = window.speechSynthesis;
        if (!synth) { resolve(); return; }
        synth.cancel();
        setSpeakingId(tag);
        const u = new SpeechSynthesisUtterance(String(text).slice(0, 400));
        if (onProgress) u.onboundary = (e) => { if (my === tokenRef.current) onProgress(Math.min(1, (e.charIndex || 0) / Math.max(1, u.text.length))); };
        const done = () => { if (my === tokenRef.current) setSpeakingId(null); if (onProgress) onProgress(1); resolve(); };
        u.onend = done; u.onerror = done;
        synth.speak(u);
      } catch { resolve(); }
    });

  if (err) return <div className="preview-page"><div className="preview-head">Preview</div><div className="preview-stage"><p style={{ padding: 24 }}>Couldn't load this page.</p></div></div>;
  if (!art) return <div className="preview-page"><div className="preview-head">Preview</div><div className="preview-stage"><p style={{ padding: 24 }}>Loading preview…</p></div></div>;

  const R = rendererFor(art.type);
  const color = art.color || '#0ea5e9';
  return (
    <div className="preview-page" style={{ ['--user' as any]: color, ['--user-fg' as any]: readableOn(color) }}>
      <div className="preview-head">
        <span style={{ fontSize: '1.3rem' }}>{art.emoji || '✨'}</span> <b>{art.title}</b>
        <span className="tag">{art.status === 'ready' ? `${art.type || 'page'} · preview` : `not ready (${art.status})`}</span>
      </div>
      <div className="preview-stage">
        {art.status !== 'ready'
          ? <p style={{ padding: 24 }}>This page isn't ready yet — give it a moment and refresh.</p>
          : R
            ? <R artifactId={id} profile={null} speak={speak} speakingId={speakingId} setMood={() => {}} />
            : <iframe sandbox="allow-scripts" src={`/api/artifact/${id}`} title="preview" />}
      </div>
    </div>
  );
}
