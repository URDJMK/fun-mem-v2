/**
 * The pieces of the landing page (pages/Landing.tsx): the example interview, the organic shapes,
 * the turn strip, a story, the people, and the motion hook. Every scene is written in its finished
 * state; motion, when the visitor allows it, starts from there and plays toward it again.
 */
import { useLayoutEffect, type RefObject } from 'react';
import { Link } from 'react-router';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { SplitText } from 'gsap/SplitText';
import { MorphSVGPlugin } from 'gsap/MorphSVGPlugin';
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin';
import { TextPlugin } from 'gsap/TextPlugin';

gsap.registerPlugin(ScrollTrigger, SplitText, MorphSVGPlugin, DrawSVGPlugin, TextPlugin);

export { gsap, ScrollTrigger, SplitText };

/* ── the example: one afternoon with Nell ─────────────── */

export type Turn = { who: 'Theo' | 'Nell'; text: string; keep?: string };

export const TURNS: Turn[] = [
  { who: 'Theo', text: 'Where did you work, back then?' },
  {
    who: 'Nell',
    text: 'At the telephone exchange, from 1959.',
    keep: 'The board lit up like a Christmas tree.',
  },
  { who: 'Theo', text: 'Who sat next to you?' },
  { who: 'Nell', text: 'Dorothy.', keep: 'We passed notes along the board all night.' },
];

export const STORIES = [
  { when: '1959', title: 'The board lit up like a Christmas tree', quote: TURNS[1]!.keep! },
  { when: 'Around 1960', title: 'Notes along the board', quote: TURNS[3]!.keep! },
];

/** one afternoon's turns, as lengths: the strip's proportions (teller long, interviewer short) */
export const AFTERNOON: { who: Turn['who']; len: number }[] = [
  { who: 'Theo', len: 2 },
  { who: 'Nell', len: 7 },
  { who: 'Theo', len: 2 },
  { who: 'Nell', len: 5 },
  { who: 'Theo', len: 1 },
  { who: 'Nell', len: 9 },
  { who: 'Theo', len: 2 },
  { who: 'Nell', len: 6 },
  { who: 'Theo', len: 1 },
  { who: 'Nell', len: 8 },
];

/* ── organic shapes: the mark's, shared with the app (lib/mark.ts) ── */

export { MARK_BOWL, MARK_GLOW, pebble, VOICE_SHAPES } from '../../lib/mark';

/* ── pieces ───────────────────────────────────────────── */

/** a line as it was said: who, the words, and the words worth keeping under the marker */
export function Said({ turn, className = '' }: { turn: Turn; className?: string }) {
  return (
    <p className={`lpx-said ${className}`} data-who={turn.who}>
      <b>{turn.who}</b> <span className="lpx-words">{turn.text}</span>
      {turn.keep && (
        <>
          {' '}
          <mark className="lpx-mark">{turn.keep}</mark>
        </>
      )}
    </p>
  );
}

/** the turn strip: one bar per turn, as long as the turn, coloured by who was talking */
export function TurnStrip({
  turns = AFTERNOON,
  vertical = false,
  className = '',
}: {
  turns?: { who: Turn['who']; len: number }[];
  vertical?: boolean;
  className?: string;
}) {
  return (
    <div className={`lpx-strip ${vertical ? 'is-vertical' : ''} ${className}`} aria-hidden="true">
      {turns.map((t, i) => (
        <span key={i} className="lpx-seg" data-who={t.who} style={{ flexGrow: t.len }}>
          <span className="lpx-fill" />
        </span>
      ))}
    </div>
  );
}

/** a finished story, as the app keeps it */
export function Story({
  story,
  className = '',
}: {
  story: (typeof STORIES)[number];
  className?: string;
}) {
  return (
    <div className={`lpx-story ${className}`}>
      <span className="lpx-when t-small">{story.when}</span>
      <span className="lpx-story-title t-heading">{story.title}</span>
      <span className="lpx-story-quote">
        “<mark className="lpx-mark">{story.quote}</mark>”
      </span>
      <span className="lpx-own t-small">Nell’s own words</span>
    </div>
  );
}

export function Start({ large = false }: { large?: boolean }) {
  return (
    <Link to="/sign-in" className={`btn btn-primary ${large ? 'btn-lg' : ''}`}>
      Start
    </Link>
  );
}

/** Nell in the middle, threads out to the people, the place and the story she named */
const NODES = [
  { label: 'Dorothy', x: 16, y: 18 },
  { label: 'The telephone exchange', x: 78, y: 14 },
  { label: 'Theo', x: 20, y: 84 },
  { label: 'The board lit up like a Christmas tree', x: 72, y: 82, story: true },
];

export function People({ className = '' }: { className?: string }) {
  return (
    <div
      className={`lpx-people ${className}`}
      role="img"
      aria-label="Nell linked to Dorothy, Theo, the telephone exchange and one story"
    >
      {/* drawn in the box's own proportions (16 by 10), so a thread is as thin one way as the other */}
      <svg viewBox="0 0 160 100" aria-hidden="true">
        {NODES.map((n) => {
          const x = n.x * 1.6;
          return (
            <path
              key={n.label}
              className="lpx-thread"
              d={`M80 50 C ${80 + (x - 80) * 0.2} ${50 + (n.y - 50) * 0.9}, ${x + (80 - x) * 0.5} ${n.y}, ${x} ${n.y}`}
            />
          );
        })}
      </svg>
      <span className="lpx-node is-centre" style={{ left: '50%', top: '50%' }} aria-hidden="true">
        Nell
      </span>
      {NODES.map((n) => (
        <span
          key={n.label}
          className={`lpx-node ${n.story ? 'is-story' : ''}`}
          style={{ left: `${n.x}%`, top: `${n.y}%` }}
          aria-hidden="true"
        >
          {n.label}
        </span>
      ))}
    </div>
  );
}

/**
 * Builds a page's motion inside a GSAP context, only when the visitor has not asked for reduced
 * motion; with reduced motion the page stays as written, every scene finished. Reverted on leave.
 */
export function useMotion(root: RefObject<HTMLElement | null>, build: () => void | (() => void)) {
  useLayoutEffect(() => {
    const ctx = gsap.context(() => {
      gsap.matchMedia().add('(prefers-reduced-motion: no-preference)', build);
    }, root);
    return () => ctx.revert();
    // the scenes are built once per page
  }, []);
}
