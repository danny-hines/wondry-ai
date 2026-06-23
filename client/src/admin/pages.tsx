import { useEffect, useRef, useState } from 'react';
import { useAdmin } from './AdminContext';
import { getVoices } from '../lib/api';
import { readableOn } from '../lib/contrast';
import { Avatar } from '../kiosk/Avatar';
import type { AvatarEngine } from '../kiosk/avatarEngine';
import { useSpeech } from '../kiosk/useSpeech';
import type { Profile, Artifact, AdminConfig, LogMessage, SafetyEntry, ReadingReportRow, ContentTypeManifest, RichnessTier, UsageReport } from '../lib/types';

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
  const [types, setTypes] = useState<ContentTypeManifest[]>([]);
  const [np, setNp] = useState({ name: '', age: '', reading_level: '', color: '#8b5cf6' });
  const load = () => api.profiles().then((d) => setProfiles(d.profiles)).catch(() => {});
  useEffect(() => { load(); getVoices().then((v) => setVoices(v.voices)); api.contentTypes().then((d) => setTypes(d.types)).catch(() => {}); }, [api]);
  const setField = (id: string, f: keyof Profile, v: any) => setProfiles((ps) => ps.map((p) => p.id === id ? { ...p, [f]: v } : p));
  const disabledSet = (p: Profile) => new Set((p.disabled_types || '').split(',').map((s) => s.trim()).filter(Boolean));
  const toggleType = (p: Profile, id: string) => { const s = disabledSet(p); s.has(id) ? s.delete(id) : s.add(id); setField(p.id, 'disabled_types', [...s].join(',')); };
  const save = async (p: Profile) => { await api.saveProfile({ id: p.id, name: p.name, initials: p.initials, color: p.color, age: p.age, reading_level: p.reading_level, voice: p.voice, persona: p.persona, theme: p.theme === 'dark' ? 'dark' : 'light', interests: p.interests, disabledTypes: [...disabledSet(p)] }); };
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
            <div><label>Voice (Piper)</label>
              <select value={p.voice ?? ''} onChange={(e) => setField(p.id, 'voice', e.target.value)} style={{ width: '100%' }}>
                <option value="">{voices.length ? '(default voice)' : 'run: npm run setup-piper'}</option>
                {voices.map((v) => <option key={v} value={v}>{v}</option>)}
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
          <div className="row" style={{ marginTop: 12 }}>
            <button className="act" onClick={() => save(p)}>Save</button>
            <button className="act warn" onClick={() => remove(p)}>Remove child</button>
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

export function Settings() {
  const api = useAdmin();
  const [c, setC] = useState<AdminConfig | null>(null);
  const [cp, setCp] = useState(''); const [sp, setSp] = useState(''); const [rp, setRp] = useState('');
  const [cpMsg, setCpMsg] = useState(''); const [spMsg, setSpMsg] = useState(''); const [rpMsg, setRpMsg] = useState('');
  const [rich, setRich] = useState(''); const [cap, setCap] = useState('0'); const [richMsg, setRichMsg] = useState('');
  const [types, setTypes] = useState<ContentTypeManifest[]>([]);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  useEffect(() => { api.config().then((cfg) => { setC(cfg); setCp(cfg.chatSystemPrompt); setSp(cfg.systemPrompt); setRp(cfg.readingSystemPrompt); setRich(cfg.richness.selected); setCap(String(cfg.richness.dailyCap || 0)); }).catch(() => {}); }, [api]);
  useEffect(() => { api.contentTypes().then((d) => setTypes(d.types)).catch(() => {}); api.usage().then(setUsage).catch(() => {}); }, [api]);
  const toggleType = async (t: ContentTypeManifest) => { await api.setContentTypeEnabled(t.id, !t.enabled); setTypes((ts) => ts.map((x) => x.id === t.id ? { ...x, enabled: !x.enabled } : x)); };
  if (!c) return <p className="muted">Loading…</p>;
  const selTier = c.richness.tiers.find((t) => t.id === rich);
  return (
    <>
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
      <div className="card">
        <h3 style={{ marginBottom: 6 }}>Chat personality &amp; safety</h3>
        <p className="muted" style={{ marginBottom: 10 }}>How the avatar talks to your kids and handles tricky or inappropriate questions. Read aloud, so keep it spoken-style.</p>
        <textarea value={cp} onChange={(e) => setCp(e.target.value)} />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="act" onClick={async () => { await api.saveConfig({ chatSystemPrompt: cp }); setCpMsg('Saved ✓'); }}>Save</button>
          <button className="act sec" onClick={async () => { setCp(c.defaultChatSystemPrompt); await api.saveConfig({ chatSystemPrompt: c.defaultChatSystemPrompt }); setCpMsg('Reset ✓'); }}>Reset to default</button>
          <span className="muted">{cpMsg}</span>
        </div>
      </div>
      <div className="card">
        <h3 style={{ marginBottom: 6 }}>Page-generation system prompt</h3>
        <p className="muted" style={{ marginBottom: 10 }}>The instructions that shape every interactive page generated for your kids.</p>
        <textarea value={sp} onChange={(e) => setSp(e.target.value)} />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="act" onClick={async () => { await api.saveConfig({ systemPrompt: sp }); setSpMsg('Saved ✓'); }}>Save</button>
          <button className="act sec" onClick={async () => { setSp(c.defaultSystemPrompt); await api.saveConfig({ systemPrompt: c.defaultSystemPrompt }); setSpMsg('Reset ✓'); }}>Reset to default</button>
          <span className="muted">{spMsg}</span>
        </div>
      </div>
      <div className="card">
        <h3 style={{ marginBottom: 6 }}>Reading-lesson system prompt</h3>
        <p className="muted" style={{ marginBottom: 10 }}>Shapes the leveled read-along stories. It must keep emitting the strict JSON the Reader expects, so edit content/tone rather than the output format.</p>
        <textarea value={rp} onChange={(e) => setRp(e.target.value)} />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="act" onClick={async () => { await api.saveConfig({ readingSystemPrompt: rp }); setRpMsg('Saved ✓'); }}>Save</button>
          <button className="act sec" onClick={async () => { setRp(c.defaultReadingSystemPrompt); await api.saveConfig({ readingSystemPrompt: c.defaultReadingSystemPrompt }); setRpMsg('Reset ✓'); }}>Reset to default</button>
          <span className="muted">{rpMsg}</span>
        </div>
      </div>
    </>
  );
}
