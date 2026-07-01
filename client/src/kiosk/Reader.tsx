// Native reading-practice experience (not a sandboxed artifact): the avatar can
// read a line with words highlighting in time, or the child reads it aloud and we
// follow along LIVE — a streaming-STT buffer advances a cursor word-by-word, so
// the child reads at their own pace (no "say it fast and clearly" pressure). The
// current word is underlined ("say this next"), words turn green as they're heard,
// and a gentle red pulse + spoken hint appears only if they're stuck. Each line is
// persisted for the parent report and difficulty adaptation. Always encouraging.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReadingLesson, WordMark } from '../lib/types';
import { getContent, postContentEvent, markEngagement } from '../lib/api';
import { gradeReading, feedbackFor, alignLive, normWord, splitWords } from '../lib/grader';
import { getStt, type SttEngine, type LiveSession } from './sttService';
import type { ContentRendererProps } from '../content/types';

type Phase = 'idle' | 'avatar' | 'listen' | 'graded' | 'done';

type ReaderProps = ContentRendererProps;

// Per-word end fractions (by character share) so a 0..1 playback progress maps to
// a word index — approximate karaoke without word timestamps from Piper.
function wordEnds(words: string[]): number[] {
  const total = words.reduce((s, w) => s + w.length + 1, 0) || 1;
  let acc = 0;
  return words.map((w) => {
    acc += w.length + 1;
    return acc / total;
  });
}

