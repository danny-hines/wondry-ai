// Native memory matching game (the native-app stratum: real interaction logic in
// a hand-built component, fed by a generated JSON deck). Flip two cards; matching
// pairs stay up and the avatar names them. Win when all pairs are found.
import { useEffect, useRef, useState } from 'react';
import type { MemoryGameContent } from '../lib/types';
import { getContent, markEngagement, postContentEvent } from '../lib/api';
import type { ContentRendererProps } from './types';

interface Card { key: string; pair: number; emoji: string; label: string }

function shuffle<T>(a: T[]): T[] {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; }
  return r;
}
function buildCards(pairs: { emoji: string; label: string }[]): Card[] {
  return shuffle(pairs.flatMap((p, i) => [
    { key: `${i}a`, pair: i, emoji: p.emoji, label: p.label },
    { key: `${i}b`, pair: i, emoji: p.emoji, label: p.label },
  ]));
}

export default function MemoryGame({ artifactId, profile, speak, setMood }: ContentRendererProps) {
  const [game, setGame] = useState<MemoryGameContent | null>(null);
  const [err, setErr] = useState(false);
  const [cards, setCards] = useState<Card[]>([]);
  const [flipped, setFlipped] = useState<number[]>([]);     // indices currently face up (max 2)
  const [matched, setMatched] = useState<Set<number>>(new Set());
  const [moves, setMoves] = useState(0);
  const [won, setWon] = useState(false);
  const finishedRef = useRef(false);
  const pid = profile?.id;
  const voice = profile?.voice || undefined;
  const say = (t: string) => speak(t, pid, 'mem', voice);

  useEffect(() => {
    let live = true;
    getContent<MemoryGameContent>(artifactId).then((g) => { if (live) { setGame(g); setCards(buildCards(g.pairs)); } }).catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, [artifactId]);
  useEffect(() => { setMood('idle'); }, [setMood]);

  const reset = () => { if (game) { setCards(buildCards(game.pairs)); setFlipped([]); setMatched(new Set()); setMoves(0); setWon(false); finishedRef.current = false; } };

  const click = (idx: number) => {
    if (won || flipped.length === 2) return;
    const card = cards[idx];
    if (!card || matched.has(card.pair) || flipped.includes(idx)) return;
    const next = [...flipped, idx];
    setFlipped(next);
    if (next.length !== 2) return;

    const moveCount = moves + 1;
    setMoves(moveCount);
    const [a, b] = next;
    if (cards[a].pair === cards[b].pair) {
      const pair = cards[a].pair;
      say(cards[a].label);
      setTimeout(() => {
        setMatched((m) => {
          const nm = new Set(m); nm.add(pair);
          if (game && nm.size === game.pairs.length) {
            setWon(true);
            const score = Math.max(0, Math.min(1, game.pairs.length / moveCount));
            if (pid && !finishedRef.current) { finishedRef.current = true; markEngagement(artifactId, 'finished', pid); postContentEvent(artifactId, pid, { moves: moveCount, pairs: game.pairs.length, score }); }
            say(`You found them all${profile?.name ? ', ' + profile.name : ''}! Amazing memory!`);
          }
          return nm;
        });
        setFlipped([]);
      }, 600);
    } else {
      setTimeout(() => setFlipped([]), 900);
    }
  };

  if (err) return <div className="mem"><div className="mem-msg">Couldn't load the game. Try again!</div></div>;
  if (!game) return <div className="mem"><div className="mem-msg">🃏 Shuffling the cards…</div></div>;

  return (
    <div className="mem" style={{ ['--user' as any]: profile?.color || '#7c3aed' }}>
      <div className="mem-bar">
        <span className="mem-title">{game.emoji} {game.title}</span>
        <span className="mem-stat">{matched.size}/{game.pairs.length} pairs · {moves} moves</span>
      </div>
      {won && <div className="mem-win">🎉 You won in {moves} moves! <button className="rbtn" onClick={reset}>Play again ↺</button></div>}
      <div className="mem-grid">
        {cards.map((c, idx) => {
          const up = flipped.includes(idx) || matched.has(c.pair);
          return (
            <button key={c.key} className={`mcard${up ? ' up' : ''}${matched.has(c.pair) ? ' matched' : ''}`} onClick={() => click(idx)} aria-label={up ? c.label : 'hidden card'}>
              <span className="mcard-inner">{up ? c.emoji : '❓'}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
