import { useEffect, useState } from 'react';
import { useAdmin } from '../AdminContext';
import type { LogMessage, SafetyEntry } from '../../lib/types';
import { when } from './common';

export function Log() {
  const api = useAdmin();
  const [messages, setMessages] = useState<LogMessage[]>([]);
  const [safety, setSafety] = useState<SafetyEntry[]>([]);
  useEffect(() => {
    api
      .log()
      .then((d) => {
        setMessages(d.messages);
        setSafety(d.safety);
      })
      .catch(() => {});
  }, [api]);
  const flags = safety.filter((s) => s.verdict === 'block');
  return (
    <>
      {flags.length > 0 && (
        <div className="card" style={{ borderColor: '#fca5a5' }}>
          <b>⚠ {flags.length} blocked input(s)</b>
          {flags.slice(0, 5).map((f) => (
            <div key={f.id} className="muted">
              {f.reason} — “{f.sample}” · {when(f.created_at)}
            </div>
          ))}
        </div>
      )}
      <div className="card">
        <h3 style={{ marginBottom: 8 }}>Recent activity</h3>
        {messages.length === 0 && <p className="muted">No activity yet.</p>}
        {messages.map((m) => (
          <div className="msg" key={m.id}>
            <span className="who">
              <span className="pill" style={{ background: m.color }}>
                {m.initials}
              </span>
            </span>
            <span className={`role-${m.role}`} style={{ minWidth: 60, fontWeight: 700 }}>
              {m.role}
            </span>
            <span style={{ flex: 1 }}>
              {m.kind === 'artifact' ? '🧩 ' : ''}
              {m.text}
              {m.artifact_title ? <span className="muted"> (→ {m.artifact_title})</span> : null}
              {m.safety_flag ? <span className="flag"> ⚠ flagged</span> : null}
            </span>
            <span className="muted">{when(m.created_at)}</span>
          </div>
        ))}
      </div>
    </>
  );
}
