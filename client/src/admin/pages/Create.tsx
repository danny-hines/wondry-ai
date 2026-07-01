import { useEffect, useState } from 'react';
import { useAdmin } from '../AdminContext';
import type { Profile, ContentTypeManifest, RichnessTier } from '../../lib/types';

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
    api
      .contentTypes()
      .then((d) => {
        const t = d.types.filter((x) => x.authorable && x.enabled);
        setTypes(t);
        if (t[0]) setTypeId(t[0].id);
      })
      .catch(() => {});
    api
      .profiles()
      .then((d) => setKids(d.profiles))
      .catch(() => {});
    api
      .config()
      .then((cfg) => setRichTiers(cfg.richness.tiers))
      .catch(() => {});
  }, [api]);
  const type = types.find((t) => t.id === typeId);
  const setP = (k: string, v: string) => setParams((p) => ({ ...p, [k]: v }));
  const go = async () => {
    if (!typeId) return;
    setMsg('Generating…');
    const r = await api
      .createContent({
        typeId,
        params,
        profileId: kid || undefined,
        richness: richOverride || undefined,
      })
      .catch(() => null);
    setMsg(
      r?.ok
        ? 'Done! It will appear below — preview and publish it there.'
        : 'Error generating — is the server running?',
    );
    setParams({});
    if (r?.ok) onCreated?.();
  };
  return (
    <div className="card">
      <h3 style={{ marginBottom: 10 }}>Create content</h3>
      <p className="muted" style={{ marginBottom: 14 }}>
        Pick what to make. It's generated and held below for review — preview it, then publish to a
        child. Tailor it to a child to use their interests &amp; level.
      </p>
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', gap: 16 }}>
        <div>
          <label>Type</label>
          <select
            value={typeId}
            onChange={(e) => {
              setTypeId(e.target.value);
              setParams({});
              setMsg('');
            }}
          >
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.emoji} {t.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>For child (optional)</label>
          <select value={kid} onChange={(e) => setKid(e.target.value)}>
            <option value="">No specific child</option>
            {kids.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
        </div>
        {type?.renderer === 'sandbox-html' && richTiers.length > 0 && (
          <div>
            <label>Richness (this page)</label>
            <select value={richOverride} onChange={(e) => setRichOverride(e.target.value)}>
              <option value="">Use global setting</option>
              {richTiers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {type &&
        type.createForm.map((f) => (
          <div key={f.key} style={{ marginTop: 10 }}>
            <label>{f.label}</label>
            {f.type === 'textarea' ? (
              <textarea
                value={params[f.key] || ''}
                placeholder={f.placeholder}
                onChange={(e) => setP(f.key, e.target.value)}
              />
            ) : f.type === 'level' ? (
              <select
                value={params[f.key] || ''}
                onChange={(e) => setP(f.key, e.target.value)}
                style={{ width: '100%' }}
              >
                <option value="">Auto level</option>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    Level {n}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={params[f.key] || ''}
                placeholder={f.placeholder}
                onChange={(e) => setP(f.key, e.target.value)}
                style={{ width: '100%' }}
              />
            )}
          </div>
        ))}
      {type && type.triggersHelp && (
        <p className="muted" style={{ marginTop: 10 }}>
          Kids can also just ask — {type.triggersHelp}
        </p>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="act" onClick={go}>
          Generate
        </button>
        <span className="muted">{msg}</span>
      </div>
    </div>
  );
}