export default function Reader({ artifactId, profile, speak, setMood }: ReaderProps) {
  const [lesson, setLesson] = useState<ReadingLesson | null>(null);
  const [err, setErr] = useState(false);
  const [page, setPage] = useState(0);
  const [lineIdx, setLineIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const [wordHi, setWordHi] = useState(-1); // word being spoken by the avatar
  const [cursor, setCursor] = useState(0); // next word the child should read (live)
  const [liveMarks, setLiveMarks] = useState<boolean[]>([]); // words heard so far (live)
  const [flash, setFlash] = useState(false); // brief "stuck on this word" cue
  const [marks, setMarks] = useState<WordMark[] | null>(null); // final per-word result
  const [feedback, setFeedback] = useState('');

  const sttRef = useRef<SttEngine | null>(null);
  if (!sttRef.current) sttRef.current = getStt();
  const sessionRef = useRef<LiveSession | null>(null);
  const finishRef = useRef<(() => void) | null>(null);
  const autoReadRef = useRef<string>(''); // guards once-per-line auto echo
  const genRef = useRef(0); // cancels stale async on line change/unmount

  useEffect(() => {
    let live = true;
    getContent<ReadingLesson>(artifactId)
      .then((l) => {
        if (live) setLesson(l);
      })
      .catch(() => {
        if (live) setErr(true);
      });
    return () => {
      live = false;
      genRef.current++;
      sessionRef.current?.stop();
    };
  }, [artifactId]);
  useEffect(
    () => () => {
      sessionRef.current?.stop();
    },
    [],
  ); // stop mic on unmount

  const pg = lesson?.pages[page];
  const line = pg?.lines[lineIdx] ?? '';
  const words = line.split(/\s+/).filter(Boolean);
  const echo = (lesson?.level ?? 2) <= 2; // early readers: avatar reads first
  const profileId = profile?.id;
  const voice = profile?.voice || undefined;
  const canStream = !!sttRef.current?.live;

  const resetLine = () => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    setWordHi(-1);
    setCursor(0);
    setLiveMarks([]);
    setFlash(false);
    setMarks(null);
    setFeedback('');
    setPhase('idle');
  };

  const avatarReadLine = useCallback(async () => {
    if (!line) return;
    const my = ++genRef.current;
    sessionRef.current?.stop();
    sessionRef.current = null;
    setPhase('avatar');
    setMarks(null);
    setFeedback('');
    const ends = wordEnds(words);
    await speak(line, profileId, 'reader', voice, (f) => {
      if (my !== genRef.current) return;
      let i = ends.findIndex((e) => f <= e);
      if (i < 0) i = words.length - 1;
      setWordHi(i);
    });
    if (my !== genRef.current) return;
    setWordHi(-1);
    setPhase('idle');
  }, [line, words, speak, profileId, voice]);

  // LIVE read-along: stream the child's speech and advance a cursor word-by-word.
  const startLive = useCallback(() => {
    if (!line) return;
    if (!canStream) {
      listenOnce();
      return;
    } // fallback for non-streaming engines
    const my = ++genRef.current;
    const expN = words.map(normWord);
    const heard = words.map(() => false);
    let cur = 0,
      done = false,
      hinted = false,
      lastText = '';
    setPhase('listen');
    setMarks(null);
    setFeedback('');
    setWordHi(-1);
    setLiveMarks(heard.slice());
    setCursor(0);
    setMood('listening');

    const finish = () => {
      if (done || my !== genRef.current) return;
      done = true;
      sessionRef.current?.stop();
      sessionRef.current = null;
      setMood('idle');
      const score = heard.length ? heard.filter(Boolean).length / heard.length : 1;
      const perWord: WordMark[] = words.map((w, i) => ({ word: normWord(w), ok: heard[i] }));
      setMarks(perWord);
      setPhase('graded');
      const msg = feedbackFor(score, profile?.name || undefined);
      setFeedback(msg);
      speak(msg, profileId, 'reader', voice);
      postContentEvent(artifactId, profileId || '', {
        pageIndex: page,
        lineIndex: lineIdx,
        expected: line,
        transcript: lastText || '(live)',
        score,
        perWord,
      });
      setTimeout(
        () => {
          if (my === genRef.current) advance();
        },
        score >= 0.6 ? 1400 : 2400,
      );
    };
    finishRef.current = finish;

    const onText = (text: string) => {
      if (my !== genRef.current || done) return;
      lastText = text;
      const recognized = splitWords(text).map(normWord).filter(Boolean);
      const { cursor: cz, matched, trailingUnmatched } = alignLive(expN, recognized);
      for (let i = 0; i < heard.length; i++) heard[i] = heard[i] || matched[i]; // monotonic
      setLiveMarks(heard.slice());
      if (cz > cur) {
        cur = cz;
        hinted = false;
        setFlash(false);
      }
      setCursor(cur);
      if (cur >= expN.length) {
        finish();
        return;
      }
      // Stuck on the current word? gentle red pulse + speak it once as a hint.
      if (trailingUnmatched >= 2 && !hinted) {
        hinted = true;
        setFlash(true);
        setTimeout(() => {
          if (my === genRef.current) setFlash(false);
        }, 800);
        speak(words[cur], profileId, 'reader-hint', voice);
      }
    };
    sessionRef.current = sttRef.current!.listenLive(onText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line, words, canStream, profileId, voice, page, lineIdx, artifactId, profile]);

  // One-shot fallback (no streaming engine): record the whole line, grade once.
  const listenOnce = useCallback(async () => {
    const my = ++genRef.current;
    setPhase('listen');
    setMarks(null);
    setFeedback('');
    setMood('listening');
    let transcript = '';
    try {
      transcript = (await sttRef.current!.listen().result).transcript;
    } catch {}
    setMood('idle');
    if (my !== genRef.current) return;
    if (!transcript.trim()) {
      const msg = "I didn't catch that — let's try together!";
      setPhase('graded');
      setMarks(null);
      setFeedback(msg);
      speak(msg, profileId, 'reader', voice);
      return;
    }
    const { score, perWord } = gradeReading(line, transcript);
    setMarks(perWord);
    setPhase('graded');
    const msg = feedbackFor(score, profile?.name || undefined);
    setFeedback(msg);
    speak(msg, profileId, 'reader', voice);
    postContentEvent(artifactId, profileId || '', {
      pageIndex: page,
      lineIndex: lineIdx,
      expected: line,
      transcript,
      score,
      perWord,
    });
    if (score >= 0.75)
      setTimeout(() => {
        if (my === genRef.current) advance();
      }, 1500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line, page, lineIdx, artifactId, profileId, voice, profile]);

  const advance = useCallback(() => {
    if (!lesson) return;
    genRef.current++;
    resetLine();
    const last = lesson.pages[page].lines.length - 1;
    if (lineIdx < last) {
      setLineIdx(lineIdx + 1);
      return;
    }
    if (page < lesson.pages.length - 1) {
      setPage(page + 1);
      setLineIdx(0);
      return;
    }
    setPhase('done');
    if (profileId) markEngagement(artifactId, 'finished', profileId);
    speak(
      `You finished the whole story! I'm so proud of you${profile?.name ? ', ' + profile.name : ''}!`,
      profileId,
      'reader',
      voice,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson, page, lineIdx, artifactId, profileId, voice, profile]);

  // Early readers: auto-play the avatar reading once when a new line appears.
  useEffect(() => {
    if (!lesson || phase === 'done') return;
    const key = `${page}.${lineIdx}`;
    if (echo && autoReadRef.current !== key) {
      autoReadRef.current = key;
      avatarReadLine();
    }
  }, [lesson, page, lineIdx, echo, phase, avatarReadLine]);

  if (err)
    return (
      <div className="reader">
        <div className="reader-msg">Couldn't load this story. Try again!</div>
      </div>
    );
  if (!lesson)
    return (
      <div className="reader">
        <div className="reader-msg">📖 Opening your story…</div>
      </div>
    );

  if (phase === 'done') {
    return (
      <div className="reader done">
        <div className="reader-illus">🎉</div>
        <h2>You did it!</h2>
        <p className="reader-msg">Great reading, {profile?.name || 'friend'}!</p>
        <button
          className="rbtn primary"
          onClick={() => {
            setPage(0);
            setLineIdx(0);
            autoReadRef.current = '';
            resetLine();
          }}
        >
          Read it again ↺
        </button>
      </div>
    );
  }

  const totalLines = lesson.pages.reduce((s, p) => s + p.lines.length, 0);
  const doneLines = lesson.pages.slice(0, page).reduce((s, p) => s + p.lines.length, 0) + lineIdx;

  return (
    <div className="reader" style={{ ['--user' as any]: profile?.color || '#16b8a6' }}>
      <div className="reader-bar">
        <span className="reader-title">
          {lesson.emoji} {lesson.title}
        </span>
        <span className="reader-prog">
          <span
            className="reader-prog-fill"
            style={{ width: `${(doneLines / totalLines) * 100}%` }}
          />
        </span>
        <span className="reader-lvl">level {lesson.level}</span>
      </div>

      <div className="reader-stage">
        <div className="reader-illus">{pg?.illustration || '📖'}</div>
        <div className="reader-lines">
          {pg?.lines.map((ln, i) => {
            const isCur = i === lineIdx;
            const lw = ln.split(/\s+/).filter(Boolean);
            return (
              <p key={i} className={`rline${isCur ? ' current' : ''}`}>
                {lw.map((w, wi) => {
                  let cls = 'rword';
                  if (isCur && phase === 'avatar' && wi === wordHi) cls += ' hi';
                  if (isCur && phase === 'listen') {
                    if (liveMarks[wi]) cls += ' ok';
                    else if (wi === cursor) cls += flash ? ' flash' : ' next';
                  }
                  if (isCur && phase === 'graded' && marks && marks[wi])
                    cls += marks[wi].ok ? ' ok' : ' miss';
                  return (
                    <span key={wi} className={cls}>
                      {w}{' '}
                    </span>
                  );
                })}
              </p>
            );
          })}
        </div>
      </div>

      {feedback && <div className="reader-feedback">{feedback}</div>}
      {phase === 'listen' && (
        <div className="reader-hint">Read it out loud — I'm listening! 👂</div>
      )}

      <div className="reader-controls">
        <button
          className="rbtn"
          disabled={phase === 'avatar' || phase === 'listen'}
          onClick={avatarReadLine}
        >
          🔊 Hear it
        </button>
        {phase === 'listen' ? (
          <button className="rbtn live" onClick={() => finishRef.current?.()}>
            ✓ Done
          </button>
        ) : (
          <button className="rbtn primary" disabled={phase === 'avatar'} onClick={startLive}>
            🎤 My turn
          </button>
        )}
        {phase === 'graded' && (
          <button className="rbtn" onClick={advance}>
            Next →
          </button>
        )}
      </div>
    </div>
  );
}
