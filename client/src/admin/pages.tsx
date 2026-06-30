import { useEffect, useRef, useState } from 'react';
import { useAdmin } from './AdminContext';
import { getVoices, getSchedules, createTimer, createReminder, cancelSchedule, getAudioConfig, setAudioConfig, testAudio } from '../lib/api';
import { readableOn } from '../lib/contrast';
import { Avatar } from '../kiosk/Avatar';
import type { AvatarEngine } from '../kiosk/avatarEngine';
import { useSpeech } from '../kiosk/useSpeech';
import type { Profile, Artifact, AdminConfig, LogMessage, SafetyEntry, ReadingReportRow, ContentTypeManifest, RichnessTier, UsageReport, ScheduleItem, EvalsResponse, EvalKind, EvalSuggestion, PromptVersion, FacesResponse, FaceCluster } from '../lib/types';

const when = (t: number) => new Date(t).toLocaleString();

// Canonical reading levels offered in the Kids editor. Stored as free text and
// interpolated into generation/chat prompts, so these strings are the source of truth.
const READING_LEVELS = ['pre-reader', 'early reader', 'developing reader', 'fluent reader', 'advanced reader'];

export function Log() {
  const api = useAdmin();
  const [messages, setMessages] = useState<LogMessage[]>([]);
  const [safety, setSafety] = useState<SafetyEntry[]>([]);
  useEffect(() => { api.log().then((d) => { setMessages(d.messages); setSafety(d.safety); }).catch(() => {}); }, [api]);
  const flags = safety.filter((s) => s.verdict === 'block');
  return (
    <>
      {flags.length > 0 && (
        <div className="card" style={{ borderColor: '#fca5a5' }}>
          <b>⚠ {flags.length} blocked input(s)</b>
          {flags.slice(0, 5).map((f) => <div key={f.id} className="muted">{f.reason} — “{f.sample}” · {when(f.created_at)}</div>)}
        </div>
      )}
      <div className="card">
        <h3 style={{ marginBottom: 8 }}>Recent activity</h3>
        {messages.length === 0 && <p className="muted">No activity yet.</p>}
        {messages.map((m) => (
          <div className="msg" key={m.id}>
            <span className="who"><span className="pill" style={{ background: m.color }}>{m.initials}</span></span>
            <span className={`role-${m.role}`} style={{ minWidth: 60, fontWeight: 700 }}>{m.role}</span>
            <span style={{ flex: 1 }}>{m.kind === 'artifact' ? '🧩 ' : ''}{m.text}{m.artifact_title ? <span className="muted"> (→ {m.artifact_title})</span> : null}{m.safety_flag ? <span className="flag"> ⚠ flagged</span> : null}</span>
            <span className="muted">{when(m.created_at)}</span>
          </div>
        ))}
      </div>
    </>
  );
}

