// Renders a declarative document (the widget kit) for any 'declarative' content
// type — flashcards today, math/language later. Content is pure data; this is the
// one trusted renderer that draws the vetted widgets. The avatar speaks via the
// shell's `speak` (tap-to-hear, quiz feedback).
import { useEffect, useRef, useState } from 'react';
import type { DeclarativeDoc, DeclBlock, SceneNode, SceneShape, SceneIconData } from '../lib/types';
import { getContent, markEngagement } from '../lib/api';
import type { ContentRendererProps } from './types';

export default function DeclarativeRenderer({
  artifactId,
  profile,
  speak,
  setMood,
}: ContentRendererProps) {
  const [doc, setDoc] = useState<DeclarativeDoc | null>(null);
  const [err, setErr] = useState(false);
  const [done, setDone] = useState(false);
  const finishedRef = useRef(false);
  const pid = profile?.id;
  const voice = profile?.voice || undefined;
  const say = (t: string) => speak(t, pid, 'decl', voice);

  useEffect(() => {
    let live = true;
    getContent<DeclarativeDoc>(artifactId)
      .then((d) => {
        if (live) setDoc(d);
      })
      .catch(() => {
        if (live) setErr(true);
      });
    return () => {
      live = false;
    };
  }, [artifactId]);
  useEffect(() => {
    setMood('idle');
  }, [setMood]);

  const finish = () => {
    if (!finishedRef.current && pid) {
      finishedRef.current = true;
      markEngagement(artifactId, 'finished', pid);
    }
    setDone(true);
    say(`Awesome work${profile?.name ? ', ' + profile.name : ''}!`);
  };

  if (err)
    return (
      <div className="decl">
        <div className="decl-msg">Couldn't load this. Try again!</div>
      </div>
    );
  if (!doc)
    return (
      <div className="decl">
        <div className="decl-msg">✨ Getting it ready…</div>
      </div>
    );

  return (
    <div className="decl" style={{ ['--user' as any]: profile?.color || '#0ea5e9' }}>
      <h1 className="decl-title">
        {doc.emoji} {doc.title}
      </h1>
      {doc.blocks.map((b, i) => (
        <Block key={i} block={b} say={say} />
      ))}
      <div className="decl-foot">
        <button className="rbtn primary" onClick={finish}>
          {done ? 'All done! 🎉' : "I'm finished! 🎉"}
        </button>
      </div>
    </div>
  );
}

function Block({ block, say }: { block: DeclBlock; say: (t: string) => void }) {
  switch (block.type) {
    case 'heading':
      return <h2 className="decl-h">{block.text}</h2>;
    case 'text':
      return (
        <p className="decl-text" onClick={() => say(block.text)} title="Tap to hear">
          {block.text}
        </p>
      );
    case 'image':
      return <Image block={block} />;
    case 'flashcards':
      return <Flashcards cards={block.cards} say={say} />;
    case 'scene':
      return <Scene block={block} say={say} />;
    case 'quiz':
      return <Quiz block={block} say={say} />;
    default:
      return null;
  }
}

function Image({ block }: { block: Extract<DeclBlock, { type: 'image' }> }) {
  if (!block.mediaId) return null; // unresolved request — nothing to show
  return (
    <figure className="decl-figure">
      <img src={`/api/media/${block.mediaId}`} alt={block.alt} loading="lazy" />
      {(block.caption || block.credit) && (
        <figcaption>
          {block.caption}
          {block.credit ? <span className="decl-credit"> · {block.credit}</span> : null}
        </figcaption>
      )}
    </figure>
  );
}

