import type { RefObject } from 'react';
import { mdToHtml } from '../lib/markdown';
import { maskProfanity } from '../lib/profanity';
import { ArtifactCard } from './ArtifactCard';
import type { Item, Reveal } from './types';
import type { Artifact } from '../lib/types';

export function ConversationBubbles({
  bubblesRef,
  items,
  reveal,
  speakingId,
  onReplay,
  onOpenArtifact,
  onRetry,
}: {
  bubblesRef: RefObject<HTMLDivElement>;
  items: Item[];
  reveal: Reveal | null;
  speakingId: string | null;
  onReplay: (key: string, text: string) => void;
  onOpenArtifact: (a: Artifact) => void;
  onRetry: (a: Artifact) => void;
}) {
  return (
    <div id="bubbles" ref={bubblesRef}>
      {items.map((it) =>
        it.kind === 'bubble' ? (
          it.role === 'avatar' ? (
            (() => {
              const rv = reveal && reveal.key === it.key ? reveal : null;
              const safe = maskProfanity(it.text); // final render gate
              const html = rv?.pending
                ? '<span class="speak-dots">…</span>'
                : rv
                  ? mdToHtml(safe.split(/\s+/).slice(0, rv.shown).join(' '))
                  : mdToHtml(safe);
              return (
                <div
                  key={it.key}
                  className={`bubble avatar${it.key === speakingId ? ' speaking' : ''}`}
                  title="Tap to hear again"
                  onClick={() => onReplay(it.key, it.text)}
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              );
            })()
          ) : (
            <div key={it.key} className="bubble kid">
              {maskProfanity(it.text)}
            </div>
          )
        ) : (
          <ArtifactCard
            key={it.key}
            artifact={it.artifact}
            onOpen={() => onOpenArtifact(it.artifact)}
            onRetry={() => onRetry(it.artifact)}
          />
        ),
      )}
    </div>
  );
}
