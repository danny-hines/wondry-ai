import { useEffect, useState } from 'react';
import { useAdmin } from '../AdminContext';
import type { FacesResponse, FaceCluster } from '../../lib/types';
import { when } from './common';

// Familiar faces: a toggle + the Google-Photos-style review of face clusters the
// vision sidecar has grouped. The parent maps each cluster to a child (or ignores
// strangers). All face data is on-device; switching only happens from the idle screen.
function FaceThumbs({ thumbs }: { thumbs: string[] }) {
  const box = {
    width: 46,
    height: 46,
    borderRadius: 9,
    objectFit: 'cover' as const,
    border: '1px solid var(--card-border, #e3e7ee)',
  };
  if (!thumbs.length)
    return (
      <div
        style={{
          ...box,
          display: 'grid',
          placeItems: 'center',
          fontSize: '1.4rem',
          background: 'var(--btn-bg, #e9edf3)',
        }}
      >
        👤
      </div>
    );
  return (
    <div className="row" style={{ gap: 4 }}>
      {thumbs.slice(0, 6).map((t, i) => (
        <img key={i} src={t} alt="" style={box} />
      ))}
    </div>
  );
}

export function Faces() {
  const api = useAdmin();
  const [data, setData] = useState<FacesResponse | null>(null);
  const load = () =>
    api
      .faces()
      .then(setData)
      .catch(() => {});
  useEffect(() => {
    load();
  }, [api]);
  if (!data) return <p className="muted">Loading…</p>;
  const kid = (id: string | null) => data.kids.find((k) => k.id === id);
  const toggle = async () => {
    await api.saveConfig({ facesEnabled: !data.enabled });
    load();
  };
  const assign = async (id: string, profileId: string) => {
    await api.assignFace(id, profileId);
    load();
  };
  const act = async (id: string, a: 'ignore' | 'unassign' | 'delete') => {
    await api.faceCluster(id, a);
    load();
  };
  const del = async (c: FaceCluster) => {
    if (!confirm('Delete this face group? The saved snapshots are removed.')) return;
    await act(c.id, 'delete');
  };

  const pending = data.clusters.filter((c) => c.status === 'pending');
  const assigned = data.clusters.filter((c) => c.status === 'assigned');
  const ignored = data.clusters.filter((c) => c.status === 'ignored');

  const Card = ({ c }: { c: FaceCluster }) => (
    <div className="card">
      <div
        className="row"
        style={{
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <FaceThumbs thumbs={c.thumbs} />
          <div className="muted" style={{ marginTop: 6, fontSize: '.85rem' }}>
            {c.count} snapshot{c.count === 1 ? '' : 's'} · seen {when(c.updated_at)}
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          {c.status === 'assigned' ? (
            <div className="row" style={{ alignItems: 'center', gap: 8 }}>
              <span className="pill" style={{ background: kid(c.profileId)?.color || '#8b5cf6' }}>
                {kid(c.profileId)?.initials || '··'}
              </span>
              <b>{kid(c.profileId)?.name || 'Unknown child'}</b>
              <button className="act sec" onClick={() => act(c.id, 'unassign')}>
                Not them
              </button>
            </div>
          ) : (
            <>
              <label>Who is this?</label>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                {data.kids.map((k) => (
                  <button
                    key={k.id}
                    className="chip"
                    style={{ borderColor: k.color, color: k.color }}
                    onClick={() => assign(c.id, k.id)}
                  >
                    {k.name}
                  </button>
                ))}
                {!data.kids.length && <span className="muted">Add a child under Kids first.</span>}
              </div>
              <div className="row" style={{ marginTop: 10, gap: 8 }}>
                <button className="act sec" onClick={() => act(c.id, 'ignore')}>
                  Not a child / stranger
                </button>
                <button className="act warn" onClick={() => del(c)}>
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <>
      <div className="card">
        <div
          className="row"
          style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12 }}
        >
          <div>
            <h3 style={{ marginBottom: 4 }}>Familiar faces</h3>
            <p className="muted" style={{ maxWidth: 640 }}>
              When on, the device recognizes who's standing in front of it and switches to that
              child's profile automatically — only from the idle screen, so it never interrupts
              someone mid-session. All face data stays on the device and never leaves it. Off by
              default.
            </p>
          </div>
          <button
            className={`chip ${data.enabled ? 'on' : ''}`}
            style={{ minWidth: 64 }}
            onClick={toggle}
          >
            {data.enabled ? 'On' : 'Off'}
          </button>
        </div>
      </div>

      {!data.clusters.length && (
        <div className="card">
          <p className="muted">
            No faces yet.
            {data.enabled
              ? ' Let the device watch for a little while — groups of faces it sees will appear here to label.'
              : ' Turn it on above and it will start grouping the faces it sees.'}{' '}
            (Needs the on-device camera + vision helper on the Pi.)
          </p>
        </div>
      )}

      {assigned.length > 0 && (
        <h4 className="muted" style={{ margin: '10px 4px 2px' }}>
          Mapped to a child
        </h4>
      )}
      {assigned.map((c) => (
        <Card key={c.id} c={c} />
      ))}
      {pending.length > 0 && (
        <h4 className="muted" style={{ margin: '14px 4px 2px' }}>
          New faces to label
        </h4>
      )}
      {pending.map((c) => (
        <Card key={c.id} c={c} />
      ))}
      {ignored.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary className="muted">{ignored.length} ignored</summary>
          {ignored.map((c) => (
            <div className="card" key={c.id}>
              <div
                className="row"
                style={{ justifyContent: 'space-between', alignItems: 'center' }}
              >
                <FaceThumbs thumbs={c.thumbs} />
                <div className="row" style={{ gap: 8 }}>
                  <button className="act sec" onClick={() => act(c.id, 'unassign')}>
                    Restore
                  </button>
                  <button className="act warn" onClick={() => del(c)}>
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </details>
      )}
    </>
  );
}
