/**
 * The pieces of the landing page (dev only, until it replaces pages/Landing.tsx): the example
 * interview, the organic shapes, the turn strip, a story, the people, and the motion hook. Every scene is written in its finished
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

/* ── organic shapes ───────────────────────────────────── */

/**
 * A hand-cut pebble in a 256 box, the same family as the logo's glow: points around a circle,
 * each pushed in or out a little, joined by a smooth closed curve. The same seed always cuts the
 * same pebble, and every pebble has the same number of points, so any two morph cleanly.
 */
export function pebble(seed: number, wobble = 0.14, squash = 0.88, n = 9): string {
  let s = (seed * 7919) % 233280;
  const rand = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 + (rand() - 0.5) * 0.35;
    const r = 96 * (1 + (rand() - 0.5) * 2 * wobble);
    return [128 + Math.cos(a) * r, 128 + Math.sin(a) * r * squash] as const;
  });
  const at = (i: number) => pts[(i + n) % n]!;
  const f = (v: number) => v.toFixed(1);
  let d = `M${f(at(0)[0])} ${f(at(0)[1])}`;
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d}Z`;
}

/** the pebbles a voice moves through while it talks */
export const VOICE_SHAPES = [3, 11, 19, 27, 35].map((seed) => pebble(seed, 0.16));

/** the logo's glow and bowl, at full scale, for the scenes that start from the mark */
export const MARK_GLOW =
  'M188.9 106.6C186.5 119.8 174.4 134.5 162.9 142.4C151.4 150.3 133.9 155.3 119.8 153.9C105.7 152.6 86.7 144.9 78.1 134.3C69.5 123.7 65.5 103.7 68.1 90.5C70.6 77.2 82 63.2 93.4 54.9C104.8 46.7 122.5 39.7 136.5 41C150.5 42.4 168.8 52 177.5 63C186.3 73.9 191.3 93.4 188.9 106.6Z';
export const MARK_BOWL =
  'M29 147C30.6 151.5 34.7 161.8 39.2 168.3C43.6 174.7 49.4 180.7 55.7 185.7C62.1 190.8 69.5 195.1 77.2 198.5C84.8 202 93.3 204.6 101.8 206.3C110.3 208.1 119.3 209 128 209C136.7 209 145.7 208.1 154.2 206.3C162.7 204.6 171.2 202 178.8 198.5C186.5 195.1 193.9 190.8 200.3 185.7C206.6 180.7 212.4 174.7 216.8 168.3C221.3 161.8 225.4 151.5 227 147C228.7 142.5 227.5 142.9 226.8 141.3C226 139.7 224.2 138 222.6 137.4C220.9 136.8 218.4 136.9 216.8 137.7C215.2 138.4 215.3 138.8 213 141.9C210.6 145 206.7 152.2 202.5 156.3C198.3 160.4 193.1 163.7 187.6 166.6C182.1 169.5 176 171.7 169.6 173.6C163.2 175.4 156.3 176.7 149.3 177.6C142.4 178.5 135.1 179 128 179C120.9 179 113.6 178.5 106.7 177.6C99.7 176.7 92.8 175.4 86.4 173.6C80 171.7 73.9 169.5 68.4 166.6C62.9 163.7 57.7 160.4 53.5 156.3C49.3 152.2 45.4 145 43 141.9C40.7 138.8 40.8 138.4 39.2 137.7C37.6 136.9 35.1 136.8 33.4 137.4C31.8 138 30 139.7 29.2 141.3C28.5 142.9 27.3 142.5 29 147Z';

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
