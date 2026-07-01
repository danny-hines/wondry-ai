import { useState } from 'react';
import { useAdmin } from '../AdminContext';
import type { AdminConfig } from '../../lib/types';
import { AudioKeepalive } from './AudioKeepalive';

export function SettingsKiosk({ config }: { config: AdminConfig }) {
  const api = useAdmin();
  const [kioskPin, setKioskPin] = useState(config.kioskPin || '0000');
  const [pinMsg, setPinMsg] = useState('');
  const [wake, setWake] = useState<{ enabled: boolean; phrase: string }>({
    enabled: config.wake.enabled,
    phrase: config.wake.phrase,
  });
  const [wakeMsg, setWakeMsg] = useState('');
  return (
    <>
      <div className="card">
        <h3 style={{ marginBottom: 6 }}>Kiosk access PIN</h3>
        <p className="muted" style={{ marginBottom: 10 }}>
          On the kiosk, press and hold the avatar for 5 seconds to open a parent menu (Update &amp;
          Reload). This 4-digit PIN unlocks it. Low-stakes — it just keeps kids out of the
          maintenance menu. Default is <code>0000</code>.
        </p>
        <div>
          <label>4-digit PIN</label>
          <input
            value={kioskPin}
            inputMode="numeric"
            maxLength={4}
            placeholder="0000"
            onChange={(e) => {
              setKioskPin(e.target.value.replace(/\D/g, '').slice(0, 4));
              setPinMsg('');
            }}
            style={{ display: 'block', width: 120, letterSpacing: '0.3em', fontSize: '1.1rem' }}
          />
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="act"
            disabled={!/^\d{4}$/.test(kioskPin)}
            onClick={async () => {
              await api.saveConfig({ kioskPin });
              setPinMsg('Saved ✓');
            }}
          >
            Save
          </button>
          <span className="muted">
            {/^\d{4}$/.test(kioskPin) ? pinMsg : 'Enter exactly 4 digits'}
          </span>
        </div>
      </div>
      <div className="card">
        <h3 style={{ marginBottom: 6 }}>Wake word (hands-free)</h3>
        <p className="muted" style={{ marginBottom: 10 }}>
          Let kids start talking by saying a wake word — no tap needed. Runs{' '}
          <b>100% on the device</b>; audio never leaves the Pi. Requires the wake-word add-on
          installed on the Pi (re-run the installer and say yes). When off, kids tap the avatar to
          talk.
        </p>
        <div className="row" style={{ alignItems: 'flex-end', gap: 12 }}>
          <div>
            <label>Wake word</label>
            <select
              value={wake.phrase}
              onChange={(e) => setWake((w) => ({ ...w, phrase: e.target.value }))}
            >
              {config.wake.phrases.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <button
            className={`chip ${wake.enabled ? 'on' : ''}`}
            onClick={() => setWake((w) => ({ ...w, enabled: !w.enabled }))}
          >
            {wake.enabled ? 'On' : 'Off'}
          </button>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="act"
            onClick={async () => {
              await api.saveConfig({ wake });
              setWakeMsg('Saved ✓');
            }}
          >
            Save
          </button>
          <span className="muted">{wakeMsg}</span>
        </div>
      </div>
      <AudioKeepalive />
    </>
  );
}
