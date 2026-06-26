import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Avatar } from './Avatar';
import { ParentMenu } from './ParentMenu';
import type { AvatarEngine } from './avatarEngine';
import { useSpeech } from './useSpeech';
import { getStt, type SttSession } from './sttService';
import { startThinkingSound, stopThinkingSound } from './thinkingSound';
import { playStartListening, playStopListening } from './listenSound';
import { playAlarm } from './alarmSound';
import { primeAudio, applyWarm, playTestTone } from './audio';
import { rendererFor } from '../content/registry';
import { getProfiles, getTray, postTurn, markEngagement, getTimers, cancelSchedule, getAudioConfig } from '../lib/api';
import { mdToHtml } from '../lib/markdown';
import { maskProfanity } from '../lib/profanity';
import { readableOn } from '../lib/contrast';
import type { Profile, Artifact, WSMessage, ScheduleItem } from '../lib/types';
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
  // Reveal state for the reply being spoken: `pending` shows a "…" while TTS synthesizes,
  // then `shown` words are revealed in time with the audio. Cleared (→ full text) when
  // speech ends or is interrupted.
  const [reveal, setReveal] = useState<{ key: string; pending: boolean; shown: number } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openArt, setOpenArt] = useState<Artifact | null>(null);
  const [tray, setTray] = useState({ count: 0, unseen: 0 });
  const [trayList, setTrayList] = useState<Artifact[]>([]);
  const [toast, setToast] = useState<{ text: string; onClick: () => void } | null>(null);
  const [prompt, setPrompt] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [timers, setTimers] = useState<ScheduleItem[]>([]);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const avatarRef = useRef<AvatarEngine | null>(null);
  const { speak, speakingId, stop: stopSpeech } = useSpeech(avatarRef);
  // Bumped whenever a new turn starts or speech is interrupted; a turn whose seq is no
  // longer current drops its (stale) reply instead of speaking over a newer interaction.
  const turnSeq = useRef(0);
  const bubblesRef = useRef<HTMLDivElement>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cornerRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const wasSplit = useRef(false);

  const user = profiles[userIdx] || null;
  const userRef = useRef<Profile | null>(null); userRef.current = user;
  const openRef = useRef<string | null>(null); openRef.current = openId;
  const viewRef = useRef<View>(view); viewRef.current = view;
  const itemsRef = useRef<Item[]>(items); itemsRef.current = items;

  const refreshTray = useCallback(async () => {
    const u = userRef.current; if (!u) return;
    try { const t = await getTray(u.id); setTray({ count: t.artifacts.length, unseen: t.unseen }); } catch {}
  }, []);

  const refreshTimers = useCallback(async () => {
    try { const r = await getTimers(); setTimers(r.timers); } catch {}
  }, []);

  const bumpIdle = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => { if (viewRef.current !== 'split') goIdle(); }, IDLE_MS);
  }, []);
  const goIdle = () => { setView('idle'); setSplitMode(null); setOpenId(null); setFull(false); setHintSeen(false); avatarRef.current?.setMood('idle'); };

  useEffect(() => {
    getProfiles().then((ps) => setProfiles(ps));
    getAudioConfig().then((a) => applyWarm(a.warmHz, a.warmGain));   // warm the output device (anti-clip on some hardware)
  }, []);
  useEffect(() => { if (user) avatarRef.current?.setColor(user.color); }, [user]);
  useEffect(() => { if (user) refreshTray(); }, [user, refreshTray]);
  useEffect(() => { refreshTimers(); }, [refreshTimers]);   // timers are device-global, not per user
  // Tick once a second only while timers exist, so the countdown chips update live.
  useEffect(() => {
    if (!timers.length) return;
    const i = setInterval(() => setNowTick(Date.now()), 500);
    return () => clearInterval(i);
  }, [timers.length]);

  // Tap a chip to cancel; optimistic-remove, then tell the server (which broadcasts
  // a timer.cancelled the other views pick up — harmless if it races our removal).
  const dismissTimer = (id: string) => { setTimers((p) => p.filter((t) => t.id !== id)); cancelSchedule(id); };

  useEffect(() => {
    let ws: WebSocket;
    let closed = false;
    const connect = () => {
      ws = new WebSocket(`ws://${location.host}/ws`);
      ws.onmessage = (m) => {
        let evt: WSMessage; try { evt = JSON.parse(m.data); } catch { return; }
        const a = evt.artifact; const u = userRef.current;
        // Live audio-keepalive tuning from `wondry audio` (retune, or play a test sound).
        if (evt.type === 'audio') { applyWarm((evt as any).warmHz, (evt as any).warmGain); return; }
        if (evt.type === 'audio.test') { primeAudio(); playTestTone(); return; }
        // Schedules are device-global — show/fire them whoever's currently active. The
        // chips show countdown timers only; reminders just fire (announce) when due.
        if (evt.type.startsWith('schedule.') && evt.schedule) {
          const s = evt.schedule;
          if (evt.type === 'schedule.created') { if (s.kind === 'timer') setTimers((p) => p.some((t) => t.id === s.id) ? p : [...p, s].sort((x, y) => x.fire_at - y.fire_at)); }
          else if (evt.type === 'schedule.cancelled') setTimers((p) => p.filter((t) => t.id !== s.id));
          else if (evt.type === 'schedule.fired') { setTimers((p) => p.filter((t) => t.id !== s.id)); fireSchedule(s); }
          return;
        }
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

  // A timer or reminder went off: sound the alarm, wake the avatar (even from idle),
  // and have it announce. Reuses the speak/idle machinery the wake word and greeting
  // already use. Timers report the duration; reminders speak their message.
  const fireSchedule = (s: ScheduleItem) => {
    const u = userRef.current;
    playAlarm();
    if (viewRef.current === 'idle') { setView('conversation'); setHintSeen(true); }
    bumpIdle();
    let line: string, toast: string;
    if (s.kind === 'reminder') {
      line = s.message ? `Ding ding! Time to ${s.message}!` : "Ding ding! Here's your reminder!";
      toast = `🔔 ${s.message || 'Reminder'}`;
    } else {
      line = s.label ? `Ding ding! Time to ${s.label}!` : `Ding ding ding! Your ${s.pretty} timer is done!`;
      toast = `⏰ ${s.label || `${s.pretty} timer`} — done!`;
    }
    speak(line, u?.id);
    setToast({ text: toast, onClick: () => {} });
    setTimeout(() => setToast(null), 8000);
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

  // Keep the latest message pinned to the bottom. Smooth when a new bubble/card
  // arrives; instant while a reply streams in word-by-word (`reveal`) so the growing
  // text never slips below the fold and smooth animations don't stack and lag behind.
  useEffect(() => { bubblesRef.current?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [items]);
  useEffect(() => { const el = bubblesRef.current; if (el) el.scrollTop = el.scrollHeight; }, [reveal]);

  // Opening the pages panel: slide the whole panel — and its docked header controls
  // (initials + My pages) — in from off the bottom-right, so it reads as one window
  // expanding from the corner where the controls live. Same pixel offset on both so
  // they travel as a single unit. (0.8 = how far off-screen it starts; tunable.)
  useLayoutEffect(() => {
    const isSplit = view === 'split';
    if (isSplit && !wasSplit.current) {
      const panel = rightRef.current;
      const r = panel?.getBoundingClientRect();
      if (panel && r) {
        const from = `translate(${r.width * 0.8}px, ${r.height * 0.8}px)`;
        const opts = { duration: 540, easing: 'cubic-bezier(.16,1,.3,1)' };
        panel.animate([{ transform: from, opacity: 0.35 }, { transform: 'none', opacity: 1 }], opts);
        cornerRef.current?.animate([{ transform: from }, { transform: 'none' }], opts);
      }
    }
    wasSplit.current = isSplit;
  }, [view]);

  // thinkDelayMs holds the thinking beeps off for a beat — used by the voice path so
  // there's a clear silent gap between the stop-listening cue and the thinking sound.
  const sendTurn = async (text: string, thinkDelayMs = 0) => {
    text = text.trim(); if (!text || !user) return;
    const seq = ++turnSeq.current;
    setHintSeen(true);  // child has talked — drop the first-run "tap to talk" hint
    if (viewRef.current === 'idle') setView('conversation');
    setItems((p) => [...p, { key: 'k' + Date.now(), kind: 'bubble', role: 'kid', text }]);
    setPrompt('');
    avatarRef.current?.setMood('thinking');
    startThinkingSound(thinkDelayMs);   // quiet beeps/boops instead of a spoken filler
    bumpIdle();
    try {
      const res = await postTurn(user.id, text);
      if (seq !== turnSeq.current) return;   // interrupted/superseded — drop this stale reply
      const replyKey = 'a' + Date.now();
      // Show the bubble immediately as a pending "…" but STAY in the thinking state
      // (ring + beeps) until Piper actually has audio — no awkward idle-and-silent gap.
      setItems((p) => [...p, { key: replyKey, kind: 'bubble', role: 'avatar', text: res.reply }]);
      setReveal({ key: replyKey, pending: true, shown: 0 });
      if (res.kind === 'artifact' && res.artifact) { const art = res.artifact; setItems((p) => [...p, { key: art.id, kind: 'card', artifact: art }]); }
      const words = (res.reply || '').split(/\s+/).filter(Boolean).length;
      const onStart = () => {   // first audio is ready: hand off thinking → speaking
        if (seq !== turnSeq.current) return;
        stopThinkingSound();
        avatarRef.current?.setMood('idle');
        setReveal((r) => (r && r.key === replyKey ? { ...r, pending: false } : r));
      };
      const onProgress = (f: number) => {   // reveal words in time with the audio
        const show = Math.min(words, Math.max(1, Math.ceil(f * words)));
        setReveal((r) => (r && r.key === replyKey && show > r.shown ? { ...r, shown: show } : r));
      };
      await speak(res.reply, user.id, replyKey, undefined, onProgress, onStart);
      if (seq === turnSeq.current) { stopThinkingSound(); avatarRef.current?.setMood('idle'); setReveal((r) => (r && r.key === replyKey ? null : r)); }
    } catch {
      if (seq !== turnSeq.current) return;
      stopThinkingSound();
      setReveal(null);
      setItems((p) => [...p, { key: 'e' + Date.now(), kind: 'bubble', role: 'avatar', text: 'Oops, something went wrong. Try again?' }]);
      avatarRef.current?.setMood('idle');
    }
  };

  // Tap an avatar bubble to hear it again (re-animates the bubble + lip-sync).
  const replayBubble = (key: string, text: string) => { const u = userRef.current; if (u) speak(text, u.id, key); };

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
  const tapValid = useRef(false);
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
  // The avatar's primary tap. Driven by pointerup (not onClick) so it's reliable on
  // the touchscreen — a synthesized click is easily swallowed (e.g. by double-tap
  // detection), which is why tap-to-stop sometimes didn't register.
  const onAvatarTap = () => {
    if (voiceOnly) { toggleListen(); return; }
    if (view === 'idle') setView('conversation');
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
        // The child is taking the floor — stop the avatar so it doesn't talk over them,
        // and invalidate any in-flight turn so its reply won't blurt out mid-listen.
        turnSeq.current++;
        stopSpeech();
        stopThinkingSound();
        setReveal(null);   // an interrupted reply snaps to its full text
        setMicLive(true);
        avatarRef.current?.setMood('listening');
        playStartListening();   // low→high cue: "I'm listening"
        startAmp();
        // Capture ended (tap-to-stop, silence, or timeout): drop the listening UI and
        // show we're processing immediately, even if transcription is still in flight.
        let ended = false;
        const endCapture = () => {
          if (ended) return; ended = true;
          playStopListening();   // high→low cue: "got it"
          stopAmp();
          setMicLive(false);
          avatarRef.current?.setMood('thinking');
        };
        session = engine.listen(undefined, endCapture);
        session.result.then(({ transcript }) => {
          session = null;
          endCapture();   // safety net if the engine didn't signal capture-end
          if (transcript) sendTurn(transcript, 280);   // pause after the stop-listening cue
          else if (viewRef.current !== 'split') avatarRef.current?.setMood('idle');
        });
      },
      stop() { session?.stop(); },
    };
    return () => { stopAmp(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const openCard = openId ? items.find((it) => it.kind === 'card' && it.artifact.id === openId) : null;
  const openGenerating = !!(openCard && openCard.kind === 'card' && openCard.artifact.status === 'generating');
  // In the open panel the My-pages button becomes the panel's close (✕); when closed
  // it opens the tray.
  const panelOpen = view === 'split';

  return (
    <div className={`kiosk-root state-${view}${full ? ' full' : ''}${user?.theme === 'dark' ? ' theme-dark' : ''}${hideCursor ? ' hide-cursor' : ''}`} style={{ ['--user' as any]: user?.color || '#16b8a6', ['--user-fg' as any]: readableOn(user?.color || '#16b8a6') }} onPointerDown={() => { primeAudio(); bumpIdle(); }}>
      <div id="left">
        <div id="avatarWrap" className={voiceOnly && micLive ? 'listening' : ''}
          onPointerDown={() => { tapValid.current = true; startHold(); }}
          onPointerUp={() => {
            cancelHold();
            if (heldRef.current) { heldRef.current = false; return; }  // long-press already opened the menu
            if (tapValid.current) onAvatarTap();
          }}
          onPointerLeave={() => { tapValid.current = false; cancelHold(); }}
          onPointerCancel={() => { tapValid.current = false; cancelHold(); }}>
          <Avatar ref={avatarRef} />
          {voiceOnly && !hintSeen && <div className="taptotalk">{micLive ? 'Listening… tap to stop' : 'Tap to talk'}</div>}
        </div>
        <div id="convo">
          <div id="bubbles" ref={bubblesRef}>
            {items.map((it) => it.kind === 'bubble'
              ? (it.role === 'avatar'
                  ? (() => {
                      const rv = reveal && reveal.key === it.key ? reveal : null;
                      const safe = maskProfanity(it.text);   // final render gate
                      const html = rv?.pending ? '<span class="speak-dots">…</span>'
                        : rv ? mdToHtml(safe.split(/\s+/).slice(0, rv.shown).join(' '))
                          : mdToHtml(safe);
                      return <div key={it.key} className={`bubble avatar${it.key === speakingId ? ' speaking' : ''}`} title="Tap to hear again"
                        onClick={() => replayBubble(it.key, it.text)} dangerouslySetInnerHTML={{ __html: html }} />;
                    })()
                  : <div key={it.key} className="bubble kid">{maskProfanity(it.text)}</div>)
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

      <div id="right" ref={rightRef}>
        <div id="rightbar">
          <button id="full" title="Toggle full screen" onClick={() => setFull((f) => !f)}>⤢</button>
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
                      : <iframe sandbox="allow-scripts" src={`/api/artifact/${openId}?chrome=panel`} title="page" />;
                  })()
                : null}
        </div>
      </div>

      {timers.length > 0 && (
        <div id="timers">
          {timers.map((t) => {
            const remain = Math.max(0, t.fire_at - nowTick);
            const s = Math.ceil(remain / 1000);
            const mmss = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
            return (
              <button key={t.id} className={`timerChip${remain === 0 ? ' done' : ''}`} title="Tap to cancel" onClick={() => dismissTimer(t.id)}>
                <span className="tcIcon" aria-hidden="true">⏰</span>
                <span className="tcTime">{mmss}</span>
                {t.label && <span className="tcLabel">{t.label}</span>}
                <span className="tcX" aria-hidden="true">✕</span>
              </button>
            );
          })}
        </div>
      )}

      <div id="corner" ref={cornerRef}>
        <span id="initials" title="Tap to switch user" onClick={switchUser}>{user?.initials || '··'}</span>
        <button id="trayBtn" className={tray.count === 0 ? 'empty' : ''} title={panelOpen ? 'Close' : 'My pages'} onClick={panelOpen ? closeRight : openTray}>
          {panelOpen
            ? <span className="trayX" aria-hidden="true">✕</span>
            : <svg className="trayIcon" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="2" />
                <rect x="13" y="3.5" width="7.5" height="7.5" rx="2" />
                <rect x="3.5" y="13" width="7.5" height="7.5" rx="2" />
                <rect x="13" y="13" width="7.5" height="7.5" rx="2" />
              </svg>}
          {!panelOpen && tray.unseen > 0 && <span id="trayBadge">{tray.unseen}</span>}
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
