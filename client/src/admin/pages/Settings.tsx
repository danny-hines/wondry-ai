import { useEffect, useState } from 'react';
import { useAdmin } from '../AdminContext';
import { getAudioConfig, setAudioConfig, testAudio } from '../../lib/api';
import type { AdminConfig, ContentTypeManifest, UsageReport, PromptVersion } from '../../lib/types';
import { phWhen } from './common';
import { SubNav } from './SubNav';

// A system-prompt editor with version history: every Save appends a restorable
// version (deduped server-side). Click a version to load it into the editor, then
// Save to apply it (which itself pushes a new history entry). onSave persists the
// live value; promptKey identifies the history series on the server.
function PromptEditor({
  title,
  blurb,
  promptKey,
  initialValue,
  defaultValue,
  onSave,
}: {
  title: string;
  blurb: string;
  promptKey: string;
  initialValue: string;
  defaultValue: string;
  onSave: (v: string) => Promise<unknown>;
}) {
  const api = useAdmin();
  const [value, setValue] = useState(initialValue);
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [msg, setMsg] = useState('');
  const loadHistory = () =>
    api
      .promptHistory(promptKey)
      .then((r) => setVersions(r.versions))
      .catch(() => {});
  useEffect(() => {
    loadHistory(); /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [promptKey]);
  const save = async (v: string, label = 'Saved ✓') => {
    await onSave(v);
    setMsg(label);
    setTimeout(() => setMsg(''), 2500);
    loadHistory();
  };
  // The live saved value is the newest version (or the loaded config value before any
  // save). Save is enabled only when the editor differs from it.
  const savedValue = versions[0]?.value ?? initialValue;
  const dirty = value !== savedValue;
  return (
    <div className="card">
      <h3 style={{ marginBottom: 6 }}>{title}</h3>
      <p className="muted" style={{ marginBottom: 10 }}>
        {blurb}
      </p>
      <div className="prompt-edit">
        <textarea value={value} onChange={(e) => setValue(e.target.value)} />
        <div className="prompt-history">
          <div className="ph-head">History</div>
          {versions.length ? (
            versions.map((v) => (
              <button
                key={v.id}
                type="button"
                className={`ph-item${v.value === value ? ' on' : ''}`}
                onClick={() => setValue(v.value)}
                title="Load this version into the editor (then Save to apply)"
              >
                <span className="ph-when">{phWhen(v.created_at)}</span>
                <span className="muted">
                  {v.author}
                  {v.note ? ` · ${v.note}` : ''}
                </span>
              </button>
            ))
          ) : (
            <span className="muted" style={{ fontSize: '.8rem' }}>
              No saved versions yet.
            </span>
          )}
        </div>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="act" disabled={!dirty} onClick={() => save(value)}>
          Save
        </button>
        <button
          className="act sec"
          disabled={savedValue === defaultValue}
          onClick={() => {
            setValue(defaultValue);
            save(defaultValue, 'Reset ✓');
          }}
        >
          Reset to default
        </button>
        <span className="muted">{msg}</span>
      </div>
    </div>
  );
}

// Audio keepalive tuner (Settings → Kiosk & device). The Pi's speaker clips the start
// of sounds after silence; a continuous inaudible tone keeps the output device awake.
// Apply broadcasts to the kiosk live; "Play test sound" fires a sharp tone there so a
// parent standing by the device can listen for clipping. Mirrors the `wondry audio` CLI.
function AudioKeepalive() {
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

type SettingsTab = 'general' | 'content' | 'kiosk' | 'prompts';
const SETTINGS_TABS: [SettingsTab, string][] = [
  ['general', 'General'],
  ['content', 'Content'],
  ['kiosk', 'Kiosk & device'],
  ['prompts', 'AI prompts'],
];

export function Settings() {
  const api = useAdmin();
  const [c, setC] = useState<AdminConfig | null>(null);
  const [rich, setRich] = useState('');
  const [cap, setCap] = useState('0');
  const [richMsg, setRichMsg] = useState('');
  const [wake, setWake] = useState<{ enabled: boolean; phrase: string }>({
    enabled: false,
    phrase: '',
  });
  const [wakeMsg, setWakeMsg] = useState('');
  const [kioskPin, setKioskPin] = useState('');
  const [pinMsg, setPinMsg] = useState('');
  const [types, setTypes] = useState<ContentTypeManifest[]>([]);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [tab, setTab] = useState<SettingsTab>(
    () => (sessionStorage.getItem('imag_settings_tab') as SettingsTab) || 'general',
  );
  const pickTab = (t: SettingsTab) => {
    setTab(t);
    sessionStorage.setItem('imag_settings_tab', t);
  };
  useEffect(() => {
    api
      .config()
      .then((cfg) => {
        setC(cfg);
        setRich(cfg.richness.selected);
        setCap(String(cfg.richness.dailyCap || 0));
        setWake({ enabled: cfg.wake.enabled, phrase: cfg.wake.phrase });
        setKioskPin(cfg.kioskPin || '0000');
      })
      .catch(() => {});
  }, [api]);
  // Keep the cached config fresh after a prompt save, so the editor shows the current
  // text if the sub-tab is left and re-entered (which remounts the editors).
  const reloadConfig = () =>
    api
      .config()
      .then(setC)
      .catch(() => {});
  useEffect(() => {
    api
      .contentTypes()
      .then((d) => setTypes(d.types))
      .catch(() => {});
    api
      .usage()
      .then(setUsage)
      .catch(() => {});
  }, [api]);
  const toggleType = async (t: ContentTypeManifest) => {
    await api.setContentTypeEnabled(t.id, !t.enabled);
    setTypes((ts) => ts.map((x) => (x.id === t.id ? { ...x, enabled: !x.enabled } : x)));
  };
  if (!c) return <p className="muted">Loading…</p>;
  const selTier = c.richness.tiers.find((t) => t.id === rich);
  return (
    <>
      <SubNav tabs={SETTINGS_TABS} active={tab} onSelect={pickTab} />

      {tab === 'general' && (
        <>
          <div className="card">
            <h3 style={{ marginBottom: 6 }}>Generation</h3>
            <p className="muted">
              Currently:{' '}
              <b>
                {c.liveGeneration
                  ? 'LIVE — using Claude'
                  : 'MOCK — set ANTHROPIC_API_KEY to go live'}
              </b>
              . Per-task routing (edit in config.json):
            </p>
            {Object.entries(c.routing).map(([k, v]) => (
              <div className="row" key={k}>
                <span style={{ minWidth: 110, fontWeight: 600 }}>{k}</span>
                <span className="muted">{v}</span>
              </div>
            ))}
          </div>
          <div className="card">
            <h3 style={{ marginBottom: 6 }}>API usage (estimated cost)</h3>
            <p className="muted" style={{ marginBottom: 10 }}>
              Estimated spend from generation, using the per-model prices in{' '}
              <code>config.json</code>. Estimates only — check your provider dashboard for exact
              billing.
            </p>
            {usage ? (
              <>
                <div className="row" style={{ gap: 24, flexWrap: 'wrap' }}>
                  {(
                    [
                      ['Today', 'today'],
                      ['Last 7 days', 'week'],
                      ['Last 30 days', 'month'],
                      ['Lifetime', 'lifetime'],
                    ] as const
                  ).map(([label, key]) => {
                    const b = usage[key];
                    return (
                      <div key={key} style={{ minWidth: 108 }}>
                        <label>{label}</label>
                        <div style={{ fontSize: '1.5rem', fontWeight: 800 }}>
                          ${b.cost.toFixed(2)}
                        </div>
                        <div className="muted" style={{ fontSize: '.8rem' }}>
                          {b.n} call{b.n === 1 ? '' : 's'} ·{' '}
                          {Math.round((b.inTok + b.outTok) / 1000)}k tok
                        </div>
                      </div>
                    );
                  })}
                </div>
                {usage.byModelMonth.length > 0 && (
                  <div style={{ marginTop: 14 }}>
                    <label>By model (last 30 days)</label>
                    {usage.byModelMonth.map((m) => (
                      <div className="row" key={m.model || '?'}>
                        <span style={{ minWidth: 240 }}>{m.model || 'unknown'}</span>
                        <span className="muted">
                          ${m.cost.toFixed(2)} · {m.n} call{m.n === 1 ? '' : 's'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="muted">
                No usage recorded yet (or running on the mock provider — mock generation is free).
              </p>
            )}
          </div>
        </>
      )}

      {tab === 'content' && (
        <>
          <div className="card">
            <h3 style={{ marginBottom: 6 }}>Content richness</h3>
            <p className="muted" style={{ marginBottom: 10 }}>
              How rich and interactive the pages generated for your kids are. Richer tiers use a
              more capable model and a bigger token budget — better visuals, but slower and more
              costly per page. (Parents can override this per page when creating one.)
            </p>
            <div className="row" style={{ alignItems: 'flex-end', gap: 12 }}>
              <div>
                <label>Default richness</label>
                <select value={rich} onChange={(e) => setRich(e.target.value)}>
                  {c.richness.tiers.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                      {t.id === c.richness.default ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {selTier && (
              <p className="muted" style={{ marginTop: 8 }}>
                {selTier.description}{' '}
                <span style={{ opacity: 0.7 }}>
                  · model: {selTier.provider}, up to {selTier.maxTokens.toLocaleString()}{' '}
                  tokens/page
                </span>
              </p>
            )}
            <div className="row" style={{ marginTop: 14, alignItems: 'flex-end', gap: 12 }}>
              <div>
                <label>Daily cap on kid-requested pages</label>
                <input
                  type="number"
                  min={0}
                  value={cap}
                  onChange={(e) => setCap(e.target.value)}
                  style={{ width: 120 }}
                />
              </div>
              <span className="muted" style={{ flex: 1, minWidth: 220 }}>
                0 = unlimited. Past the cap, pages a child asks for that day drop to the simplest
                tier to control cost. Pages you create are never capped.
              </span>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button
                className="act"
                onClick={async () => {
                  await api.saveConfig({ richness: rich, dailyCap: Number(cap) || 0 });
                  setRichMsg('Saved ✓');
                }}
              >
                Save
              </button>
              <span className="muted">{richMsg}</span>
            </div>
          </div>
          <div className="card">
            <h3 style={{ marginBottom: 6 }}>Content types</h3>
            <p className="muted" style={{ marginBottom: 10 }}>
              Turn kinds of content on or off everywhere. The capability tags show what each type
              uses. Per-child controls are under Kids.
            </p>
            {types.map((t) => (
              <div
                className="row"
                key={t.id}
                style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}
              >
                <span>
                  {t.emoji} <b>{t.label}</b>{' '}
                  <span className="muted">
                    · {t.renderer}
                    {t.uses.mic ? ' · mic' : ''}
                    {t.uses.media ? ' · media' : ''}
                  </span>
                </span>
                <button className={`chip ${t.enabled ? 'on' : ''}`} onClick={() => toggleType(t)}>
                  {t.enabled ? 'On' : 'Off'}
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {tab === 'kiosk' && (
        <>
          <div className="card">
            <h3 style={{ marginBottom: 6 }}>Kiosk access PIN</h3>
            <p className="muted" style={{ marginBottom: 10 }}>
              On the kiosk, press and hold the avatar for 5 seconds to open a parent menu (Update
              &amp; Reload). This 4-digit PIN unlocks it. Low-stakes — it just keeps kids out of the
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
              installed on the Pi (re-run the installer and say yes). When off, kids tap the avatar
              to talk.
            </p>
            <div className="row" style={{ alignItems: 'flex-end', gap: 12 }}>
              <div>
                <label>Wake word</label>
                <select
                  value={wake.phrase}
                  onChange={(e) => setWake((w) => ({ ...w, phrase: e.target.value }))}
                >
                  {c.wake.phrases.map((p) => (
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
      )}

      {tab === 'prompts' && c && (
        <>
          <PromptEditor
            title="Chat personality &amp; safety"
            promptKey="chat_system_prompt"
            blurb="How the avatar talks to your kids and handles tricky or inappropriate questions. Read aloud, so keep it spoken-style."
            initialValue={c.chatSystemPrompt}
            defaultValue={c.defaultChatSystemPrompt}
            onSave={async (v) => {
              await api.saveConfig({ chatSystemPrompt: v });
              reloadConfig();
            }}
          />
          <PromptEditor
            title="Page-generation system prompt"
            promptKey="artifact_system_prompt"
            blurb="The instructions that shape every interactive page generated for your kids."
            initialValue={c.systemPrompt}
            defaultValue={c.defaultSystemPrompt}
            onSave={async (v) => {
              await api.saveConfig({ systemPrompt: v });
              reloadConfig();
            }}
          />
          <PromptEditor
            title="Reading-lesson system prompt"
            promptKey="reading_system_prompt"
            blurb="Shapes the leveled read-along stories. It must keep emitting the strict JSON the Reader expects, so edit content/tone rather than the output format."
            initialValue={c.readingSystemPrompt}
            defaultValue={c.defaultReadingSystemPrompt}
            onSave={async (v) => {
              await api.saveConfig({ readingSystemPrompt: v });
              reloadConfig();
            }}
          />
        </>
      )}
    </>
  );
}
