// Parent access overlay on the kiosk: press-and-hold the avatar opens this. A 4-digit
// PIN (set in the parent console) unlocks a small menu — Update (pull + rebuild +
// restart, device only) and Reload (refresh the screen). Low-stakes by design: a kid
// who stumbles in can't reach anything that breaks content or data.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getHealth, kioskVerifyPin, kioskUpdate } from '../lib/api';

type Step = 'pin' | 'menu' | 'updating' | 'uptodate' | 'error';
const IDLE_MS = 5000;          // close the PIN prompt if untouched
const UPDATE_TIMEOUT_MS = 6 * 60 * 1000;

export function ParentMenu({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>('pin');
  const [pin, setPin] = useState('');
  const [shake, setShake] = useState(false);
  const [managed, setManaged] = useState(false);
  const [msg, setMsg] = useState('');
  const bootRef = useRef<number | null>(null);
  const pinRef = useRef('');                     // the verified PIN, reused for the update call
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { getHealth().then((h) => { setManaged(!!h.managed); bootRef.current = h.boot ?? null; }).catch(() => {}); }, []);

  // Auto-close after inactivity, but only while waiting for the PIN.
  const resetIdle = useCallback(() => {
    if (idleRef.current) clearTimeout(idleRef.current);
    if (step === 'pin') idleRef.current = setTimeout(onClose, IDLE_MS);
  }, [step, onClose]);
  useEffect(() => { resetIdle(); return () => { if (idleRef.current) clearTimeout(idleRef.current); }; }, [resetIdle, pin]);

  const verify = async (candidate: string) => {
    try {
      const r = await kioskVerifyPin(candidate);
      if (r.ok) { pinRef.current = candidate; setManaged(!!r.managed); setStep('menu'); return; }
    } catch { /* fall through to the wrong-PIN shake */ }
    setShake(true);
    setTimeout(() => { setShake(false); setPin(''); }, 450);
  };

  const press = (d: string) => {
    if (step !== 'pin') return;
    resetIdle();
    setPin((p) => {
      if (p.length >= 4) return p;
      const next = p + d;
      if (next.length === 4) verify(next);
      return next;
    });
  };
  const back = () => { resetIdle(); setPin((p) => p.slice(0, -1)); };

  const doUpdate = async () => {
    setStep('updating'); setMsg('');
    let r;
    try { r = await kioskUpdate(pinRef.current); }
    catch { setMsg("Couldn't reach the server. Try again."); setStep('error'); return; }
    if (r.status === 'up-to-date') { setMsg(`Already up to date${r.rev ? ` (${r.rev})` : ''}.`); setStep('uptodate'); return; }
    if (r.status === 'updating') { pollForRestart(); return; }
    setMsg(r.error || 'Update failed.'); setStep('error');
  };

  // The server rebuilds then self-exits; systemd restarts it with a new boot id.
  // Poll /api/health until boot changes, then reload onto the fresh build.
  const pollForRestart = () => {
    const t0 = Date.now();
    const tick = async () => {
      if (Date.now() - t0 > UPDATE_TIMEOUT_MS) { setMsg('Update is taking too long — check the device.'); setStep('error'); return; }
      try {
        const h = await getHealth();
        if (bootRef.current != null && h.boot != null && h.boot !== bootRef.current) { window.location.reload(); return; }
      } catch { /* server is mid-restart — keep polling */ }
      setTimeout(tick, 2500);
    };
    setTimeout(tick, 4000);     // give the build a head start before the first poll
  };

  return (
    <div className="pm-overlay" onPointerDown={(e) => e.stopPropagation()}>
      {step === 'pin' && (
        <div className={`pm-card${shake ? ' pm-shake' : ''}`}>
          <button className="pm-x" onClick={onClose} aria-label="Close">✕</button>
          <h2>Parent access</h2>
          <div className="pm-dots">{[0, 1, 2, 3].map((i) => <span key={i} className={i < pin.length ? 'on' : ''} />)}</div>
          <div className="pm-pad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} onClick={() => press(d)}>{d}</button>)}
            <span />
            <button onClick={() => press('0')}>0</button>
            <button className="pm-back" onClick={back} aria-label="Delete">⌫</button>
          </div>
          <p className="pm-hint">Enter the 4-digit PIN. Change it in the parent console → Settings.</p>
        </div>
      )}

      {step === 'menu' && (
        <div className="pm-card">
          <button className="pm-x" onClick={onClose} aria-label="Close">✕</button>
          <h2>Parent menu</h2>
          <div className="pm-menu">
            {managed
              ? <button className="pm-act" onClick={doUpdate}><b>⟳ Update</b><small>Get the latest version</small></button>
              : <button className="pm-act" disabled><b>⟳ Update</b><small>Available on the device only</small></button>}
            <button className="pm-act" onClick={() => window.location.reload()}><b>↻ Reload</b><small>Refresh the screen</small></button>
          </div>
        </div>
      )}

      {step === 'updating' && (
        <div className="pm-card pm-busy">
          <div className="pm-spinner" />
          <h2>Updating…</h2>
          <p>Please keep the device on. This can take a few minutes — it will restart on its own.</p>
        </div>
      )}

      {step === 'uptodate' && (
        <div className="pm-card">
          <h2>✓ Up to date</h2>
          <p>{msg}</p>
          <button className="pm-act pm-solo" onClick={onClose}>Done</button>
        </div>
      )}

      {step === 'error' && (
        <div className="pm-card">
          <button className="pm-x" onClick={onClose} aria-label="Close">✕</button>
          <h2>Hmm…</h2>
          <p>{msg}</p>
          <button className="pm-act pm-solo" onClick={onClose}>Close</button>
        </div>
      )}
    </div>
  );
}