export function Pages({ refreshKey = 0 }: { refreshKey?: number } = {}) {
  const api = useAdmin();
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [kids, setKids] = useState<Profile[]>([]);
  const load = () => api.artifacts().then((d) => { setArtifacts(d.artifacts); setKids(d.kids); }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [api, refreshKey]);
  // While anything is still generating, poll so it flips to ready (and shows its cost) without a manual refresh.
  useEffect(() => {
    if (!artifacts.some((a) => a.status === 'generating')) return;
    const t = setTimeout(load, 4000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifacts]);
  const toggle = async (a: Artifact, kid: Profile, on: boolean) => { await api.setAudience(a.id, kid.id, on); load(); };
  const del = async (a: Artifact) => { if (!confirm(`Delete "${a.title}"? This permanently removes the page for everyone.`)) return; await api.deleteArtifact(a.id); load(); };
  if (!artifacts.length) return <p className="muted">No content yet. Generate one above, or have a child ask the avatar to build one.</p>;
  return (
    <>
      {artifacts.map((a) => (
        <div className="card" key={a.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <span style={{ fontSize: '1.4rem' }}>{a.emoji || '✨'}</span> <b>{a.title}</b> <span className={`tag ${a.status}`}>{a.status}</span>
              <div className="muted">{a.source} · {a.profile_name || 'unassigned'} · {when(a.created_at)}{a.cost ? ` · ~$${a.cost.toFixed(4)}` : ''}{a.error ? ' · ⚠ ' + a.error : ''}</div>
            </div>
            <div className="row">
              {a.status === 'ready' && <a className="act sec" href={`/preview/${a.id}`} target="_blank" rel="noreferrer">Preview</a>}
              <button className="act warn" onClick={() => del(a)}>Delete</button>
            </div>
          </div>
          <div className="row" style={{ marginTop: 12, alignItems: 'center' }}>
            <span className="muted" style={{ minWidth: 70 }}>Publish to:</span>
            {kids.length ? kids.map((k) => {
              const on = (a.audience || []).includes(k.id);
              return <button key={k.id} className={`chip ${on ? 'on' : ''}`} title={on ? 'Published — click to unpublish' : 'Click to publish'}
                style={on ? { background: k.color, borderColor: k.color, color: readableOn(k.color) } : { borderColor: k.color, color: k.color }}
                onClick={() => toggle(a, k, !on)}><span className="ind">{on ? '✓' : '+'}</span>{k.name}</button>;
            }) : <span className="muted">add a child under the Kids tab</span>}
          </div>
        </div>
      ))}
    </>
  );
}

// Manifest-driven: one form that adapts to whichever content type you pick, built
// from each type's createForm. New content types appear here automatically.
export function Create({ onCreated }: { onCreated?: () => void } = {}) {
  const api = useAdmin();
  const [types, setTypes] = useState<ContentTypeManifest[]>([]);
  const [kids, setKids] = useState<Profile[]>([]);
  const [typeId, setTypeId] = useState('');
  const [params, setParams] = useState<Record<string, string>>({});
  const [kid, setKid] = useState('');
  const [msg, setMsg] = useState('');
  const [richTiers, setRichTiers] = useState<RichnessTier[]>([]);
  const [richOverride, setRichOverride] = useState('');
  useEffect(() => {
    api.contentTypes().then((d) => { const t = d.types.filter((x) => x.authorable && x.enabled); setTypes(t); if (t[0]) setTypeId(t[0].id); }).catch(() => {});
    api.profiles().then((d) => setKids(d.profiles)).catch(() => {});
    api.config().then((cfg) => setRichTiers(cfg.richness.tiers)).catch(() => {});
  }, [api]);
  const type = types.find((t) => t.id === typeId);
  const setP = (k: string, v: string) => setParams((p) => ({ ...p, [k]: v }));
  const go = async () => {
    if (!typeId) return;
    setMsg('Generating…');
    const r = await api.createContent({ typeId, params, profileId: kid || undefined, richness: richOverride || undefined }).catch(() => null);
    setMsg(r?.ok ? 'Done! It will appear below — preview and publish it there.' : 'Error generating — is the server running?');
    setParams({});
    if (r?.ok) onCreated?.();
  };
  return (
    <div className="card">
      <h3 style={{ marginBottom: 10 }}>Create content</h3>
      <p className="muted" style={{ marginBottom: 14 }}>Pick what to make. It's generated and held below for review — preview it, then publish to a child. Tailor it to a child to use their interests &amp; level.</p>
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', gap: 16 }}>
        <div><label>Type</label>
          <select value={typeId} onChange={(e) => { setTypeId(e.target.value); setParams({}); setMsg(''); }}>
            {types.map((t) => <option key={t.id} value={t.id}>{t.emoji} {t.label}</option>)}
          </select></div>
        <div><label>For child (optional)</label>
          <select value={kid} onChange={(e) => setKid(e.target.value)}>
            <option value="">No specific child</option>
            {kids.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select></div>
        {type?.renderer === 'sandbox-html' && richTiers.length > 0 && (
          <div><label>Richness (this page)</label>
            <select value={richOverride} onChange={(e) => setRichOverride(e.target.value)}>
              <option value="">Use global setting</option>
              {richTiers.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select></div>
        )}
      </div>
      {type && type.createForm.map((f) => (
        <div key={f.key} style={{ marginTop: 10 }}>
          <label>{f.label}</label>
          {f.type === 'textarea'
            ? <textarea value={params[f.key] || ''} placeholder={f.placeholder} onChange={(e) => setP(f.key, e.target.value)} />
            : f.type === 'level'
              ? <select value={params[f.key] || ''} onChange={(e) => setP(f.key, e.target.value)} style={{ width: '100%' }}>
                  <option value="">Auto level</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>Level {n}</option>)}
                </select>
              : <input value={params[f.key] || ''} placeholder={f.placeholder} onChange={(e) => setP(f.key, e.target.value)} style={{ width: '100%' }} />}
        </div>
      ))}
      {type && type.triggersHelp && <p className="muted" style={{ marginTop: 10 }}>Kids can also just ask — {type.triggersHelp}</p>}
      <div className="row" style={{ marginTop: 12 }}><button className="act" onClick={go}>Generate</button><span className="muted">{msg}</span></div>
    </div>
  );
}

// The "Content" tab: create new content at the top, then the list of everything
// generated (held for review, publish/share/delete, with its est. cost) below.
export function Content() {
  const [v, setV] = useState(0);
  return (
    <>
      <Create onCreated={() => setV((n) => n + 1)} />
      <Pages refreshKey={v} />
    </>
  );
}

// A live, themed mini-kiosk for one child: the real avatar engine + static
// conversation bubbles in the child's accent + light/dark theme. "Hear voice"
// speaks a line through the selected (possibly unsaved) Piper voice and drives
// the avatar's mouth, falling back to browser speech if Piper isn't installed.
function KidPreview({ name, color, theme, voice }: { name: string; color: string; theme: 'light' | 'dark'; voice?: string | null }) {
  const avatarRef = useRef<AvatarEngine | null>(null);
  const { speak, speakingId } = useSpeech(avatarRef);
  const [busy, setBusy] = useState(false);
  useEffect(() => { avatarRef.current?.setColor(color); }, [color]);
  const hear = async () => {
    setBusy(true);
    avatarRef.current?.setColor(color);
    await speak(`Hi ${name || 'friend'}! Want to learn something fun today?`, undefined, 'kp', voice || undefined);
    setBusy(false);
  };
  return (
    <div className={`kid-preview${theme === 'dark' ? ' theme-dark' : ''}`} style={{ ['--user' as any]: color, ['--user-fg' as any]: readableOn(color) }}>
      <div className="kp-stage">
        <div className="kp-avatar"><Avatar ref={avatarRef} /></div>
        <div className="kp-bubbles">
          <div className="kp-bubble kid">Why is the sky blue?</div>
          <div className={`kp-bubble avatar${speakingId === 'kp' ? ' speaking' : ''}`}>Great question! Sunlight bounces off tiny bits in the air, and blue scatters the most. ☀️💙</div>
        </div>
      </div>
      <div className="kp-foot">
        <button className="act sec" onClick={hear} disabled={busy}>{busy ? 'Speaking…' : '▶ Hear voice'}</button>
        <span className="muted">Live preview of {name || 'this child'}'s kiosk</span>
      </div>
    </div>
  );
}

export function Kids() {
  const api = useAdmin();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [voices, setVoices] = useState<string[]>([]);
  const [browserVoice, setBrowserVoice] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [types, setTypes] = useState<ContentTypeManifest[]>([]);
  const [np, setNp] = useState({ name: '', age: '', reading_level: '', color: '#8b5cf6' });
  const load = () => api.profiles().then((d) => setProfiles(d.profiles)).catch(() => {});
  useEffect(() => { load(); getVoices().then((v) => { setVoices(v.voices); setBrowserVoice(v.browserVoice ?? null); }); api.contentTypes().then((d) => setTypes(d.types)).catch(() => {}); }, [api]);
  const setField = (id: string, f: keyof Profile, v: any) => setProfiles((ps) => ps.map((p) => p.id === id ? { ...p, [f]: v } : p));
  const disabledSet = (p: Profile) => new Set((p.disabled_types || '').split(',').map((s) => s.trim()).filter(Boolean));
  const toggleType = (p: Profile, id: string) => { const s = disabledSet(p); s.has(id) ? s.delete(id) : s.add(id); setField(p.id, 'disabled_types', [...s].join(',')); };
  const save = async (p: Profile) => {
    setSavingId(p.id); setSavedId(null);
    try {
      await api.saveProfile({ id: p.id, name: p.name, initials: p.initials, color: p.color, age: p.age, reading_level: p.reading_level, voice: p.voice, persona: p.persona, theme: p.theme === 'dark' ? 'dark' : 'light', interests: p.interests, disabledTypes: [...disabledSet(p)] });
      setSavedId(p.id);
      setTimeout(() => setSavedId((s) => (s === p.id ? null : s)), 2500);
    } finally { setSavingId((s) => (s === p.id ? null : s)); }
  };
  const remove = async (p: Profile) => { if (!confirm(`Remove ${p.name}? This deletes their conversation history and activity. Pages they created are kept (unassigned). This can't be undone.`)) return; await api.deleteProfile(p.id); load(); };
  const add = async () => { if (!np.name) return; await api.saveProfile({ name: np.name, age: Number(np.age) || null, reading_level: np.reading_level, color: np.color }); setNp({ name: '', age: '', reading_level: '', color: '#8b5cf6' }); load(); };
  return (
    <>
      {profiles.map((p) => (
        <div className="card" key={p.id}>
          <div className="grid">
            <div><label>Name</label><input value={p.name} onChange={(e) => setField(p.id, 'name', e.target.value)} style={{ width: '100%' }} /></div>
            <div><label>Initials</label><input value={p.initials} onChange={(e) => setField(p.id, 'initials', e.target.value)} style={{ width: '100%' }} /></div>
            <div><label>Age</label><input type="number" value={p.age ?? ''} onChange={(e) => setField(p.id, 'age', Number(e.target.value) || null)} style={{ width: '100%' }} /></div>
            <div><label>Reading level</label>
              <select value={p.reading_level ?? ''} onChange={(e) => setField(p.id, 'reading_level', e.target.value || null)} style={{ width: '100%' }}>
                <option value="">(not set)</option>
                {READING_LEVELS.map((rl) => <option key={rl} value={rl}>{rl}</option>)}
                {p.reading_level && !READING_LEVELS.includes(p.reading_level) && <option value={p.reading_level}>{p.reading_level}</option>}
              </select></div>
            <div><label>Voice</label>
              <select value={p.voice ?? ''} onChange={(e) => setField(p.id, 'voice', e.target.value)} style={{ width: '100%' }}>
                <option value="">{voices.length ? '(default voice)' : 'run: npm run setup-piper'}</option>
                {browserVoice && <option value={browserVoice}>🤖 Robot (on-device, fastest)</option>}
                {voices.some((v) => !v.startsWith('kokoro:')) && (
                  <optgroup label="Piper">{voices.filter((v) => !v.startsWith('kokoro:')).map((v) => <option key={v} value={v}>{v}</option>)}</optgroup>
                )}
                {voices.some((v) => v.startsWith('kokoro:')) && (
                  <optgroup label="Kokoro (more natural)">{voices.filter((v) => v.startsWith('kokoro:')).map((v) => <option key={v} value={v}>{v.slice(7)}</option>)}</optgroup>
                )}
              </select></div>
            <div><label>Assistant personality (future)</label><input value={p.persona ?? ''} onChange={(e) => setField(p.id, 'persona', e.target.value)} placeholder="e.g. playful and patient" style={{ width: '100%' }} /></div>
            <div><label>Interests (themes reading stories)</label><input value={p.interests ?? ''} onChange={(e) => setField(p.id, 'interests', e.target.value)} placeholder="dinosaurs, space, Minecraft" style={{ width: '100%' }} /></div>
          </div>
          <div className="row" style={{ marginTop: 12, alignItems: 'flex-end', gap: 22 }}>
            <div><label>Color</label><input type="color" value={p.color} onChange={(e) => setField(p.id, 'color', e.target.value)} /></div>
            <div><label>Appearance</label>
              <div className="seg">
                <button type="button" className={p.theme !== 'dark' ? 'on' : ''} onClick={() => setField(p.id, 'theme', 'light')}>☀ Light</button>
                <button type="button" className={p.theme === 'dark' ? 'on' : ''} onClick={() => setField(p.id, 'theme', 'dark')}>🌙 Dark</button>
              </div></div>
          </div>
          {types.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <label>Activities for {p.name || 'this child'}</label>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                {types.map((t) => {
                  const on = t.enabled && !disabledSet(p).has(t.id);
                  return <button key={t.id} type="button" className={`chip ${on ? 'on' : ''}`}
                    title={!t.enabled ? 'Turned off globally in Settings' : on ? 'On — click to turn off for this child' : 'Off for this child — click to turn on'}
                    disabled={!t.enabled}
                    style={on ? { background: p.color, borderColor: p.color, color: readableOn(p.color) } : {}}
                    onClick={() => toggleType(p, t.id)}><span className="ind">{on ? '✓' : '·'}</span>{t.emoji} {t.label}</button>;
                })}
              </div>
            </div>
          )}
          <KidPreview name={p.name} color={p.color} theme={p.theme === 'dark' ? 'dark' : 'light'} voice={p.voice} />
          <div className="row" style={{ marginTop: 12, alignItems: 'center' }}>
            <button className="act" disabled={savingId === p.id} onClick={() => save(p)}>{savingId === p.id ? 'Saving…' : 'Save'}</button>
            <button className="act warn" onClick={() => remove(p)}>Remove child</button>
            {savedId === p.id && <span className="muted">Saved ✓</span>}
          </div>
        </div>
      ))}
      <div className="card"><h3 style={{ marginBottom: 10 }}>Add a child</h3>
        <div className="row">
          <input placeholder="Name" value={np.name} onChange={(e) => setNp({ ...np, name: e.target.value })} />
          <input type="number" placeholder="Age" style={{ width: 90 }} value={np.age} onChange={(e) => setNp({ ...np, age: e.target.value })} />
          <select value={np.reading_level} onChange={(e) => setNp({ ...np, reading_level: e.target.value })}>
            <option value="">Reading level…</option>
            {READING_LEVELS.map((rl) => <option key={rl} value={rl}>{rl}</option>)}
          </select>
          <input type="color" value={np.color} onChange={(e) => setNp({ ...np, color: e.target.value })} />
          <button className="act" onClick={add}>Add</button>
        </div>
      </div>
    </>
  );
}

// Per-child read-aloud progress: accuracy and the words they most often miss.
// Device-global scheduling: countdown timers + wall-clock reminders/alarms (a shared
// kiosk, not per child). Manages the timezone the wall-clock times are read in, shows
// the live server clock so a skewed OS clock is visible, and lists/cancels everything
// — including items set on the kiosk by voice.
export function Scheduling() {
  const api = useAdmin();
  const [cfg, setCfg] = useState<AdminConfig | null>(null);
  const [tz, setTz] = useState('');
  const [tzSaved, setTzSaved] = useState(false);
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const clockBase = useRef<{ server: number; at: number } | null>(null);
  // Timer + reminder drafts.
  const [mins, setMins] = useState(''); const [timerLabel, setTimerLabel] = useState('');
  const [remAt, setRemAt] = useState(''); const [remMsg, setRemMsg] = useState(''); const [remErr, setRemErr] = useState('');

  const loadCfg = () => api.config().then((c) => { setCfg(c); setTz(c.timezone); clockBase.current = { server: c.serverTime, at: Date.now() }; }).catch(() => {});
  const loadSch = () => getSchedules().then((r) => setSchedules(r.schedules)).catch(() => {});
  useEffect(() => {
    loadCfg(); loadSch();
    const reload = setInterval(loadSch, 5000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(reload); clearInterval(tick); };
  }, [api]);

  // Live server clock = the server time we fetched + elapsed wall time since.
  const serverNow = clockBase.current ? clockBase.current.server + (now - clockBase.current.at) : now;
  const serverClock = (() => {
    try { return new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, weekday: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).format(new Date(serverNow)); }
    catch { return new Date(serverNow).toLocaleTimeString(); }
  })();
  const countdown = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`; };

  const saveTz = async (z: string) => { setTz(z); await api.saveConfig({ timezone: z }); setTzSaved(true); setTimeout(() => setTzSaved(false), 2000); loadCfg(); loadSch(); };
  const addTimer = async (minutes: number, label?: string) => {
    const ms = Math.round(minutes * 60000);
    if (!Number.isFinite(ms) || ms < 1000) return;
    await createTimer(ms, label?.trim() || null, 'parent'); setMins(''); setTimerLabel(''); loadSch();
  };
  const addReminder = async () => {
    setRemErr(''); if (!remAt) return;
    try { const r = await createReminder(remAt, remMsg.trim() || null); if (r?.error) { setRemErr(r.error); return; } }
    catch { setRemErr('Could not set reminder.'); return; }
    setRemAt(''); setRemMsg(''); loadSch();
  };
  const cancel = async (id: string) => { await cancelSchedule(id); loadSch(); };

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label>Timezone (wall-clock times are read in this zone)</label>
            <select value={tz} onChange={(e) => saveTz(e.target.value)} style={{ width: '100%', maxWidth: 360 }}>
              {cfg?.timezones?.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
            <div className="muted" style={{ marginTop: 4 }}>
              Detected on device: {cfg?.detectedTimezone || '…'}{tzSaved && <span style={{ color: '#16a34a' }}> · saved</span>}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <label>Server clock</label>
            <div style={{ fontSize: '1.15rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{serverClock}</div>
            <div className="muted">If this is wrong, the kiosk's clock needs syncing (NTP).</div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong style={{ fontSize: '1.05rem' }}>New timer</strong>
          <div className="row" style={{ gap: 6 }}>
            {[5, 10, 15, 30].map((m) => <button key={m} className="act sec" onClick={() => addTimer(m)}>{m} min</button>)}
          </div>
        </div>
        <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
          <div><label>Minutes</label><input type="number" min="1" value={mins} onChange={(e) => setMins(e.target.value)} style={{ width: 90 }} /></div>
          <div style={{ flex: 1, minWidth: 160 }}><label>Label (optional)</label>
            <input value={timerLabel} onChange={(e) => setTimerLabel(e.target.value)} placeholder="clean up toys" style={{ width: '100%' }} /></div>
          <button className="act" disabled={!(Number(mins) > 0)} onClick={() => addTimer(Number(mins), timerLabel)}>Start timer</button>
        </div>
      </div>

      <div className="card">
        <strong style={{ fontSize: '1.05rem' }}>New reminder / alarm <span className="muted" style={{ fontWeight: 400 }}>· one-time</span></strong>
        <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
          <div><label>When</label><input type="datetime-local" value={remAt} onChange={(e) => setRemAt(e.target.value)} /></div>
          <div style={{ flex: 1, minWidth: 180 }}><label>Message (optional — spoken aloud)</label>
            <input value={remMsg} onChange={(e) => setRemMsg(e.target.value)} placeholder="brush your teeth" style={{ width: '100%' }} /></div>
          <button className="act" disabled={!remAt} onClick={addReminder}>Set reminder</button>
        </div>
        {remErr && <div className="muted" style={{ color: '#b91c1c', marginTop: 6 }}>{remErr}</div>}
        <div className="muted" style={{ marginTop: 8 }}>Anyone at the kiosk can also say “set an alarm for 7am” or “remind me to feed the fish at 5.”</div>
      </div>

      <div className="card">
        <strong style={{ fontSize: '1.05rem' }}>Scheduled</strong>
        <div style={{ marginTop: 10 }}>
          {schedules.length ? schedules.map((s) => (
            <div className="row" key={s.id} style={{ justifyContent: 'space-between', padding: '5px 0' }}>
              {s.kind === 'timer'
                ? <span>⏰ <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{countdown(s.fire_at - serverNow)}</strong>{s.label ? ` — ${s.label}` : ` (${s.pretty})`}{s.created_by === 'voice' && <span className="muted"> · set on kiosk</span>}</span>
                : <span>🔔 <strong>{s.when}</strong>{s.message ? ` — ${s.message}` : ' — alarm'}{s.created_by === 'voice' && <span className="muted"> · set on kiosk</span>}</span>}
              <button className="act warn" onClick={() => cancel(s.id)}>Cancel</button>
            </div>
          )) : <span className="muted">Nothing scheduled.</span>}
        </div>
      </div>
    </>
  );
}

export function Reading() {
  const api = useAdmin();
  const [report, setReport] = useState<ReadingReportRow[]>([]);
  useEffect(() => { api.readingReport().then((d) => setReport(d.report)).catch(() => {}); }, [api]);
  const pct = (x: number | null) => (x == null ? '—' : Math.round(x * 100) + '%');
  return (
    <>
      <div className="card">
        <h3 style={{ marginBottom: 6 }}>Reading progress</h3>
        <p className="muted">How each child is doing reading aloud. Accuracy is scored per line and kept gentle — it's for encouragement and to adapt difficulty, not to grade.</p>
      </div>
      {report.length === 0 && <p className="muted">No children yet.</p>}
      {report.map((r) => (
        <div className="card" key={r.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div><span className="pill" style={{ background: r.color }}>{r.initials}</span> <b>{r.name}</b> <span className="muted">· {r.reading_level || 'level not set'}</span></div>
            <div className="muted">{r.count} line{r.count === 1 ? '' : 's'} read</div>
          </div>
          {r.count === 0
            ? <p className="muted" style={{ marginTop: 8 }}>No reading yet. Create a reading lesson and publish it to {r.name}.</p>
            : <>
                <div className="row" style={{ marginTop: 12, gap: 28 }}>
                  <div><label>Recent accuracy</label><div style={{ fontSize: '1.5rem', fontWeight: 800 }}>{pct(r.recentAvg)}</div></div>
                  <div><label>All-time</label><div style={{ fontSize: '1.5rem', fontWeight: 800 }}>{pct(r.avg)}</div></div>
                </div>
                {r.missWords.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <label>Tricky words</label>
                    <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                      {r.missWords.map((w) => <span key={w.word} className="chip" style={{ borderColor: '#fca5a5', color: '#dc2626' }}>{w.word}{w.n > 1 ? ` ×${w.n}` : ''}</span>)}
                    </div>
                  </div>
                )}
              </>}
        </div>
      ))}
    </>
  );
}

// Content-quality evals: an AI judge (Opus) scores generated content on accuracy,
// age-fit, engagement, and clarity. Read the weakest items, tighten the AI prompts in
// Settings, re-run, and watch the numbers move. Runs in the background; we poll.
const scoreColor = (v: number | null) => (v == null ? '#9ca3af' : v < 3 ? '#dc2626' : v < 4 ? '#d97706' : '#16a34a');
const Score = ({ v }: { v: number | null }) => <span style={{ color: scoreColor(v), fontWeight: 700 }}>{v == null ? '—' : v.toFixed(1)}</span>;
// A change vs the previous run, shown next to a score (green up / red down).
const Delta = ({ v, prev }: { v: number | null; prev?: number | null }) => {
  if (v == null || prev == null) return null;
  const d = v - prev;
  if (Math.abs(d) < 0.005) return <span className="muted" style={{ fontSize: '.66rem', marginLeft: 4 }}>±0</span>;
  return <span style={{ fontSize: '.66rem', fontWeight: 700, marginLeft: 4, color: d > 0 ? '#16a34a' : '#dc2626' }}>{d > 0 ? '▲' : '▼'}{Math.abs(d).toFixed(2)}</span>;
};
const Dim = ({ label, v, prev }: { label: string; v: number | null; prev?: number | null }) => (
  <div><div className="muted" style={{ fontSize: '.72rem', textTransform: 'uppercase' }}>{label}</div>
    <div style={{ fontSize: '1.5rem', fontWeight: 800, color: scoreColor(v) }}>{v == null ? '—' : v.toFixed(2)}<Delta v={v} prev={prev} /></div></div>
);
const runWhen = (t: number) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
// Line-level diff (LCS) for reviewing a suggested prompt against the current one.
type DiffLine = { type: 'same' | 'add' | 'del'; text: string };
function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split('\n'), B = b.split('\n'), m = A.length, n = B.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let jj = n - 1; jj >= 0; jj--)
    dp[i][jj] = A[i] === B[jj] ? dp[i + 1][jj + 1] + 1 : Math.max(dp[i + 1][jj], dp[i][jj + 1]);
  const out: DiffLine[] = []; let i = 0, j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) { out.push({ type: 'same', text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: A[i] }); i++; }
    else { out.push({ type: 'add', text: B[j] }); j++; }
  }
  while (i < m) out.push({ type: 'del', text: A[i++] });
  while (j < n) out.push({ type: 'add', text: B[j++] });
  return out;
}
const ConfBadge = ({ c }: { c: 'medium' | 'high' }) => (
  <span className="tag" style={{ background: c === 'high' ? '#d1fae5' : '#fef3c7', color: c === 'high' ? '#065f46' : '#92400e' }}>{c} confidence</span>
);

const EVAL_TABS: [EvalKind, string][] = [['page', 'Pages'], ['reading', 'Reading'], ['chat', 'Conversation']];
const EVAL_BLURB: Record<EvalKind, string> = {
  page: 'An AI judge scores generated pages. Where Playwright is installed it judges a screenshot of the rendered page — catching layout, label-positioning, and empty-section bugs the source alone would hide; otherwise it reads the source.',
  reading: 'An AI judge scores generated reading lessons for accuracy, age-fit, engagement, and clarity.',
  chat: 'Runs a fixed set of kid messages through the chat pipeline and judges each spoken reply for accuracy, age-fit, helpfulness, and tone (including whether it redirects sensitive topics kindly).',
};
const BENCH_TIP: Record<EvalKind, string> = {
  page: 'Generate a fixed subject×level grid of fresh pages and judge them — reproducible, so re-run to compare before/after a prompt change.',
  reading: 'Generate a fixed interest×level grid of fresh reading lessons and judge them — reproducible to re-run after a prompt change.',
  chat: 'Run the fixed conversation suite through the chat pipeline and judge each reply — reproducible to re-run after a prompt change.',
};
const LIVE_TIP: Record<EvalKind, string> = {
  page: 'Judge real pages your kids generated that haven’t been scored yet.',
  reading: 'Judge real reading lessons your kids generated that haven’t been scored yet.',
  chat: 'Judge real logged replies sent since the chat prompt last changed.',
};

export function Evals() {
  const api = useAdmin();
  const [tab, setTab] = useState<EvalKind>('page');
  const [data, setData] = useState<EvalsResponse | null>(null);
  const [err, setErr] = useState('');
  const [sugg, setSugg] = useState<EvalSuggestion | null>(null);
  const [suggBusy, setSuggBusy] = useState(false);
  const [suggMsg, setSuggMsg] = useState('');
  const [tableView, setTableView] = useState<'latest' | 'all'>('latest');
  const load = (k: EvalKind = tab) => api.evals(k).then(setData).catch(() => {});
  useEffect(() => { setData(null); setErr(''); setSugg(null); setSuggMsg(''); load(tab); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tab, api]);
  // Poll while a batch is running so the snapshot + table fill in live.
  const running = data?.job.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => load(), 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  const run = async (mode: 'benchmark' | 'live', reeval = false) => {
    setErr('');
    const r = await api.runEvals({ mode, kind: tab, reeval });
    if (r?.error) { setErr(r.error); return; }
    setTimeout(() => load(), 400);
  };

  const suggest = async () => {
    setSuggBusy(true); setSugg(null); setSuggMsg('');
    try {
      const r = await api.suggestPrompt(tab);
      if (r.error) setSuggMsg(r.error); else setSugg(r);
    } catch { setSuggMsg('Could not get a suggestion.'); }
    finally { setSuggBusy(false); }
  };
  const acceptSuggestion = async () => {
    if (!sugg || sugg.state !== 'ok' || !sugg.changed) return;
    // Save as an 'eval'-authored prompt version (tracked + revertible in Settings).
    await api.saveConfig({ [sugg.field]: sugg.revisedPrompt, promptAuthor: 'eval' } as Parameters<typeof api.saveConfig>[0]);
    setSugg(null);
    setSuggMsg('Prompt updated. Re-run the benchmark to see the effect — revert any time in Settings → prompt history.');
  };

  const job = data?.job, dims = data?.dims || [];
  const latest = data?.latestRun || null, allTime = data?.allTime;
  const isChat = tab === 'chat';
  const busy = job?.running || !data?.live;
  const hasLatest = (data?.evals?.length || 0) > 0;
  const view = hasLatest ? tableView : 'all';
  const rows = (view === 'latest' ? data?.evals : data?.allEvals) || [];

  return (
    <>
      <div className="subnav">{EVAL_TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      <p className="muted" style={{ margin: '10px 0 6px' }}>{EVAL_BLURB[tab]}</p>
      <p className="muted" style={{ margin: '0 0 8px', fontSize: '.8rem' }}>
        <strong>Benchmark</strong> = a fixed sample you re-run to compare before/after a prompt change. <strong>Judge live</strong> = score your real {isChat ? 'logged replies' : tab === 'reading' ? 'reading lessons' : 'pages'}. The snapshot shows the latest run with a delta vs the previous run of the same type.
      </p>
      {isChat && data && <p className="muted" style={{ margin: '0 0 12px', fontSize: '.8rem' }}>
        “Judge recent chats” grades real logged replies {data.promptChangedAt
          ? <>sent since the chat prompt last changed (<strong>{phWhen(data.promptChangedAt)}</strong>)</>
          : '(the chat prompt hasn’t been edited, so all logged replies are in scope)'} — so you never grade replies made under an older prompt.
      </p>}
      {data && !data.live && <div className="card"><span className="muted" style={{ color: '#b91c1c' }}>No API key set — the judge needs a live model (set ANTHROPIC_API_KEY).</span></div>}

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            {latest ? <>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <strong style={{ fontSize: '1.05rem' }}>Latest run</strong>
                <span className="tag" style={{ background: latest.mode === 'benchmark' ? '#eef2ff' : '#f1f5f9', color: latest.mode === 'benchmark' ? '#4f46e5' : '#475569' }}>{latest.mode}</span>
                <span className="muted" style={{ fontSize: '.8rem' }}>· {runWhen(latest.when)} · {latest.summary.n} judged</span>
                {latest.promptMatches === false && <span className="tag" style={{ background: '#fef3c7', color: '#92400e' }}>⚠ prompt changed since</span>}
                {latest.promptMatches === true && <span className="muted" style={{ fontSize: '.74rem' }}>✓ current prompt</span>}
              </div>
              <div className="row" style={{ gap: 22, marginTop: 8 }}>
                <Dim label="Overall" v={latest.summary.overall} prev={latest.prevSummary?.overall ?? null} />
                {dims.map(([k, label]) => <Dim key={k} label={label} v={latest.summary.dims[k] ?? null} prev={latest.prevSummary?.dims[k] ?? null} />)}
              </div>
              {latest.prevSummary && <div className="muted" style={{ fontSize: '.74rem', marginTop: 4 }}>Δ vs previous {latest.mode} run{latest.prevWhen ? ` (${runWhen(latest.prevWhen)})` : ''}</div>}
              {latest.summary.safetyConcerns > 0 && <div className="muted" style={{ color: '#b91c1c', marginTop: 6 }}>⚠ {latest.summary.safetyConcerns} item(s) flagged for safety</div>}
              {allTime && allTime.n > 0 && <div className="muted" style={{ fontSize: '.78rem', marginTop: 8 }}>All-time: <Score v={allTime.overall} /> overall across {allTime.n} judged</div>}
            </> : allTime && allTime.n ? <>
              <strong style={{ fontSize: '1.05rem' }}>Quality snapshot</strong> <span className="muted">· all-time · {allTime.n} judged</span>
              <div className="row" style={{ gap: 22, marginTop: 8 }}>
                <Dim label="Overall" v={allTime.overall} />
                {dims.map(([k, label]) => <Dim key={k} label={label} v={allTime.dims[k] ?? null} />)}
              </div>
              <div className="muted" style={{ fontSize: '.78rem', marginTop: 8 }}>Run a benchmark to track latest-run quality with a before/after delta.</div>
            </> : <span className="muted">No evals yet — run a benchmark or judge live outputs to get a snapshot.</span>}
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button className="act" disabled={busy} onClick={() => run('benchmark')} title={BENCH_TIP[tab]}>Run benchmark</button>
            <button className="act sec" disabled={busy} onClick={() => run('live')} title={LIVE_TIP[tab]}>{isChat ? 'Judge recent chats' : 'Judge live'}</button>
            <button className="act sec" disabled={busy} onClick={() => run('live', true)} title="Re-score the live set with the current rubric — use after the judge/rubric changes">Re-judge live</button>
          </div>
        </div>
        {job?.running && <div className="eval-running">
          <span className="spinner" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>Running {job.mode}{job.kind ? ` · ${job.kind}` : ''} eval… {job.progress ? `${job.progress.done}/${job.progress.total}` : 'starting…'}</div>
            {job.progress?.label && <div className="muted" style={{ fontSize: '.8rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{job.progress.label}</div>}
            {job.progress && job.progress.total > 0 && <div className="eval-bar"><span style={{ width: `${Math.round(100 * job.progress.done / job.progress.total)}%` }} /></div>}
          </div>
        </div>}
        {job && !job.running && job.error && <div className="muted" style={{ color: '#b91c1c', marginTop: 8 }}>{job.error}</div>}
        {err && <div className="muted" style={{ color: '#b91c1c', marginTop: 8 }}>{err}</div>}
      </div>

      {allTime && allTime.n > 0 && <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div>
            <strong style={{ fontSize: '1.05rem' }}>Prompt suggestions</strong>
            <div className="muted" style={{ fontSize: '.82rem' }}>From the latest benchmark run under the current prompt, have the judge propose a targeted edit to the {tab === 'chat' ? 'chat' : tab === 'reading' ? 'reading-lesson' : 'page-generation'} system prompt.</div>
          </div>
          <button className="act" disabled={busy || suggBusy} onClick={suggest}>{suggBusy ? 'Analyzing…' : sugg ? 'Re-analyze' : 'Suggest a prompt update'}</button>
        </div>
        {suggMsg && <div style={{ marginTop: 10, color: '#16a34a' }}>{suggMsg}</div>}
        {sugg && sugg.state === 'no-run' && <div className="muted" style={{ marginTop: 10 }}>{sugg.summary}</div>}
        {sugg && sugg.state === 'stale' && <div style={{ marginTop: 10, color: '#92400e' }}>⚠ {sugg.summary}</div>}
        {sugg && sugg.state === 'ok' && <div style={{ marginTop: 12 }}>
          <p style={{ margin: '0 0 8px' }}>{sugg.summary}</p>
          {sugg.changed ? <>
            <div className="row" style={{ gap: 10, marginBottom: 10, alignItems: 'flex-start' }}>
              <ConfBadge c={sugg.confidence} />
              <span className="muted" style={{ fontSize: '.84rem', flex: 1 }}>{sugg.rationale}</span>
            </div>
            <div className="diff">
              {lineDiff(sugg.currentPrompt, sugg.revisedPrompt).map((d, i) => (
                <div key={i} className={`d-${d.type}`}>{(d.type === 'add' ? '+ ' : d.type === 'del' ? '− ' : '  ') + (d.text || ' ')}</div>
              ))}
            </div>
            <div className="row" style={{ gap: 8, marginTop: 10 }}>
              <button className="act" onClick={acceptSuggestion}>Accept &amp; save prompt</button>
              <button className="act sec" onClick={() => { setSugg(null); setSuggMsg(''); }}>Dismiss</button>
            </div>
          </> : <div className="muted"><ConfBadge c={sugg.confidence} /> No prompt change suggested. {sugg.rationale}</div>}
        </div>}
      </div>}

      {rows.length > 0 && <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <strong style={{ fontSize: '1.05rem' }}>{view === 'latest' ? 'Latest run' : 'All outputs'} · weakest first</strong>
          <div className="subnav">
            <button className={view === 'latest' ? 'on' : ''} disabled={!hasLatest} onClick={() => setTableView('latest')}>Latest run</button>
            <button className={view === 'all' ? 'on' : ''} onClick={() => setTableView('all')}>All</button>
          </div>
        </div>
        <table className="evaltable" style={{ width: '100%', marginTop: 10, borderCollapse: 'collapse' }}>
          <thead><tr style={{ textAlign: 'left' }}>
            <th>Overall</th><th>{isChat ? 'Prompt → reply' : 'Content'}</th>
            {dims.map(([k, label]) => <th key={k}>{label}</th>)}
            <th>Judge notes</th>{!isChat && <th></th>}
          </tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} style={{ borderTop: '1px solid #eef0f3' }}>
                <td style={{ fontSize: '1.15rem' }}><Score v={e.overall} /></td>
                <td style={{ maxWidth: 320 }}>
                  {isChat
                    ? <><div style={{ fontWeight: 600 }}>{e.label} <span className="muted" style={{ fontWeight: 400, fontSize: '.72rem' }}>· {e.target_id?.startsWith('q') ? 'suite' : 'live'}</span></div><div className="muted" style={{ fontSize: '.8rem' }}>“{e.response}”</div></>
                    : <><div style={{ fontWeight: 600 }}>{e.subject || e.label || e.title}</div>
                      <div className="muted" style={{ fontSize: '.74rem' }}>{e.reading_level || '—'}{e.method === 'vision' ? ' · 👁 vision' : ''}{e.safety_ok ? '' : ' · ⚠ safety'}</div></>}
                </td>
                {dims.map(([k]) => <td key={k}><Score v={e.scores[k] ?? null} /></td>)}
                <td style={{ maxWidth: 320 }}><div>{e.verdict}</div>
                  {e.issues?.length > 0 && <div className="muted" style={{ fontSize: '.78rem' }}>{e.issues.join(' · ')}</div>}</td>
                {!isChat && <td><a className="act sec" href={`/preview/${e.target_id}`} target="_blank" rel="noreferrer">View</a></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
    </>
  );
}

// A system-prompt editor with version history: every Save appends a restorable
// version (deduped server-side). Click a version to load it into the editor, then
// Save to apply it (which itself pushes a new history entry). onSave persists the
// live value; promptKey identifies the history series on the server.
const phWhen = (t: number) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function PromptEditor({ title, blurb, promptKey, initialValue, defaultValue, onSave }:
  { title: string; blurb: string; promptKey: string; initialValue: string; defaultValue: string; onSave: (v: string) => Promise<unknown> }) {
  const api = useAdmin();
  const [value, setValue] = useState(initialValue);
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [msg, setMsg] = useState('');
  const loadHistory = () => api.promptHistory(promptKey).then((r) => setVersions(r.versions)).catch(() => {});
  useEffect(() => { loadHistory(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [promptKey]);
  const save = async (v: string, label = 'Saved ✓') => { await onSave(v); setMsg(label); setTimeout(() => setMsg(''), 2500); loadHistory(); };
  // The live saved value is the newest version (or the loaded config value before any
  // save). Save is enabled only when the editor differs from it.
  const savedValue = versions[0]?.value ?? initialValue;
  const dirty = value !== savedValue;
  return (
    <div className="card">
      <h3 style={{ marginBottom: 6 }}>{title}</h3>
      <p className="muted" style={{ marginBottom: 10 }}>{blurb}</p>
      <div className="prompt-edit">
        <textarea value={value} onChange={(e) => setValue(e.target.value)} />
        <div className="prompt-history">
          <div className="ph-head">History</div>
          {versions.length ? versions.map((v) => (
            <button key={v.id} type="button" className={`ph-item${v.value === value ? ' on' : ''}`} onClick={() => setValue(v.value)} title="Load this version into the editor (then Save to apply)">
              <span className="ph-when">{phWhen(v.created_at)}</span>
              <span className="muted">{v.author}{v.note ? ` · ${v.note}` : ''}</span>
            </button>
          )) : <span className="muted" style={{ fontSize: '.8rem' }}>No saved versions yet.</span>}
        </div>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="act" disabled={!dirty} onClick={() => save(value)}>Save</button>
        <button className="act sec" disabled={savedValue === defaultValue} onClick={() => { setValue(defaultValue); save(defaultValue, 'Reset ✓'); }}>Reset to default</button>
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
  const [hz, setHz] = useState(''); const [gain, setGain] = useState('');
  const [loaded, setLoaded] = useState(false); const [msg, setMsg] = useState('');
  useEffect(() => { getAudioConfig().then((a) => { setHz(String(a.warmHz)); setGain(String(a.warmGain)); setLoaded(true); }); }, []);
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 2500); };
  const apply = async () => {
    const h = Number(hz), g = Number(gain);
    if (!Number.isFinite(h) || !Number.isFinite(g)) return;
    const r = await setAudioConfig(h, g); setHz(String(r.warmHz)); setGain(String(r.warmGain)); flash('Applied ✓');
  };
  return (
    <div className="card">
      <h3 style={{ marginBottom: 6 }}>Audio keepalive (anti-clipping)</h3>
      <p className="muted" style={{ marginBottom: 10 }}>
        On some hardware configurations, the speaker powers down during silence and clips the first ~200ms of each
        sound (it varies with the USB-audio adapter, audio HAT, or DAC you use). A continuous, inaudible high tone keeps
        it awake. Tune it, then <b>play a test sound</b> and listen at the kiosk for a clipped start — adjust until it's
        clean and silent. Set frequency to <code>0</code> to turn it off.
      </p>
      <div className="row" style={{ alignItems: 'flex-end', gap: 16 }}>
        <div><label>Frequency (Hz)</label>
          <input type="number" value={hz} onChange={(e) => setHz(e.target.value)} placeholder="20000" style={{ width: 120 }} />
          <div className="muted" style={{ fontSize: '.72rem', marginTop: 3 }}>High enough to be inaudible (18000–22000). 0 = off.</div></div>
        <div><label>Gain (0–1)</label>
          <input type="number" step="0.01" value={gain} onChange={(e) => setGain(e.target.value)} placeholder="0.05" style={{ width: 100 }} />
          <div className="muted" style={{ fontSize: '.72rem', marginTop: 3 }}>Louder holds it awake better; faint whine? lower it.</div></div>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="act" disabled={!loaded} onClick={apply}>Apply</button>
        <button className="act sec" onClick={() => { testAudio(); flash('▶ Test sound sent to the kiosk — listen there'); }}>Play test sound</button>
        <span className="muted">{msg}</span>
      </div>
    </div>
  );
}

type SettingsTab = 'general' | 'content' | 'kiosk' | 'prompts';
const SETTINGS_TABS: [SettingsTab, string][] = [['general', 'General'], ['content', 'Content'], ['kiosk', 'Kiosk & device'], ['prompts', 'AI prompts']];

// Familiar faces: a toggle + the Google-Photos-style review of face clusters the
// vision sidecar has grouped. The parent maps each cluster to a child (or ignores
// strangers). All face data is on-device; switching only happens from the idle screen.
function FaceThumbs({ thumbs }: { thumbs: string[] }) {
  const box = { width: 46, height: 46, borderRadius: 9, objectFit: 'cover' as const, border: '1px solid var(--card-border, #e3e7ee)' };
  if (!thumbs.length) return <div style={{ ...box, display: 'grid', placeItems: 'center', fontSize: '1.4rem', background: 'var(--btn-bg, #e9edf3)' }}>👤</div>;
  return <div className="row" style={{ gap: 4 }}>{thumbs.slice(0, 6).map((t, i) => <img key={i} src={t} alt="" style={box} />)}</div>;
}

export function Faces() {
  const api = useAdmin();
  const [data, setData] = useState<FacesResponse | null>(null);
  const load = () => api.faces().then(setData).catch(() => {});
  useEffect(() => { load(); }, [api]);
  if (!data) return <p className="muted">Loading…</p>;
  const kid = (id: string | null) => data.kids.find((k) => k.id === id);
  const toggle = async () => { await api.saveConfig({ facesEnabled: !data.enabled }); load(); };
  const assign = async (id: string, profileId: string) => { await api.assignFace(id, profileId); load(); };
  const act = async (id: string, a: 'ignore' | 'unassign' | 'delete') => { await api.faceCluster(id, a); load(); };
  const del = async (c: FaceCluster) => { if (!confirm('Delete this face group? The saved snapshots are removed.')) return; await act(c.id, 'delete'); };

  const pending = data.clusters.filter((c) => c.status === 'pending');
  const assigned = data.clusters.filter((c) => c.status === 'assigned');
  const ignored = data.clusters.filter((c) => c.status === 'ignored');

  const Card = ({ c }: { c: FaceCluster }) => (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <FaceThumbs thumbs={c.thumbs} />
          <div className="muted" style={{ marginTop: 6, fontSize: '.85rem' }}>{c.count} snapshot{c.count === 1 ? '' : 's'} · seen {when(c.updated_at)}</div>
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          {c.status === 'assigned'
            ? <div className="row" style={{ alignItems: 'center', gap: 8 }}>
                <span className="pill" style={{ background: kid(c.profileId)?.color || '#8b5cf6' }}>{kid(c.profileId)?.initials || '··'}</span>
                <b>{kid(c.profileId)?.name || 'Unknown child'}</b>
                <button className="act sec" onClick={() => act(c.id, 'unassign')}>Not them</button>
              </div>
            : <>
                <label>Who is this?</label>
                <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                  {data.kids.map((k) => (
                    <button key={k.id} className="chip" style={{ borderColor: k.color, color: k.color }} onClick={() => assign(c.id, k.id)}>{k.name}</button>
                  ))}
                  {!data.kids.length && <span className="muted">Add a child under Kids first.</span>}
                </div>
                <div className="row" style={{ marginTop: 10, gap: 8 }}>
                  <button className="act sec" onClick={() => act(c.id, 'ignore')}>Not a child / stranger</button>
                  <button className="act warn" onClick={() => del(c)}>Delete</button>
                </div>
              </>}
        </div>
      </div>
    </div>
  );

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div>
            <h3 style={{ marginBottom: 4 }}>Familiar faces</h3>
            <p className="muted" style={{ maxWidth: 640 }}>When on, the device recognizes who's standing in front of it and switches to that child's profile automatically — only from the idle screen, so it never interrupts someone mid-session. All face data stays on the device and never leaves it. Off by default.</p>
          </div>
          <button className={`chip ${data.enabled ? 'on' : ''}`} style={{ minWidth: 64 }} onClick={toggle}>{data.enabled ? 'On' : 'Off'}</button>
        </div>
      </div>

      {!data.clusters.length && (
        <div className="card"><p className="muted">No faces yet.{data.enabled ? ' Let the device watch for a little while — groups of faces it sees will appear here to label.' : ' Turn it on above and it will start grouping the faces it sees.'} (Needs the on-device camera + vision helper on the Pi.)</p></div>
      )}

      {assigned.length > 0 && <h4 className="muted" style={{ margin: '10px 4px 2px' }}>Mapped to a child</h4>}
      {assigned.map((c) => <Card key={c.id} c={c} />)}
      {pending.length > 0 && <h4 className="muted" style={{ margin: '14px 4px 2px' }}>New faces to label</h4>}
      {pending.map((c) => <Card key={c.id} c={c} />)}
      {ignored.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary className="muted">{ignored.length} ignored</summary>
          {ignored.map((c) => (
            <div className="card" key={c.id}><div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <FaceThumbs thumbs={c.thumbs} />
              <div className="row" style={{ gap: 8 }}><button className="act sec" onClick={() => act(c.id, 'unassign')}>Restore</button><button className="act warn" onClick={() => del(c)}>Delete</button></div>
            </div></div>
          ))}
        </details>
      )}
    </>
  );
}

export function Settings() {
  const api = useAdmin();
  const [c, setC] = useState<AdminConfig | null>(null);
  const [rich, setRich] = useState(''); const [cap, setCap] = useState('0'); const [richMsg, setRichMsg] = useState('');
  const [wake, setWake] = useState<{ enabled: boolean; phrase: string }>({ enabled: false, phrase: '' });
  const [wakeMsg, setWakeMsg] = useState('');
  const [kioskPin, setKioskPin] = useState(''); const [pinMsg, setPinMsg] = useState('');
  const [types, setTypes] = useState<ContentTypeManifest[]>([]);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [tab, setTab] = useState<SettingsTab>(() => (sessionStorage.getItem('imag_settings_tab') as SettingsTab) || 'general');
  const pickTab = (t: SettingsTab) => { setTab(t); sessionStorage.setItem('imag_settings_tab', t); };
  useEffect(() => { api.config().then((cfg) => { setC(cfg); setRich(cfg.richness.selected); setCap(String(cfg.richness.dailyCap || 0)); setWake({ enabled: cfg.wake.enabled, phrase: cfg.wake.phrase }); setKioskPin(cfg.kioskPin || '0000'); }).catch(() => {}); }, [api]);
  // Keep the cached config fresh after a prompt save, so the editor shows the current
  // text if the sub-tab is left and re-entered (which remounts the editors).
  const reloadConfig = () => api.config().then(setC).catch(() => {});
  useEffect(() => { api.contentTypes().then((d) => setTypes(d.types)).catch(() => {}); api.usage().then(setUsage).catch(() => {}); }, [api]);
  const toggleType = async (t: ContentTypeManifest) => { await api.setContentTypeEnabled(t.id, !t.enabled); setTypes((ts) => ts.map((x) => x.id === t.id ? { ...x, enabled: !x.enabled } : x)); };
  if (!c) return <p className="muted">Loading…</p>;
  const selTier = c.richness.tiers.find((t) => t.id === rich);
  return (
    <>
      <div className="subnav">
        {SETTINGS_TABS.map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => pickTab(id)}>{label}</button>
        ))}
      </div>

      {tab === 'general' && <>
      <div className="card">
        <h3 style={{ marginBottom: 6 }}>Generation</h3>
        <p className="muted">Currently: <b>{c.liveGeneration ? 'LIVE — using Claude' : 'MOCK — set ANTHROPIC_API_KEY to go live'}</b>. Per-task routing (edit in config.json):</p>
        {Object.entries(c.routing).map(([k, v]) => <div className="row" key={k}><span style={{ minWidth: 110, fontWeight: 600 }}>{k}</span><span className="muted">{v}</span></div>)}
      </div>
      <div className="card">
        <h3 style={{ marginBottom: 6 }}>API usage (estimated cost)</h3>
        <p className="muted" style={{ marginBottom: 10 }}>Estimated spend from generation, using the per-model prices in <code>config.json</code>. Estimates only — check your provider dashboard for exact billing.</p>
        {usage ? <>
          <div className="row" style={{ gap: 24, flexWrap: 'wrap' }}>
            {([['Today', 'today'], ['Last 7 days', 'week'], ['Last 30 days', 'month'], ['Lifetime', 'lifetime']] as const).map(([label, key]) => {
              const b = usage[key];
              return <div key={key} style={{ minWidth: 108 }}>
                <label>{label}</label>
                <div style={{ fontSize: '1.5rem', fontWeight: 800 }}>${b.cost.toFixed(2)}</div>
                <div className="muted" style={{ fontSize: '.8rem' }}>{b.n} call{b.n === 1 ? '' : 's'} · {Math.round((b.inTok + b.outTok) / 1000)}k tok</div>
              </div>;
            })}
          </div>
          {usage.byModelMonth.length > 0 && <div style={{ marginTop: 14 }}>
            <label>By model (last 30 days)</label>
            {usage.byModelMonth.map((m) => <div className="row" key={m.model || '?'}><span style={{ minWidth: 240 }}>{m.model || 'unknown'}</span><span className="muted">${m.cost.toFixed(2)} · {m.n} call{m.n === 1 ? '' : 's'}</span></div>)}
          </div>}
        </> : <p className="muted">No usage recorded yet (or running on the mock provider — mock generation is free).</p>}
      </div>
      </>}

      {tab === 'content' && <>
      <div className="card">
        <h3 style={{ marginBottom: 6 }}>Content richness</h3>
        <p className="muted" style={{ marginBottom: 10 }}>How rich and interactive the pages generated for your kids are. Richer tiers use a more capable model and a bigger token budget — better visuals, but slower and more costly per page. (Parents can override this per page when creating one.)</p>
        <div className="row" style={{ alignItems: 'flex-end', gap: 12 }}>
          <div><label>Default richness</label>
            <select value={rich} onChange={(e) => setRich(e.target.value)}>
              {c.richness.tiers.map((t) => <option key={t.id} value={t.id}>{t.label}{t.id === c.richness.default ? ' (default)' : ''}</option>)}
            </select></div>
        </div>
        {selTier && <p className="muted" style={{ marginTop: 8 }}>{selTier.description} <span style={{ opacity: 0.7 }}>· model: {selTier.provider}, up to {selTier.maxTokens.toLocaleString()} tokens/page</span></p>}
        <div className="row" style={{ marginTop: 14, alignItems: 'flex-end', gap: 12 }}>
          <div><label>Daily cap on kid-requested pages</label>
            <input type="number" min={0} value={cap} onChange={(e) => setCap(e.target.value)} style={{ width: 120 }} /></div>
          <span className="muted" style={{ flex: 1, minWidth: 220 }}>0 = unlimited. Past the cap, pages a child asks for that day drop to the simplest tier to control cost. Pages you create are never capped.</span>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="act" onClick={async () => { await api.saveConfig({ richness: rich, dailyCap: Number(cap) || 0 }); setRichMsg('Saved ✓'); }}>Save</button>
          <span className="muted">{richMsg}</span>
        </div>
      </div>
      <div className="card">
        <h3 style={{ marginBottom: 6 }}>Content types</h3>
        <p className="muted" style={{ marginBottom: 10 }}>Turn kinds of content on or off everywhere. The capability tags show what each type uses. Per-child controls are under Kids.</p>
        {types.map((t) => (
          <div className="row" key={t.id} style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
            <span>{t.emoji} <b>{t.label}</b> <span className="muted">· {t.renderer}{t.uses.mic ? ' · mic' : ''}{t.uses.media ? ' · media' : ''}</span></span>
            <button className={`chip ${t.enabled ? 'on' : ''}`} onClick={() => toggleType(t)}>{t.enabled ? 'On' : 'Off'}</button>
          </div>
        ))}
      </div>
      </>}

      {tab === 'kiosk' && <>
      <div className="card">
        <h3 style={{ marginBottom: 6 }}>Kiosk access PIN</h3>
        <p className="muted" style={{ marginBottom: 10 }}>On the kiosk, press and hold the avatar for 5 seconds to open a parent menu (Update &amp; Reload). This 4-digit PIN unlocks it. Low-stakes — it just keeps kids out of the maintenance menu. Default is <code>0000</code>.</p>
        <div><label>4-digit PIN</label>
          <input value={kioskPin} inputMode="numeric" maxLength={4} placeholder="0000"
            onChange={(e) => { setKioskPin(e.target.value.replace(/\D/g, '').slice(0, 4)); setPinMsg(''); }} style={{ display: 'block', width: 120, letterSpacing: '0.3em', fontSize: '1.1rem' }} /></div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="act" disabled={!/^\d{4}$/.test(kioskPin)}
            onClick={async () => { await api.saveConfig({ kioskPin }); setPinMsg('Saved ✓'); }}>Save</button>
          <span className="muted">{/^\d{4}$/.test(kioskPin) ? pinMsg : 'Enter exactly 4 digits'}</span>
        </div>
      </div>
      <div className="card">
        <h3 style={{ marginBottom: 6 }}>Wake word (hands-free)</h3>
        <p className="muted" style={{ marginBottom: 10 }}>Let kids start talking by saying a wake word — no tap needed. Runs <b>100% on the device</b>; audio never leaves the Pi. Requires the wake-word add-on installed on the Pi (re-run the installer and say yes). When off, kids tap the avatar to talk.</p>
        <div className="row" style={{ alignItems: 'flex-end', gap: 12 }}>
          <div><label>Wake word</label>
            <select value={wake.phrase} onChange={(e) => setWake((w) => ({ ...w, phrase: e.target.value }))}>
              {c.wake.phrases.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select></div>
          <button className={`chip ${wake.enabled ? 'on' : ''}`} onClick={() => setWake((w) => ({ ...w, enabled: !w.enabled }))}>{wake.enabled ? 'On' : 'Off'}</button>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="act" onClick={async () => { await api.saveConfig({ wake }); setWakeMsg('Saved ✓'); }}>Save</button>
          <span className="muted">{wakeMsg}</span>
        </div>
      </div>
      <AudioKeepalive />
      </>}

      {tab === 'prompts' && c && <>
        <PromptEditor title="Chat personality &amp; safety" promptKey="chat_system_prompt"
          blurb="How the avatar talks to your kids and handles tricky or inappropriate questions. Read aloud, so keep it spoken-style."
          initialValue={c.chatSystemPrompt} defaultValue={c.defaultChatSystemPrompt} onSave={async (v) => { await api.saveConfig({ chatSystemPrompt: v }); reloadConfig(); }} />
        <PromptEditor title="Page-generation system prompt" promptKey="artifact_system_prompt"
          blurb="The instructions that shape every interactive page generated for your kids."
          initialValue={c.systemPrompt} defaultValue={c.defaultSystemPrompt} onSave={async (v) => { await api.saveConfig({ systemPrompt: v }); reloadConfig(); }} />
        <PromptEditor title="Reading-lesson system prompt" promptKey="reading_system_prompt"
          blurb="Shapes the leveled read-along stories. It must keep emitting the strict JSON the Reader expects, so edit content/tone rather than the output format."
          initialValue={c.readingSystemPrompt} defaultValue={c.defaultReadingSystemPrompt} onSave={async (v) => { await api.saveConfig({ readingSystemPrompt: v }); reloadConfig(); }} />
      </>}
    </>
  );
}
