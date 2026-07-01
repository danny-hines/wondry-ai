import { useEffect, useState } from 'react';
import { useAdmin } from '../AdminContext';
import type { PromptVersion } from '../../lib/types';
import { phWhen } from './common';

// A system-prompt editor with version history: every Save appends a restorable
// version (deduped server-side). Click a version to load it into the editor, then
// Save to apply it (which itself pushes a new history entry). onSave persists the
// live value; promptKey identifies the history series on the server.
export function PromptEditor({
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
