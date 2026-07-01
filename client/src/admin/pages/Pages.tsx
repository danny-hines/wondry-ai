import { useEffect, useState } from 'react';
import { useAdmin } from '../AdminContext';
import { readableOn } from '../../lib/contrast';
import type { Profile, Artifact } from '../../lib/types';
import { when } from './common';

export function Pages({ refreshKey = 0 }: { refreshKey?: number } = {}) {
  const api = useAdmin();
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [kids, setKids] = useState<Profile[]>([]);
  const load = () =>
    api
      .artifacts()
      .then((d) => {
        setArtifacts(d.artifacts);
        setKids(d.kids);
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    load();
  }, [api, refreshKey]);
  // While anything is still generating, poll so it flips to ready (and shows its cost) without a manual refresh.
  useEffect(() => {
    if (!artifacts.some((a) => a.status === 'generating')) return;
    const t = setTimeout(load, 4000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifacts]);
  const toggle = async (a: Artifact, kid: Profile, on: boolean) => {
    await api.setAudience(a.id, kid.id, on);
    load();
  };
  const del = async (a: Artifact) => {
    if (!confirm(`Delete "${a.title}"? This permanently removes the page for everyone.`)) return;
    await api.deleteArtifact(a.id);
    load();
  };
  if (!artifacts.length)
    return (
      <p className="muted">
        No content yet. Generate one above, or have a child ask the avatar to build one.
      </p>
    );
  return (
    <>
      {artifacts.map((a) => (
        <div className="card" key={a.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <span style={{ fontSize: '1.4rem' }}>{a.emoji || '✨'}</span> <b>{a.title}</b>{' '}
              <span className={`tag ${a.status}`}>{a.status}</span>
              <div className="muted">
                {a.source} · {a.profile_name || 'unassigned'} · {when(a.created_at)}
                {a.cost ? ` · ~$${a.cost.toFixed(4)}` : ''}
                {a.error ? ' · ⚠ ' + a.error : ''}
              </div>
            </div>
            <div className="row">
              {a.status === 'ready' && (
                <a className="act sec" href={`/preview/${a.id}`} target="_blank" rel="noreferrer">
                  Preview
                </a>
              )}
              <button className="act warn" onClick={() => del(a)}>
                Delete
              </button>
            </div>
          </div>
          <div className="row" style={{ marginTop: 12, alignItems: 'center' }}>
            <span className="muted" style={{ minWidth: 70 }}>
              Publish to:
            </span>
            {kids.length ? (
              kids.map((k) => {
                const on = (a.audience || []).includes(k.id);
                return (
                  <button
                    key={k.id}
                    className={`chip ${on ? 'on' : ''}`}
                    title={on ? 'Published — click to unpublish' : 'Click to publish'}
                    style={
                      on
                        ? { background: k.color, borderColor: k.color, color: readableOn(k.color) }
                        : { borderColor: k.color, color: k.color }
                    }
                    onClick={() => toggle(a, k, !on)}
                  >
                    <span className="ind">{on ? '✓' : '+'}</span>
                    {k.name}
                  </button>
                );
              })
            ) : (
              <span className="muted">add a child under the Kids tab</span>
            )}
          </div>
        </div>
      ))}
    </>
  );
}
