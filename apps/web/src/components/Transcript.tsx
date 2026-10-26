import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { clock, turnsOf } from '../lib/interview';
import type { Segment } from '../lib/live';

const TONES = ['sage', 'family', 'keep', 'wonder'] as const;

/**
 * The conversation as it is written down: one block per turn, named by voice, with the words
 * still being worked out shown faintly at the end. When `scroller` is given, it follows the
 * newest words inside that box, unless the person has scrolled up to read.
 */
export function Transcript({
  segments,
  names,
  partials,
  scroller,
  empty,
}: {
  segments: Segment[];
  names: Map<string, string>;
  partials: Array<{ speaker: string; text: string }>;
  scroller?: React.RefObject<HTMLElement | null>;
  empty: string;
}) {
  const turns = turnsOf(segments);
  const order = [...names.keys()];
  const tone = (sp: string) => TONES[Math.max(0, order.indexOf(sp)) % TONES.length];
  // a voice still in the middle of its first sentence takes the next number now
  const nextNumber = [...names.values()].filter((n) => /^Speaker \d+$/.test(n)).length + 1;
  const label = (sp: string) => names.get(sp) ?? `Speaker ${nextNumber}`;
  const pinned = useRef(true);

  useEffect(() => {
    const el = scroller?.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scroller]);

  useLayoutEffect(() => {
    const el = scroller?.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  if (turns.length === 0 && partials.length === 0)
    return <p className="transcript-empty">{empty}</p>;

  // an unsettled line joins the turn of the same voice when that voice is still talking
  const lastSpeaker = turns[turns.length - 1]?.speaker;
  return (
    <div className="live-transcript" aria-live="polite">
      {turns.map((turn, i) => {
        const tail =
          i === turns.length - 1 ? partials.filter((p) => p.speaker === turn.speaker) : [];
        return (
          <div key={i} className="live-turn">
            <span className={`live-who live-who-${tone(turn.speaker)}`}>
              {label(turn.speaker)}
              <span className="live-time">{clock(turn.start)}</span>
            </span>
            <p>
              {turn.text}
              {tail.map((p, j) => (
                <span key={j} className="live-partial">
                  {' '}
                  {p.text}
                </span>
              ))}
            </p>
          </div>
        );
      })}
      {partials
        .filter((p) => p.speaker !== lastSpeaker)
        .map((p, j) => (
          <div key={`p${j}`} className="live-turn">
            <span className={`live-who live-who-${tone(p.speaker)}`}>{label(p.speaker)}</span>
            <p className="live-partial">{p.text}</p>
          </div>
        ))}
    </div>
  );
}

/** Seconds of recording, ticking. */
export function Clock({ elapsed }: { elapsed: () => number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);
  return <span className="live-clock">{clock(elapsed())}</span>;
}

/** Five bars that move with the microphone, so it is plain that it hears you. */
export function Level({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    let raf = 0;
    const draw = () => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      ref.current?.style.setProperty('--level', String(Math.min(1, peak / 64)));
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      void ctx.close();
    };
  }, [stream]);
  return (
    <span ref={ref} className="live-level" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}
