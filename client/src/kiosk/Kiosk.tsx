import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar } from './Avatar';
import { ParentMenu } from './ParentMenu';
import type { AvatarEngine } from './avatarEngine';
import { useSpeech } from './useSpeech';
import { getStt, type SttSession } from './sttService';
import { startThinkingSound, stopThinkingSound } from './thinkingSound';
import { rendererFor } from '../content/registry';
import { getProfiles, getTray, postTurn, markEngagement } from '../lib/api';
import { mdToHtml } from '../lib/markdown';
import { readableOn } from '../lib/contrast';
import type { Profile, Artifact, WSMessage } from '../lib/types';
import './kiosk.css';

const IDLE_MS = 2 * 60 * 1000;

type Item =
  | { key: string; kind: 'bubble'; role: 'kid' | 'avatar'; text: string }
  | { key: string; kind: 'card'; artifact: Artifact };

type View = 'idle' | 'conversation' | 'split';

export default function Kiosk() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [userIdx, setUserIdx] = useState(0);
  const [view, setView] = useState<View>('idle');
  const [splitMode, setSplitMode] = useState<'artifact' | 'tray' | null>(null);
  const [full, setFull] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openArt, setOpenArt] = useState<Artifact | null>(null);
  const [tray, setTray] = useState({ count: 0, unseen: 0 });
  const [trayList, setTrayList] = useState<Artifact[]>([]);
  const [toast, setToast] = useState<{ text: string; onClick: () => void } | null>(null);
  const [prompt, setPrompt] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);

  const avatarRef = useRef<AvatarEngine | null>(null);
  const { speak, speakingId } = useSpeech(avatarRef);
  const bubblesRef = useRef<HTMLDivElement>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const user = profiles[userIdx] || null;
  const userRef = useRef<Profile | null>(null); userRef.current = user;
  const openRef = useRef<string | null>(null); openRef.current = openId;
  const viewRef = useRef<View>(view); viewRef.current = view;
  const itemsRef = useRef<Item[]>(items); itemsRef.current = items;

  const refreshTray = useCallback(async () => {
    const u = userRef.current; if (!u) return;
    try { const t = await getTray(u.id); setTray({ count: t.artifacts.length, unseen: t.unseen }); } catch {}
  }, []);

  const bumpIdle = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => { if (viewRef.current !== 'split') goIdle(); }, IDLE_MS);
  }, []);
  const goIdle = () => { setView('idle'); setSplitMode(null); setOpenId(null); setFull(false); setHintSeen(false); avatarRef.current?.setMood('idle'); };

  useEffect(() => {
    getProfiles().then((ps) => setProfiles(ps));
  }, []);
  useEffect(() => { if (user) avatarRef.current?.setColor(user.color); }, [user]);
  useEffect(() => { if (user) refreshTray(); }, [user, refreshTray]);

  useEffect(() => {
    let ws: WebSocket;
    let closed = false;
    const connect = () => {
      ws = new WebSocket(`ws://${location.host}/ws`);
      ws.onmessage = (m) => {
        let evt: WSMessage; try { evt = JSON.parse(m.data); } catch { return; }
        const a = evt.artifact; const u = userRef.current;
        if (a && u && !(a.profile_id === u.id || a.profile_id == null)) { if (evt.type !== 'hello') refreshTray(); return; }
        if (evt.type === 'artifact.completed' && a) { completeCard(a); announce(a); refreshTray(); }
        else if (evt.type === 'artifact.failed' && a) { failCard(a); }
        else if (evt.type === 'presence' && evt.state === 'present') { maybeGreet(); }
        // Wake word heard (on-device sidecar → /api/wake): start listening, same as
        // a face tap. recRef.start() is a no-op if already listening.
        else if (evt.type === 'wake') { if (viewRef.current === 'idle') setView('conversation'); setHintSeen(true); recRef.current?.start(); bumpIdle(); }
      };
      ws.onclose = () => { if (!closed) setTimeout(connect, 2000); };
    };
    connect();
    return () => { closed = true; try { ws.close(); } catch {} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const completeCard = (a: Artifact) => setItems((prev) => prev.map((it) =>
    it.kind === 'card' && it.artifact.id === a.id ? { ...it, artifact: { ...it.artifact, ...a, status: 'ready' } } : it));
  const failCard = (a: Artifact) => setItems((prev) => prev.map((it) =>
    it.kind === 'card' && it.artifact.id === a.id ? { ...it, artifact: { ...it.artifact, status: 'failed' } } : it));

  const announce = (a: Artifact) => {
    if (openRef.current === a.id) return;            // already viewing it — don't interrupt
    const u = userRef.current;
    // The avatar always speaks (and lip-syncs) the completion. Only show a toast when the
    // page isn't already visible as a card in the conversation, where it turns "ready" itself.
    const inConvo = itemsRef.current.some((it) => it.kind === 'card' && it.artifact.id === a.id);
    const line = a.source === 'parent' ? `${u?.name}, ${a.title} is ready for you!` : `I finished your page about ${a.subject || a.title}!`;
    speak(line, u?.id);
    if (!inConvo) {
      setToast({ text: `✨ ${a.title} is ready — tap to open`, onClick: () => { if (u) markEngagement(a.id, 'seen', u.id).then(refreshTray); openArtifact(a); } });
      setTimeout(() => setToast(null), 9000);
    }
  };

  // Greet on approach: a presence event (Pi person-detector → /api/presence) makes
  // the idle avatar say hello, throttled so it doesn't repeat for someone lingering.
  const lastGreetRef = useRef(0);
  const maybeGreet = useCallback(() => {
    const t = Date.now();
    if (t - lastGreetRef.current < 90000) return;
    if (viewRef.current !== 'idle') return;
    const u = userRef.current; if (!u) return;
    lastGreetRef.current = t;
    // Greeting is the avatar SPEAKING — stay idle so it lip-syncs (listening now
    // shows the equalizer, which would be wrong here).
    speak(`Hi${u.name ? ' ' + u.name : ''}! I'm right here whenever you want to explore something fun.`, u.id);
  }, [speak]);

  useEffect(() => { bubblesRef.current?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [items]);

  const sendTurn = async (text: string) => {
    text = text.trim(); if (!text || !user) return;
    setHintSeen(true);  // child has talked — drop the first-run "tap to talk" hint
    if (viewRef.current === 'idle') setView('conversation');
    setItems((p) => [...p, { key: 'k' + Date.now(), kind: 'bubble', role: 'kid', text }]);
    setPrompt('');
    avatarRef.current?.setMood('thinking');
    startThinkingSound();   // quiet beeps/boops instead of a spoken filler
    bumpIdle();
    try {
      const res = await postTurn(user.id, text);
      stopThinkingSound();
      const replyKey = 'a' + Date.now();
      setItems((p) => [...p, { key: replyKey, kind: 'bubble', role: 'avatar', text: res.reply }]);
      avatarRef.current?.setMood('idle');
      if (res.kind === 'artifact' && res.artifact) { const art = res.artifact; setItems((p) => [...p, { key: art.id, kind: 'card', artifact: art }]); }
      speak(res.reply, user.id, replyKey);
    } catch {
      stopThinkingSound();
      setItems((p) => [...p, { key: 'e' + Date.now(), kind: 'bubble', role: 'avatar', text: 'Oops, something went wrong. Try again?' }]);
      avatarRef.current?.setMood('idle');
    }
  };

  const openArtifact = (a: Artifact) => {
    setView('split'); setSplitMode('artifact'); setOpenId(a.id); setOpenArt(a);
    const u = userRef.current; if (u) markEngagement(a.id, 'opened', u.id).then(refreshTray);
    bumpIdle();
  };
  const openTray = async () => {
    const u = userRef.current; if (!u) return;
    const t = await getTray(u.id);
    setTrayList(t.artifacts.filter((a) => a.status === 'ready'));
    setView('split'); setSplitMode('tray'); setOpenId(null); bumpIdle();
  };
  const switchUser = () => { setUserIdx((i) => (i + 1) % Math.max(1, profiles.length)); setItems([]); goIdle(); };
  const closeRight = () => { setView(items.length ? 'conversation' : 'idle'); setSplitMode(null); setOpenId(null); setFull(false); };

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data || {};
      if (d.type === 'speak' && d.text) speak(String(d.text).slice(0, 300), userRef.current?.id);
      if (d.type === 'finished' && openRef.current && userRef.current) markEngagement(openRef.current, 'finished', userRef.current.id);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [speak]);

  const recRef = useRef<any>(null);
  const [micLive, setMicLive] = useState(false);
  // The "tap to talk" hint is first-run guidance: show it until the child has
  // talked this session, then hide it (the equalizer signals listening). It comes
  // back after the kiosk resets to idle (goIdle), i.e. a fresh session.
  const [hintSeen, setHintSeen] = useState(false);

  // Hide the mouse pointer only on the real kiosk (production build), so local
  // development keeps a usable cursor. Override per-load with ?cursor=off (force
  // hide, e.g. testing a prod build) or ?cursor=on (force show).
  const hideCursor = (() => {
    const f = new URLSearchParams(location.search).get('cursor');
    if (f === 'on') return false;
    if (f === 'off') return true;
    return import.meta.env.PROD;
  })();

  // Voice-only on the real kiosk (production build): hide the keyboard input bar
  // and drive input by tapping the avatar's face. Dev keeps the text box for quick
  // testing. Override per-load with ?kiosk=1 (force voice-only) / ?kiosk=0 (keyboard).
  const voiceOnly = (() => {
    const f = new URLSearchParams(location.search).get('kiosk');
    if (f === '1') return true;
    if (f === '0') return false;
    return import.meta.env.PROD;
  })();
  // Press-and-hold the avatar for 5s to open the parent menu (PIN-gated). The hold
  // timer is cancelled on release/leave; if it fires, heldRef suppresses the tap so
  // a long press doesn't also start a listen session.
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldRef = useRef(false);
  const startHold = () => {
    heldRef.current = false;
    holdTimer.current = setTimeout(() => { heldRef.current = true; setMenuOpen(true); }, 5000);
  };
  const cancelHold = () => { if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; } };

  // Tap-to-talk: toggle a listen session (used by the avatar tap in voice-only mode).
  const toggleListen = () => {
    if (viewRef.current === 'idle') setView('conversation');
    const r = recRef.current; if (!r) return;
    micLive ? r.stop() : r.start();
  };

  // Touchscreen kiosk: hide the mouse pointer across the whole viewport. The cage
  // compositor parks a cursor at center on boot; a CSS rule on .kiosk-root misses
  // the inset margin around it, so set it on <html> while the kiosk is mounted
  // (restored on unmount, so the parent console keeps its cursor).
  useEffect(() => {
    if (!hideCursor) return;
    const html = document.documentElement;
    const prev = html.style.cursor;
    html.style.cursor = 'none';
    return () => { html.style.cursor = prev; };
  }, [hideCursor]);
  useEffect(() => {
    // Use the shared STT engine (Web Speech in dev; whisper via /api/stt on the Pi,
    // whose kiosk Chromium has no working Web Speech). A raw SpeechRecognition here
    // would "start" then error out instantly in Chromium, so the mic never worked.
    const engine = getStt();
    if (!engine.available) return;
    let session: SttSession | null = null;
    // Feed the child's mic amplitude to the avatar so the listening equalizer reacts
    // to their voice (Web Speech exposes no levels). Separate from STT; if the mic is
    // unavailable the equalizer falls back to its synthetic floor.
    let ampStream: MediaStream | null = null, ampCtx: AudioContext | null = null, ampRAF = 0;
    const startAmp = async () => {
      try { ampStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch { return; }
      ampCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const src = ampCtx.createMediaStreamSource(ampStream);
      const an = ampCtx.createAnalyser(); an.fftSize = 512; src.connect(an);
      const data = new Uint8Array(an.fftSize);
      const tick = () => {
        an.getByteTimeDomainData(data);
        let sum = 0; for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
        avatarRef.current?.setLevel(Math.min(1, Math.sqrt(sum / data.length) * 6));
        ampRAF = requestAnimationFrame(tick);
      };
      tick();
    };
    const stopAmp = () => {
      cancelAnimationFrame(ampRAF);
      if (ampStream) ampStream.getTracks().forEach((t) => t.stop());
      if (ampCtx) ampCtx.close().catch(() => {});
      ampStream = null; ampCtx = null;
    };
    recRef.current = {
      start() {
        if (session) return;
        setMicLive(true);
        avatarRef.current?.setMood('listening');
        startAmp();
        session = engine.listen();
        session.result.then(({ transcript }) => {
          session = null;
          stopAmp();
          setMicLive(false);
          if (viewRef.current !== 'split') avatarRef.current?.setMood('idle');
          if (transcript) sendTurn(transcript);
        });
      },
      stop() { session?.stop(); },
    };
    return () => { stopAmp(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const openCard = openId ? items.find((it) => it.kind === 'card' && it.artifact.id === openId) : null;
  const openGenerating = !!(openCard && openCard.kind === 'card' && openCard.artifact.status === 'generating');

  return (
    <div className={`kiosk-root state-${view}${full ? ' full' : ''}${user?.theme === 'dark' ? ' theme-dark' : ''}${hideCursor ? ' hide-cursor' : ''}`} style={{ ['--user' as any]: user?.color || '#16b8a6', ['--user-fg' as any]: readableOn(user?.color || '#16b8a6') }} onPointerDown={bumpIdle}>
      <div id="left">
        <div id="avatarWrap" className={voiceOnly && micLive ? 'listening' : ''}
          onPointerDown={startHold} onPointerUp={cancelHold} onPointerLeave={cancelHold} onPointerCancel={cancelHold}
          onClick={() => {
            if (heldRef.current) { heldRef.current = false; return; }  // long-press already opened the menu
            if (voiceOnly) { toggleListen(); return; }
            if (view === 'idle') setView('conversation');
          }}>
          <Avatar ref={avatarRef} />
          {voiceOnly && !hintSeen && <div className="taptotalk">{micLive ? 'Listening… tap to stop' : 'Tap to talk'}</div>}
        </div>
        <div id="convo">
          <div id="bubbles" ref={bubblesRef}>
            {items.map((it) => it.kind === 'bubble'
              ? (it.role === 'avatar'
                  ? <div key={it.key} className={`bubble avatar${it.key === speakingId ? ' speaking' : ''}`} dangerouslySetInnerHTML={{ __html: mdToHtml(it.text) }} />
                  : <div key={it.key} className="bubble kid">{it.text}</div>)
              : <ArtifactCard key={it.key} artifact={it.artifact} onOpen={() => openArtifact(it.artifact)} onRetry={() => sendTurn('make a page about ' + (it.artifact.subject || it.artifact.title))} />)}
          </div>
          {!voiceOnly && (
            <div id="inputbar">
              <input id="prompt" value={prompt} placeholder="Ask me anything…  (type or tap 🎤)"
                onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendTurn(prompt); }} />
              <button id="mic" className={micLive ? 'live' : ''} title="Speak"
                onClick={() => { const r = recRef.current; if (!r) return; micLive ? r.stop() : r.start(); }}>🎤</button>
              <button id="send" onClick={() => sendTurn(prompt)}>Send</button>
            </div>
          )}
        </div>
      </div>

      <div id="right">
        <div id="rightbar">
          <button id="full" title="Toggle full screen" onClick={() => setFull((f) => !f)}>⤢</button>
          <button id="close" title="Close" onClick={closeRight}>✕</button>
        </div>
        <div id="content">
          {splitMode === 'tray'
            ? <div className="tray">
                {trayList.length ? trayList.map((a) => (
                  <button key={a.id} className="tile" style={{ background: a.color || '#8b5cf6', color: readableOn(a.color || '#8b5cf6') }}
                    onClick={() => { if (user) markEngagement(a.id, 'seen', user.id).then(refreshTray); openArtifact(a); }}>
                    {!a.seen && <span className="new">NEW</span>}
                    <span className="te">{a.emoji || '✨'}</span>
                    <span className="tt">{a.title}</span>
                    <span className="src">{a.source === 'parent' ? '★ for you' : a.source === 'proactive' ? '✦ discovered' : 'you asked'}</span>
                  </button>
                )) : <div className="empty">No pages yet. Ask me to build one!</div>}
              </div>
            : openGenerating
              ? <div className="tray"><div className="empty">✨ {rendererFor(openArt?.type) ? 'Getting it ready…' : 'Making your page…'} hang tight!</div></div>
              : openId
                ? (() => {
                    const R = rendererFor(openArt?.type);
                    return R
                      ? <R artifactId={openId} profile={user} speak={speak} speakingId={speakingId} setMood={(m) => avatarRef.current?.setMood(m)} />
                      : <iframe sandbox="allow-scripts" src={`/api/artifact/${openId}`} title="page" />;
                  })()
                : null}
        </div>
      </div>

      <div id="corner">
        <span id="initials" title="Tap to switch user" onClick={switchUser}>{user?.initials || '··'}</span>
        <button id="trayBtn" className={tray.count === 0 ? 'empty' : ''} title="My pages" onClick={openTray}>
          <span className="dot" />
          {tray.unseen > 0 && <span id="trayBadge">{tray.unseen}</span>}
        </button>
      </div>

      {toast && <div id="toast" onClick={() => { const t = toast; setToast(null); t.onClick(); }}>{toast.text}</div>}

      {menuOpen && <ParentMenu onClose={() => setMenuOpen(false)} />}
    </div>
  );
}

function ArtifactCard({ artifact, onOpen, onRetry }: { artifact: Artifact; onOpen: () => void; onRetry: () => void }) {
  const cls = artifact.status === 'ready' ? 'ready' : artifact.status === 'failed' ? 'failed' : '';
  const ready = artifact.status === 'ready';
  const failed = artifact.status === 'failed';
  return (
    <div className={`artcard ${cls}`} style={{ ['--est' as any]: '12s' }} onClick={() => (failed ? onRetry() : onOpen())}>
      <div className="fill" />
      <div className="inner">
        <div className="emoji">{artifact.emoji || '✨'}</div>
        <div className="meta">
          <div className="t">{artifact.title}</div>
          <div className="p">{failed ? "That one didn't work." : ready ? (artifact.plan || 'Ready to explore!') : 'Making your page…'}</div>
        </div>
        <div className="go">{failed ? 'Try again ↻' : ready ? 'OPEN →' : '●●●'}</div>
      </div>
    </div>
  );
}