function Flashcards({
  cards,
  say,
}: {
  cards: { front: string; back: string; hint?: string }[];
  say: (t: string) => void;
}) {
  const [flipped, setFlipped] = useState<Record<number, boolean>>({});
  return (
    <div className="decl-cards">
      {cards.map((c, i) => {
        const isBack = !!flipped[i];
        const face = isBack ? c.back : c.front;
        return (
          <div
            key={i}
            className={`fcard${isBack ? ' flipped' : ''}`}
            onClick={() => setFlipped((f) => ({ ...f, [i]: !f[i] }))}
          >
            <div className="fcard-face">
              <span className="fcard-side">{isBack ? 'back' : 'front'}</span>
              <span className="fcard-text">{face}</span>
              {!isBack && c.hint && <span className="fcard-hint">💡 {c.hint}</span>}
              <button
                className="fcard-hear"
                title="Tap to hear"
                onClick={(e) => {
                  e.stopPropagation();
                  say(face);
                }}
              >
                🔊
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Explorable scene: a spatial diagram of focusable things. Tap one to zoom in — the
// avatar speaks its blurb and its facts are tap-to-hear. Prev/Next jump between them.
// The model only supplies data; this trusted renderer does all the motion.
type SceneBlock = Extract<DeclBlock, { type: 'scene' }>;

function Scene({ block, say }: { block: SceneBlock; say: (t: string) => void }) {
  const hasCenter = !!block.center;
  const focusable: SceneNode[] = hasCenter ? [block.center!, ...block.nodes] : block.nodes;
  const [focus, setFocus] = useState<number | null>(null);
  const node = focus != null ? focusable[focus] : null;

  // When a thing is focused, the avatar tells you about it (speaks its blurb).
  useEffect(() => {
    if (node?.blurb) say(node.blurb);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const jump = (d: number) =>
    setFocus((f) => {
      const n = focusable.length,
        cur = f == null ? 0 : f;
      return (((cur + d) % n) + n) % n;
    });

  return (
    <div className={`scene scene-${block.layout}`}>
      <div className="scene-stage">
        {block.layout === 'orbit' ? (
          <OrbitLayout block={block} paused={focus != null} focus={focus} onFocus={setFocus} />
        ) : block.layout === 'cycle' ? (
          <CycleLayout block={block} focus={focus} onFocus={setFocus} />
        ) : (
          <MapLayout block={block} focus={focus} onFocus={setFocus} />
        )}

        {node && (
          <div className="scene-detail">
            <button className="scene-x" onClick={() => setFocus(null)} title="Back to the map">
              ✕
            </button>
            <div className="scene-detail-emoji">{node.emoji}</div>
            <h3 className="scene-detail-label">{node.label}</h3>
            {node.blurb && (
              <p
                className="scene-detail-blurb"
                onClick={() => say(node.blurb!)}
                title="Tap to hear"
              >
                {node.blurb}
              </p>
            )}
            {!!node.facts?.length && (
              <ul className="scene-facts">
                {node.facts.map((f, i) => (
                  <li key={i} onClick={() => say(f)} title="Tap to hear">
                    <span className="scene-fact-hear">🔊</span> {f}
                  </li>
                ))}
              </ul>
            )}
            <div className="scene-nav">
              <button className="rbtn" onClick={() => jump(-1)}>
                ‹ Prev
              </button>
              <span className="scene-nav-pos">
                {focus! + 1} / {focusable.length}
              </span>
              <button className="rbtn" onClick={() => jump(1)}>
                Next ›
              </button>
            </div>
          </div>
        )}
      </div>
      {!node && <p className="scene-hint">👆 Tap anything to zoom in and hear about it</p>}
      {block.caption && <p className="scene-caption">{block.caption}</p>}
    </div>
  );
}

function NodeButton({
  nd,
  on,
  onClick,
  disc = 58,
}: {
  nd: SceneNode;
  on: boolean;
  onClick: () => void;
  disc?: number;
}) {
  const accent = nd.color || undefined;
  return (
    <button type="button" className={`node-btn${on ? ' on' : ''}`} onClick={onClick}>
      <span
        className="node-disc"
        style={{
          width: disc,
          height: disc,
          fontSize: disc * 0.5,
          ...(accent ? { ['--node' as any]: accent } : {}),
        }}
      >
        {nd.icon ? <SceneIcon icon={nd.icon} size={Math.round(disc * 0.62)} /> : nd.emoji}
      </span>
      <span className="node-label">{nd.label}</span>
    </button>
  );
}

// Render a structured (already-sanitized) vector icon as real SVG elements. Values
// come only from the server whitelist, so this just maps shapes → elements; we set
// only known geometry/presentation attributes and never any markup string.
function SceneIcon({ icon, size }: { icon: SceneIconData; size: number }) {
  return (
    <svg className="node-icon" width={size} height={size} viewBox={icon.viewBox} aria-hidden="true">
      {icon.shapes.map((s, i) => (
        <Shape key={i} s={s} />
      ))}
    </svg>
  );
}
function Shape({ s }: { s: SceneShape }) {
  // Line art by default: a shape with a stroke and no fill shouldn't be filled black;
  // a shape with neither should paint in the theme color.
  const common = {
    fill: s.fill ?? (s.stroke ? 'none' : 'currentColor'),
    stroke: s.stroke,
    strokeWidth: s.strokeWidth,
    strokeLinecap: s.strokeLinecap as any,
    strokeLinejoin: s.strokeLinejoin as any,
    opacity: s.opacity,
  };
  switch (s.type) {
    case 'path':
      return <path {...common} d={s.d} />;
    case 'circle':
      return <circle {...common} cx={s.cx} cy={s.cy} r={s.r} />;
    case 'ellipse':
      return <ellipse {...common} cx={s.cx} cy={s.cy} rx={s.rx} ry={s.ry} />;
    case 'rect':
      return (
        <rect {...common} x={s.x} y={s.y} width={s.width} height={s.height} rx={s.rx} ry={s.ry} />
      );
    case 'line':
      return <line {...common} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} />;
    case 'polygon':
      return <polygon {...common} points={s.points} />;
    case 'polyline':
      return <polyline {...common} points={s.points} />;
    default:
      return null;
  }
}

function OrbitLayout({
  block,
  paused,
  focus,
  onFocus,
}: {
  block: SceneBlock;
  paused: boolean;
  focus: number | null;
  onFocus: (i: number) => void;
}) {
  const { nodes } = block,
    n = nodes.length,
    hasCenter = !!block.center;
  return (
    <div className="orbit">
      {hasCenter && (
        <div className="orbit-center">
          <NodeButton nd={block.center!} on={focus === 0} onClick={() => onFocus(0)} disc={84} />
        </div>
      )}
      {nodes.map((nd, i) => {
        const ringPct = 34 + (i * 64) / Math.max(1, n - 1); // inner ring 34% → outer 98% of stage
        const dur = 48 + i * 10; // slow, gentle drift — easy to tap; outer slower
        // Stagger each planet's start angle (negative delay) so they're spread around
        // their orbits at all times instead of bunching at 12 o'clock — including at
        // t=0 and when frozen for prefers-reduced-motion.
        const delay = -(dur * i) / n;
        const fIdx = hasCenter ? i + 1 : i;
        const anim = {
          animationDuration: `${dur}s`,
          animationDelay: `${delay}s`,
          animationPlayState: paused ? 'paused' : 'running',
        } as const;
        return (
          <div
            key={i}
            className="orbit-ring"
            style={{ width: `${ringPct}%`, height: `${ringPct}%`, ...anim }}
          >
            <div className="orbit-node" style={anim}>
              <NodeButton
                nd={nd}
                on={focus === fIdx}
                onClick={() => onFocus(fIdx)}
                disc={Math.round(46 * (nd.size || 1))}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// When there's no backdrop figure to anchor to, rescale the model's coordinates
// (uniformly, preserving shape) so the diagram fills the stage instead of bunching
// in one corner. With a backdrop, trust the coords — they're placed on the figure.
function fitNodes(nodes: SceneNode[]): { x: number; y: number }[] {
  const xs = nodes.map((n) => n.x ?? 50),
    ys = nodes.map((n) => n.y ?? 50);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY, 1);
  const scale = Math.min(2.2, 76 / span); // fill ~76% of the stage, don't over-zoom
  const cx = (minX + maxX) / 2,
    cy = (minY + maxY) / 2;
  return nodes.map((n) => ({
    x: 50 + ((n.x ?? 50) - cx) * scale,
    y: 50 + ((n.y ?? 50) - cy) * scale,
  }));
}

function MapLayout({
  block,
  focus,
  onFocus,
}: {
  block: SceneBlock;
  focus: number | null;
  onFocus: (i: number) => void;
}) {
  const pts = block.backdrop
    ? block.nodes.map((n) => ({ x: n.x ?? 50, y: n.y ?? 50 }))
    : fitNodes(block.nodes);
  return (
    <div className="map">
      {block.backdrop && <Backdrop kind={block.backdrop} />}
      {block.nodes.map((nd, i) => (
        <div key={i} className="map-node" style={{ left: `${pts[i].x}%`, top: `${pts[i].y}%` }}>
          <NodeButton nd={nd} on={focus === i} onClick={() => onFocus(i)} disc={62} />
        </div>
      ))}
    </div>
  );
}

// Curated, faint silhouettes that anchor a 'map' scene to a real figure. Drawn in
// the 0–100 coordinate space the node x/y use, so nodes land on the right spots.
function Backdrop({ kind }: { kind: 'body' | 'plant' | 'globe' }) {
  return (
    <svg
      className="scene-backdrop"
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {kind === 'body' && (
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="50" cy="11" r="7" />
          <path d="M50 18 V47" />
          <path d="M34 27 H66" />
          <path d="M34 27 L22 50 M66 27 L78 50" />
          <path d="M40 47 H60" />
          <path d="M42 47 L40 95 M58 47 L60 95" />
        </g>
      )}
      {kind === 'plant' && (
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M50 90 V30" />
          <path d="M50 56 C36 52 30 40 30 38 C42 38 48 46 50 52" />
          <path d="M50 50 C64 46 70 34 70 32 C58 32 52 40 50 46" />
          <path d="M50 30 C46 22 50 14 50 14 C50 14 54 22 50 30 Z" />
          <path d="M40 90 Q50 84 60 90" />
        </g>
      )}
      {kind === 'globe' && (
        <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <circle cx="50" cy="50" r="38" />
          <ellipse cx="50" cy="50" rx="15" ry="38" />
          <path d="M12 50 H88 M18 30 H82 M18 70 H82" />
        </g>
      )}
    </svg>
  );
}

function CycleLayout({
  block,
  focus,
  onFocus,
}: {
  block: SceneBlock;
  focus: number | null;
  onFocus: (i: number) => void;
}) {
  const { nodes } = block,
    n = nodes.length,
    R = 38;
  const pos = (i: number) => {
    const a = (i / n) * 2 * Math.PI - Math.PI / 2; // first step at the top, flowing clockwise
    return { x: 50 + R * Math.cos(a), y: 50 + R * Math.sin(a) };
  };
  return (
    <div className="cycle">
      <svg
        className="cycle-svg"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <circle cx="50" cy="50" r={R} className="cycle-path" />
      </svg>
      {nodes.map((nd, i) => {
        const p = pos(i);
        return (
          <div key={i} className="cycle-node" style={{ left: `${p.x}%`, top: `${p.y}%` }}>
            <NodeButton nd={nd} on={focus === i} onClick={() => onFocus(i)} disc={58} />
          </div>
        );
      })}
    </div>
  );
}

function Quiz({
  block,
  say,
}: {
  block: Extract<DeclBlock, { type: 'quiz' }>;
  say: (t: string) => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const choose = (i: number) => {
    if (picked !== null) return;
    setPicked(i);
    const right = i === block.answer;
    say(right ? 'That is correct! Great job!' : 'Good try! The right answer is highlighted.');
  };
  return (
    <div className="decl-quiz">
      <p className="decl-q" onClick={() => say(block.question)} title="Tap to hear">
        🧠 {block.question}
      </p>
      <div className="decl-opts">
        {block.options.map((o, i) => {
          let cls = 'opt';
          if (picked !== null && i === block.answer) cls += ' right';
          else if (picked === i) cls += ' wrong';
          return (
            <button key={i} className={cls} onClick={() => choose(i)}>
              {o}
            </button>
          );
        })}
      </div>
    </div>
  );
}
