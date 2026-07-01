import type { Artifact } from '../lib/types';

export function ArtifactCard({
  artifact,
  onOpen,
  onRetry,
}: {
  artifact: Artifact;
  onOpen: () => void;
  onRetry: () => void;
}) {
  const cls = artifact.status === 'ready' ? 'ready' : artifact.status === 'failed' ? 'failed' : '';
  const ready = artifact.status === 'ready';
  const failed = artifact.status === 'failed';
  return (
    <div
      className={`artcard ${cls}`}
      style={{ ['--est' as any]: '12s' }}
      onClick={() => (failed ? onRetry() : onOpen())}
    >
      <div className="fill" />
      <div className="inner">
        <div className="emoji">{artifact.emoji || '✨'}</div>
        <div className="meta">
          <div className="t">{artifact.title}</div>
          <div className="p">
            {failed
              ? "That one didn't work."
              : ready
                ? artifact.plan || 'Ready to explore!'
                : 'Making your page…'}
          </div>
        </div>
        <div className="go">{failed ? 'Try again ↻' : ready ? 'OPEN →' : '●●●'}</div>
      </div>
    </div>
  );
}
