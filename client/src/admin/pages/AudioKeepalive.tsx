import { useEffect, useState } from 'react';
import { getAudioConfig, setAudioConfig, testAudio } from '../../lib/api';

// Audio keepalive tuner (Settings → Kiosk & device). The Pi's speaker clips the start
// of sounds after silence; a continuous inaudible tone keeps the output device awake.
// Apply broadcasts to the kiosk live; "Play test sound" fires a sharp tone there so a
// parent standing by the device can listen for clipping. Mirrors the `wondry audio` CLI.
export function AudioKeepalive() {
  const [hz, setHz] = useState('');
  const [gain, setGain] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    getAudioConfig().then((a) => {
      setHz(String(a.warmHz));
      setGain(String(a.warmGain));
      setLoaded(true);
    });
  }, []);
  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(''), 2500);
  };
  const apply = async () => {
    const h = Number(hz),
      g = Number(gain);
    if (!Number.isFinite(h) || !Number.isFinite(g)) return;
    const r = await setAudioConfig(h, g);
    setHz(String(r.warmHz));
    setGain(String(r.warmGain));
    flash('Applied ✓');
  };
  return (
    <div className="card">
      <h3 style={{ marginBottom: 6 }}>Audio keepalive (anti-clipping)</h3>
      <p className="muted" style={{ marginBottom: 10 }}>
        On some hardware configurations, the speaker powers down during silence and clips the first
        ~200ms of each sound (it varies with the USB-audio adapter, audio HAT, or DAC you use). A
        continuous, inaudible high tone keeps it awake. Tune it, then <b>play a test sound</b> and
        listen at the kiosk for a clipped start — adjust until it's clean and silent. Set frequency
        to <code>0</code> to turn it off.
      </p>
      <div className="row" style={{ alignItems: 'flex-end', gap: 16 }}>
        <div>
          <label>Frequency (Hz)</label>
          <input
            type="number"
            value={hz}
            onChange={(e) => setHz(e.target.value)}
            placeholder="20000"
            style={{ width: 120 }}
          />
          <div className="muted" style={{ fontSize: '.72rem', marginTop: 3 }}>
            High enough to be inaudible (18000–22000). 0 = off.
          </div>
        </div>
        <div>
          <label>Gain (0–1)</label>
          <input
            type="number"
            step="0.01"
            value={gain}
            onChange={(e) => setGain(e.target.value)}
            placeholder="0.05"
            style={{ width: 100 }}
          />
          <div className="muted" style={{ fontSize: '.72rem', marginTop: 3 }}>
            Louder holds it awake better; faint whine? lower it.
          </div>
        </div>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="act" disabled={!loaded} onClick={apply}>
          Apply
        </button>
        <button
          className="act sec"
          onClick={() => {
            testAudio();
            flash('▶ Test sound sent to the kiosk — listen there');
          }}
        >
          Play test sound
        </button>
        <span className="muted">{msg}</span>
      </div>
    </div>
  );
}
