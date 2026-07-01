import { rendererFor } from '../content/registry';
import { readableOn } from '../lib/contrast';
import type { Artifact, Profile } from '../lib/types';
import type { ContentRendererProps } from '../content/types';

export function PanelContent({
  splitMode,
  trayList,
  openGenerating,
  openId,
  openArt,
  user,
  speak,
  speakingId,
  setMood,
  onOpenTile,
}: {
  splitMode: 'artifact' | 'tray' | null;
  trayList: Artifact[];
  openGenerating: boolean;
  openId: string | null;
  openArt: Artifact | null;
  user: Profile | null;
  speak: ContentRendererProps['speak'];
  speakingId: ContentRendererProps['speakingId'];
  setMood: ContentRendererProps['setMood'];
  onOpenTile: (a: Artifact) => void;
}) {
  return (
    <div id="content">
      {splitMode === 'tray' ? (
        <div className="tray">
          {trayList.length ? (
            trayList.map((a) => (
              <button
                key={a.id}
                className="tile"
                style={{
                  background: a.color || '#8b5cf6',
                  color: readableOn(a.color || '#8b5cf6'),
                }}
                onClick={() => onOpenTile(a)}
              >
                {!a.seen && <span className="new">NEW</span>}
                <span className="te">{a.emoji || '✨'}</span>
                <span className="tt">{a.title}</span>
                <span className="src">
                  {a.source === 'parent'
                    ? '★ for you'
                    : a.source === 'proactive'
                      ? '✦ discovered'
                      : 'you asked'}
                </span>
              </button>
            ))
          ) : (
            <div className="empty">No pages yet. Ask me to build one!</div>
          )}
        </div>
      ) : openGenerating ? (
        <div className="tray">
          <div className="empty">
            ✨ {rendererFor(openArt?.type) ? 'Getting it ready…' : 'Making your page…'} hang tight!
          </div>
        </div>
      ) : openId ? (
        (() => {
          const R = rendererFor(openArt?.type);
          return R ? (
            <R
              artifactId={openId}
              profile={user}
              speak={speak}
              speakingId={speakingId}
              setMood={setMood}
            />
          ) : (
            <iframe
              sandbox="allow-scripts"
              src={`/api/artifact/${openId}?chrome=panel`}
              title="page"
            />
          );
        })()
      ) : null}
    </div>
  );
}
