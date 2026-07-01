import { useEffect, useRef, useState } from 'react';
import { useAdmin } from '../AdminContext';
import { getVoices } from '../../lib/api';
import { readableOn } from '../../lib/contrast';
import { Avatar } from '../../kiosk/Avatar';
import type { AvatarEngine } from '../../kiosk/avatarEngine';
import { useSpeech } from '../../kiosk/useSpeech';
import type { Profile, ContentTypeManifest } from '../../lib/types';

// Canonical reading levels offered in the Kids editor. Stored as free text and
// interpolated into generation/chat prompts, so these strings are the source of truth.
const READING_LEVELS = [
  'pre-reader',
  'early reader',
  'developing reader',
  'fluent reader',
  'advanced reader',
];

// A live, themed mini-kiosk for one child: the real avatar engine + static
// conversation bubbles in the child's accent + light/dark theme. "Hear voice"
// speaks a line through the selected (possibly unsaved) Piper voice and drives
// the avatar's mouth, falling back to browser speech if Piper isn't installed.
function KidPreview({
  name,
  color,
  theme,
  voice,
}: {
  name: string;
  color: string;
  theme: 'light' | 'dark';
  voice?: string | null;
}) {
  const avatarRef = useRef<AvatarEngine | null>(null);
  const { speak, speakingId } = useSpeech(avatarRef);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    avatarRef.current?.setColor(color);
  }, [color]);
  const hear = async () => {
    setBusy(true);
    avatarRef.current?.setColor(color);
    await speak(
      `Hi ${name || 'friend'}! Want to learn something fun today?`,
      undefined,
      'kp',
      voice || undefined,
    );
    setBusy(false);
  };
  return (
    <div
      className={`kid-preview${theme === 'dark' ? ' theme-dark' : ''}`}
      style={{ ['--user' as any]: color, ['--user-fg' as any]: readableOn(color) }}
    >
      <div className="kp-stage">
        <div className="kp-avatar">
          <Avatar ref={avatarRef} />
        </div>
        <div className="kp-bubbles">
          <div className="kp-bubble kid">Why is the sky blue?</div>
          <div className={`kp-bubble avatar${speakingId === 'kp' ? ' speaking' : ''}`}>
            Great question! Sunlight bounces off tiny bits in the air, and blue scatters the most.
            ☀️💙
          </div>
        </div>
      </div>
      <div className="kp-foot">
        <button className="act sec" onClick={hear} disabled={busy}>
          {busy ? 'Speaking…' : '▶ Hear voice'}
        </button>
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
  const load = () =>
    api
      .profiles()
      .then((d) => setProfiles(d.profiles))
      .catch(() => {});
  useEffect(() => {
    load();
    getVoices().then((v) => {
      setVoices(v.voices);
      setBrowserVoice(v.browserVoice ?? null);
    });
    api
      .contentTypes()
      .then((d) => setTypes(d.types))
      .catch(() => {});
  }, [api]);
  const setField = (id: string, f: keyof Profile, v: any) =>
    setProfiles((ps) => ps.map((p) => (p.id === id ? { ...p, [f]: v } : p)));
  const disabledSet = (p: Profile) =>
    new Set(
      (p.disabled_types || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  const toggleType = (p: Profile, id: string) => {
    const s = disabledSet(p);
    s.has(id) ? s.delete(id) : s.add(id);
    setField(p.id, 'disabled_types', [...s].join(','));
  };
  const save = async (p: Profile) => {
    setSavingId(p.id);
    setSavedId(null);
    try {
      await api.saveProfile({
        id: p.id,
        name: p.name,
        initials: p.initials,
        color: p.color,
        age: p.age,
        reading_level: p.reading_level,
        voice: p.voice,
        persona: p.persona,
        theme: p.theme === 'dark' ? 'dark' : 'light',
        interests: p.interests,
        disabledTypes: [...disabledSet(p)],
      });
      setSavedId(p.id);
      setTimeout(() => setSavedId((s) => (s === p.id ? null : s)), 2500);
    } finally {
      setSavingId((s) => (s === p.id ? null : s));
    }
  };
  const remove = async (p: Profile) => {
    if (
      !confirm(
        `Remove ${p.name}? This deletes their conversation history and activity. Pages they created are kept (unassigned). This can't be undone.`,
      )
    )
      return;
    await api.deleteProfile(p.id);
    load();
  };
  const add = async () => {
    if (!np.name) return;
    await api.saveProfile({
      name: np.name,
      age: Number(np.age) || null,
      reading_level: np.reading_level,
      color: np.color,
    });
    setNp({ name: '', age: '', reading_level: '', color: '#8b5cf6' });
    load();
  };
  return (
    <>
      {profiles.map((p) => (
        <div className="card" key={p.id}>
          <div className="grid">
            <div>
              <label>Name</label>
              <input
                value={p.name}
                onChange={(e) => setField(p.id, 'name', e.target.value)}
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <label>Initials</label>
              <input
                value={p.initials}
                onChange={(e) => setField(p.id, 'initials', e.target.value)}
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <label>Age</label>
              <input
                type="number"
                value={p.age ?? ''}
                onChange={(e) => setField(p.id, 'age', Number(e.target.value) || null)}
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <label>Reading level</label>
              <select
                value={p.reading_level ?? ''}
                onChange={(e) => setField(p.id, 'reading_level', e.target.value || null)}
                style={{ width: '100%' }}
              >
                <option value="">(not set)</option>
                {READING_LEVELS.map((rl) => (
                  <option key={rl} value={rl}>
                    {rl}
                  </option>
                ))}
                {p.reading_level && !READING_LEVELS.includes(p.reading_level) && (
                  <option value={p.reading_level}>{p.reading_level}</option>
                )}
              </select>
            </div>
            <div>
              <label>Voice</label>
              <select
                value={p.voice ?? ''}
                onChange={(e) => setField(p.id, 'voice', e.target.value)}
                style={{ width: '100%' }}
              >
                <option value="">
                  {voices.length ? '(default voice)' : 'run: npm run setup-piper'}
                </option>
                {browserVoice && (
                  <option value={browserVoice}>🤖 Robot (on-device, fastest)</option>
                )}
                {voices.some((v) => !v.startsWith('kokoro:')) && (
                  <optgroup label="Piper">
                    {voices
                      .filter((v) => !v.startsWith('kokoro:'))
                      .map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                  </optgroup>
                )}
                {voices.some((v) => v.startsWith('kokoro:')) && (
                  <optgroup label="Kokoro (more natural)">
                    {voices
                      .filter((v) => v.startsWith('kokoro:'))
                      .map((v) => (
                        <option key={v} value={v}>
                          {v.slice(7)}
                        </option>
                      ))}
                  </optgroup>
                )}
              </select>
            </div>
            <div>
              <label>Assistant personality (future)</label>
              <input
                value={p.persona ?? ''}
                onChange={(e) => setField(p.id, 'persona', e.target.value)}
                placeholder="e.g. playful and patient"
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <label>Interests (themes reading stories)</label>
              <input
                value={p.interests ?? ''}
                onChange={(e) => setField(p.id, 'interests', e.target.value)}
                placeholder="dinosaurs, space, Minecraft"
                style={{ width: '100%' }}
              />
            </div>
          </div>
          <div className="row" style={{ marginTop: 12, alignItems: 'flex-end', gap: 22 }}>
            <div>
              <label>Color</label>
              <input
                type="color"
                value={p.color}
                onChange={(e) => setField(p.id, 'color', e.target.value)}
              />
            </div>
            <div>
              <label>Appearance</label>
              <div className="seg">
                <button
                  type="button"
                  className={p.theme !== 'dark' ? 'on' : ''}
                  onClick={() => setField(p.id, 'theme', 'light')}
                >
                  ☀ Light
                </button>
                <button
                  type="button"
                  className={p.theme === 'dark' ? 'on' : ''}
                  onClick={() => setField(p.id, 'theme', 'dark')}
                >
                  🌙 Dark
                </button>
              </div>
            </div>
          </div>
          {types.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <label>Activities for {p.name || 'this child'}</label>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                {types.map((t) => {
                  const on = t.enabled && !disabledSet(p).has(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className={`chip ${on ? 'on' : ''}`}
                      title={
                        !t.enabled
                          ? 'Turned off globally in Settings'
                          : on
                            ? 'On — click to turn off for this child'
                            : 'Off for this child — click to turn on'
                      }
                      disabled={!t.enabled}
                      style={
                        on
                          ? {
                              background: p.color,
                              borderColor: p.color,
                              color: readableOn(p.color),
                            }
                          : {}
                      }
                      onClick={() => toggleType(p, t.id)}
                    >
                      <span className="ind">{on ? '✓' : '·'}</span>
                      {t.emoji} {t.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <KidPreview
            name={p.name}
            color={p.color}
            theme={p.theme === 'dark' ? 'dark' : 'light'}
            voice={p.voice}
          />
          <div className="row" style={{ marginTop: 12, alignItems: 'center' }}>
            <button className="act" disabled={savingId === p.id} onClick={() => save(p)}>
              {savingId === p.id ? 'Saving…' : 'Save'}
            </button>
            <button className="act warn" onClick={() => remove(p)}>
              Remove child
            </button>
            {savedId === p.id && <span className="muted">Saved ✓</span>}
          </div>
        </div>
      ))}
      <div className="card">
        <h3 style={{ marginBottom: 10 }}>Add a child</h3>
        <div className="row">
          <input
            placeholder="Name"
            value={np.name}
            onChange={(e) => setNp({ ...np, name: e.target.value })}
          />
          <input
            type="number"
            placeholder="Age"
            style={{ width: 90 }}
            value={np.age}
            onChange={(e) => setNp({ ...np, age: e.target.value })}
          />
          <select
            value={np.reading_level}
            onChange={(e) => setNp({ ...np, reading_level: e.target.value })}
          >
            <option value="">Reading level…</option>
            {READING_LEVELS.map((rl) => (
              <option key={rl} value={rl}>
                {rl}
              </option>
            ))}
          </select>
          <input
            type="color"
            value={np.color}
            onChange={(e) => setNp({ ...np, color: e.target.value })}
          />
          <button className="act" onClick={add}>
            Add
          </button>
        </div>
      </div>
    </>
  );
}
