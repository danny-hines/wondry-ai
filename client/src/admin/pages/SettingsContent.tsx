import { useEffect, useState } from 'react';
import { useAdmin } from '../AdminContext';
import type { AdminConfig, ContentTypeManifest } from '../../lib/types';

export function SettingsContent({ config }: { config: AdminConfig }) {
  const api = useAdmin();
  const [rich, setRich] = useState(config.richness.selected);
  const [cap, setCap] = useState(String(config.richness.dailyCap || 0));
  const [richMsg, setRichMsg] = useState('');
  const [types, setTypes] = useState<ContentTypeManifest[]>([]);
  useEffect(() => {
    api
      .contentTypes()
      .then((d) => setTypes(d.types))
      .catch(() => {});
  }, [api]);
  const toggleType = async (t: ContentTypeManifest) => {
    await api.setContentTypeEnabled(t.id, !t.enabled);
    setTypes((ts) => ts.map((x) => (x.id === t.id ? { ...x, enabled: !x.enabled } : x)));
  };
  const selTier = config.richness.tiers.find((t) => t.id === rich);
  return (
    <>
      <div className="card">
        <h3 style={{ marginBottom: 6 }}>Content richness</h3>
        <p className="muted" style={{ marginBottom: 10 }}>
          How rich and interactive the pages generated for your kids are. Richer tiers use a more
          capable model and a bigger token budget — better visuals, but slower and more costly per
          page. (Parents can override this per page when creating one.)
        </p>
        <div className="row" style={{ alignItems: 'flex-end', gap: 12 }}>
          <div>
            <label>Default richness</label>
            <select value={rich} onChange={(e) => setRich(e.target.value)}>
              {config.richness.tiers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                  {t.id === config.richness.default ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
        {selTier && (
          <p className="muted" style={{ marginTop: 8 }}>
            {selTier.description}{' '}
            <span style={{ opacity: 0.7 }}>
              · model: {selTier.provider}, up to {selTier.maxTokens.toLocaleString()} tokens/page
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
            0 = unlimited. Past the cap, pages a child asks for that day drop to the simplest tier
            to control cost. Pages you create are never capped.
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
          Turn kinds of content on or off everywhere. The capability tags show what each type uses.
          Per-child controls are under Kids.
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
  );
}
