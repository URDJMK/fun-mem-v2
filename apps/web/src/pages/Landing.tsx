/**
 * The first page, for someone who is not signed in: one interview, from the first question to the
 * finished stories, shown one object at a time on an open field, with the type kept small in the
 * corners (after dmcg.co). It opens and closes on the mark: the glow lifts out of
 * the bowl to become a voice, and settles back in at the end, when the story is kept.
 *
 * The motion follows the scroll: each object holds the centre while you scroll through it and does
 * its one thing as you go, arriving out of a blur and leaving into one; scroll back and it plays
 * backwards. Each stage is a tall section with a sticky frame, as tall as its scene needs (`hold`),
 * and then a still stretch (`DWELL`) where scrolling changes nothing, so a finished scene can be
 * looked at before the next one comes.
 * Scrolling stays the visitor's own: the page is only nudged, when they stop near the point where
 * a scene has just finished (proximity scroll snap), onto that point.
 */
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Brand } from '../components/ui';
import './landing/landing.css';
import {
  gsap,
  MARK_BOWL,
  MARK_GLOW,
  People,
  Said,
  SplitText,
  Start,
  STORIES,
  Story,
  TURNS,
  TurnStrip,
  useMotion,
  VOICE_SHAPES,
} from './landing/shared';

/** each stage: its corner label, and how long it holds the centre (in 80svh of scrolling) */
const STAGES = [
  { label: 'Firepit', hold: 1 },
  { label: 'The question', hold: 1 },
  { label: 'Two voices', hold: 2.2 },
  { label: 'The words worth keeping', hold: 2 },
  { label: 'Its place in time', hold: 1.2 },
  { label: 'Asking later', hold: 1.2 },
  { label: 'The people in it', hold: 1 },
  { label: 'Start', hold: 1 },
];

/** the still stretch after each scene, in screens of scrolling: nothing moves until it is passed */
const DWELL = 0.6;

const DECADES = ['1940s', '1950s', '1960s', '1970s'];
const PINS: Record<string, { story: (typeof STORIES)[number]; below?: boolean }> = {
  '1950s': { story: STORIES[0]! },
  '1960s': { story: STORIES[1]!, below: true },
};

/** what Nell and Theo say in the two-voices scene, after the first question */
const ANSWERS = TURNS.slice(1);

export function Landing() {
  const root = useRef<HTMLDivElement>(null);
  useMotion(root, stageScenes);

  // the corner names the stage in view, with or without motion
  useEffect(() => {
    const label = root.current?.querySelector<HTMLElement>('.ob-label');
    const stages = root.current?.querySelectorAll<HTMLElement>('.ob-stage') ?? [];
    const seen = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const at = Number((e.target as HTMLElement).dataset.stage);
          if (e.isIntersecting && label) label.textContent = STAGES[at]?.label ?? '';
        }
      },
      { rootMargin: '-50% 0px -50% 0px' },
    );
    stages.forEach((s) => seen.observe(s));
    return () => seen.disconnect();
  }, []);

  return (
    <div ref={root} className="lpx ob">
      <title>Firepit — sit down with them, keep what they say</title>
      <div className="ob-corner ob-tl">
        <Brand />
      </div>
      <div className="ob-corner ob-tr">
        <Link to="/sign-in" className="btn btn-quiet" style={{ color: 'var(--ink)' }}>
          Sign in
        </Link>
        <Start />
      </div>
      <p className="ob-corner ob-bl t-small" aria-hidden="true">
        <span className="ob-label">{STAGES[0]!.label}</span>
      </p>
      <p className="ob-corner ob-br t-small">A silent example: Theo and his grandmother Nell</p>

      <Stage at={0}>
        <div className="ob-object ob-intro">
          <Mark />
          <h1 className="t-display lpx-lines">
            <span>Sit down with them.</span> <span>Firepit keeps what they say.</span>
          </h1>
          <p className="ob-caption">
            One interview, from the first question to the finished stories. Scroll to follow it.
          </p>
          <Start large />
        </div>
      </Stage>

      <Stage at={1}>
        <figure className="ob-object">
          <div className="ob-slip">
            <span className="t-small lpx-meta">Theo asks</span>
            <span className="t-title ob-question">{TURNS[0]!.text}</span>
          </div>
          <figcaption className="ob-caption">
            Theo asks his grandmother where she worked.
          </figcaption>
        </figure>
      </Stage>

      <Stage at={2}>
        <figure className="ob-object ob-voices">
          <div className="ob-pebbles" aria-hidden="true">
            <svg className="ob-pv" data-who="Theo" viewBox="0 0 256 256">
              <path d={VOICE_SHAPES[2]} />
            </svg>
            <svg className="ob-pv" data-who="Nell" viewBox="0 0 256 256">
              <path d={VOICE_SHAPES[0]} />
            </svg>
          </div>
          <TurnStrip className="ob-strip" />
          <div className="ob-subs ob-layered">
            {ANSWERS.map((t, i) => (
              <p key={i} className="ob-sub" data-who={t.who}>
                <b>{t.who}</b> {t.text} {t.keep}
              </p>
            ))}
          </div>
          <figcaption className="ob-caption">
            Nell answers. Firepit listens, and tells their two voices apart.
          </figcaption>
        </figure>
      </Stage>

      <Stage at={3}>
        <figure className="ob-object">
          <div className="ob-keep ob-layered">
            <div className="lpx-sheet ob-transcript">
              {TURNS.map((t, i) => (
                <Said key={i} turn={t} />
              ))}
            </div>
            <Story story={STORIES[0]!} className="ob-story" />
          </div>
          <div className="ob-layered">
            <figcaption className="ob-caption ob-cap-a">
              It marks the lines in her exact words.
            </figcaption>
            <p className="ob-caption ob-cap-b">
              Each one becomes a story, dated, with her words kept.
            </p>
          </div>
        </figure>
      </Stage>

      <Stage at={4}>
        <figure className="ob-object">
          <div className="ob-time">
            <svg viewBox="0 0 400 60" aria-hidden="true">
              <path className="ob-rod" d="M4 40 C 90 22, 150 50, 210 34 S 330 22, 396 36" />
            </svg>
            <ol className="ob-decades">
              {DECADES.map((d) => {
                const pin = PINS[d];
                return (
                  <li key={d} className="t-small">
                    {d}
                    {pin && (
                      <span className={`ob-pin ${pin.below ? 'is-below' : ''}`}>
                        <span className="ob-dot" />
                        <span className="ob-pin-title t-small">{pin.story.title}</span>
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
          <figcaption className="ob-caption">Stories line up by year.</figcaption>
        </figure>
      </Stage>

      <Stage at={5}>
        <figure className="ob-object">
          <div className="lpx-ask ob-ask">
            <span className="lpx-q ob-q1">Where did Nell work?</span>
            <div className="lpx-a ob-a1">
              <p>
                At the telephone exchange, from 1959.{' '}
                <mark className="lpx-mark">“The board lit up like a Christmas tree.”</mark>
              </p>
            </div>
            <span className="lpx-q ob-q2">Was she happy there?</span>
            <div className="lpx-a lpx-none ob-a2">
              <p>
                <b>Not in the records.</b> Nothing Nell said answers this.
              </p>
            </div>
          </div>
          <figcaption className="ob-caption">
            Ask later, and the answer points to where she said it. If she never did, it says so.
          </figcaption>
        </figure>
      </Stage>

      <Stage at={6}>
        <figure className="ob-object">
          <People className="ob-people" />
          <figcaption className="ob-caption">Everyone she mentions, linked.</figcaption>
        </figure>
      </Stage>

      <Stage at={7}>
        <div className="ob-object ob-end">
          <Mark lit />
          <h2 className="t-title">Start with one afternoon.</h2>
          <Start large />
        </div>
      </Stage>
    </div>
  );
}

function Stage({ at, children }: { at: number; children: ReactNode }) {
  const first = at === 0;
  const last = at === STAGES.length - 1;
  return (
    <section
      className={`ob-stage ${first ? 'is-first' : ''} ${last ? 'is-last' : ''}`}
      data-stage={at}
      style={{ '--hold': STAGES[at]!.hold, '--dwell': last ? 0 : DWELL } as CSSProperties}
    >
      <div className="ob-frame">{children}</div>
      {/* the middle of the still stretch after its scene: where the page settles if you stop near it */}
      <span className="ob-rest" aria-hidden="true" />
    </section>
  );
}

/**
 * The mark at scale. Unlit, the glow is ink with an ember inside it that the opening scene grows
 * to fill it (a clean change of colour, never a blend through a muddy middle); lit, it is the
 * point colour.
 */
function Mark({ lit = false }: { lit?: boolean }) {
  return (
    <svg className={`ob-mark ${lit ? 'is-lit' : ''}`} viewBox="0 0 256 256" aria-hidden="true">
      <g className="ob-flame">
        <path className="ob-glow" d={MARK_GLOW} />
        {!lit && <path className="ob-ember" d={MARK_GLOW} />}
      </g>
      <path className="ob-bowl" d={MARK_BOWL} />
    </svg>
  );
}

const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * One scrubbed timeline per stage, across the whole time it is on screen: 1 to arrive, its scene
 * while it holds the centre (0.8 for each unit of `hold`, the same scroll distance), `DWELL` with
 * nothing moving, 1 to leave.
 * Scrolling back plays it backwards. The scrub lags the scroll by a second, so even a fast scroll
 * shows the motion catching up rather than jumping to its end.
 */
function stageScenes() {
  const stages = gsap.utils.toArray<HTMLElement>('.ob-stage');

  stages.forEach((stage, i) => {
    const first = i === 0;
    const last = i === stages.length - 1;
    const obj = stage.querySelector('.ob-object')!;
    const span = (STAGES[i]?.hold ?? 1) * 0.8;
    const tl = gsap.timeline({
      defaults: { ease: 'none' },
      scrollTrigger: {
        trigger: stage,
        start: first ? 'top top' : 'top bottom',
        end: last ? 'bottom bottom' : 'bottom top',
        scrub: 1,
        invalidateOnRefresh: true,
      },
    });

    if (!first) {
      tl.fromTo(
        obj,
        { autoAlpha: 0, y: 90, scale: 0.94, filter: 'blur(14px)' },
        { autoAlpha: 1, y: 0, scale: 1, filter: 'blur(0px)', duration: 1, ease: 'power2.out' },
      );
    }
    const scene = SCENES[i]?.(gsap.utils.selector(stage));
    // every scene is written from 0 to 1; stretched here to the stage's hold
    if (scene) tl.add(scene.set({}, {}, 1).duration(span), first ? 0 : 1);
    if (!last) {
      tl.to(
        obj,
        { autoAlpha: 0, y: -70, scale: 0.97, filter: 'blur(14px)', duration: 1, ease: 'power2.in' },
        (first ? 0 : 1) + span + DWELL,
      );
    }
  });
}

type Q = (selector: string) => Element[];

/** what each object does while it holds the centre, from 0 to 1 */
const SCENES: ((q: Q) => gsap.core.Timeline)[] = [
  // the glow lifts out of the bowl and catches: an ember grows from its middle until it is lit
  (q) =>
    gsap
      .timeline({ defaults: { ease: 'power1.inOut' } })
      .to(q('.ob-flame'), { y: -58, duration: 1 }, 0)
      .to(q('.ob-glow, .ob-ember'), { morphSVG: VOICE_SHAPES[0]!, duration: 1 }, 0)
      .fromTo(
        q('.ob-ember'),
        { opacity: 1, scale: 0, transformOrigin: '50% 50%' },
        { scale: 1.03, duration: 0.7, ease: 'power2.inOut' },
        0.2,
      ),

  // the question is set down, and reads itself
  (q) => {
    const words = SplitText.create(q('.ob-question'), { type: 'words' }).words;
    return gsap
      .timeline({ defaults: { ease: 'none' } })
      .fromTo(
        q('.ob-slip'),
        { rotate: -6, y: 20 },
        { rotate: -1.5, y: 0, duration: 0.8, ease: 'power2.out' },
        0,
      )
      .fromTo(
        words,
        { opacity: 0.12 },
        { opacity: 1, stagger: 0.7 / words.length, duration: 0.2 },
        0.1,
      );
  },

  // two voices take turns: whoever is talking moves and comes forward, the strip fills behind
  (q) => {
    const tl = gsap.timeline({ defaults: { ease: 'none' } });
    const subs = q('.ob-sub');
    const pebble = (who: string) => q(`.ob-pv[data-who='${who}']`);
    const colour = { Theo: token('--graphite'), Nell: token('--voice') };
    // only the first answer shows until the scene starts; the rest take their turn
    gsap.set(subs.slice(1), { autoAlpha: 0 });
    gsap.set(pebble('Theo'), { scale: 0.82, opacity: 0.35 });
    tl.fromTo(q('.lpx-fill'), { scaleX: 0 }, { scaleX: 1, stagger: 0.09, duration: 0.1 }, 0);
    const part = 1 / ANSWERS.length;
    ANSWERS.forEach((turn, k) => {
      const at = k * part;
      const other = turn.who === 'Nell' ? 'Theo' : 'Nell';
      const words = SplitText.create(subs[k]!, { type: 'words' }).words;
      tl.set(subs[k]!, { autoAlpha: 1 }, at)
        .fromTo(
          words,
          { opacity: 0.1 },
          { opacity: 1, stagger: (part * 0.7) / words.length, duration: part * 0.15 },
          at,
        )
        .to(
          pebble(turn.who),
          { scale: 1, opacity: 1, duration: part * 0.2, ease: 'power2.out' },
          at,
        )
        .to(
          pebble(other),
          { scale: 0.82, opacity: 0.35, duration: part * 0.2, ease: 'power2.out' },
          at,
        )
        .to(
          pebble(turn.who).map((s) => s.firstElementChild!),
          { fill: colour[turn.who], duration: part * 0.2 },
          at,
        );
      for (let s = 0; s < 3; s++) {
        tl.to(
          pebble(turn.who).map((el) => el.firstElementChild!),
          {
            morphSVG: VOICE_SHAPES[(k * 2 + s + 1) % VOICE_SHAPES.length]!,
            duration: part * 0.28,
            ease: 'sine.inOut',
          },
          at + s * part * 0.28,
        );
      }
      if (k < ANSWERS.length - 1) tl.set(subs[k]!, { autoAlpha: 0 }, at + part * 0.98);
    });
    return tl;
  },

  // her words are marked; the first rises off the sheet and becomes a story as the sheet sinks back
  (q) => {
    const mark = q('.ob-transcript .lpx-mark')[0] as HTMLElement;
    const story = q('.ob-story')[0] as HTMLElement;
    const rise = () => {
      const m = mark.getBoundingClientRect();
      const s = story.getBoundingClientRect();
      return m.top + m.height / 2 - (s.top + s.height / 2) - Number(gsap.getProperty(story, 'y'));
    };
    const tl = gsap.timeline({ defaults: { ease: 'none' } });
    q('.ob-transcript .lpx-mark').forEach((m, k) =>
      tl.fromTo(
        m,
        { backgroundSize: '0% 100%' },
        { backgroundSize: '100% 100%', duration: 0.16, ease: 'power1.inOut' },
        0.04 + k * 0.2,
      ),
    );
    return tl
      .fromTo(q('.ob-cap-b'), { autoAlpha: 0 }, { autoAlpha: 0, duration: 0.01 }, 0)
      .fromTo(
        story,
        { y: rise, scale: 0.5, autoAlpha: 0 },
        { y: rise, scale: 0.5, autoAlpha: 1, duration: 0.04 },
        0.46,
      )
      .to(story, { y: 0, scale: 1, duration: 0.38, ease: 'power2.inOut' }, 0.5)
      .to(
        q('.ob-transcript'),
        {
          y: 70,
          scale: 0.9,
          autoAlpha: 0.1,
          filter: 'blur(6px)',
          duration: 0.38,
          ease: 'power2.inOut',
        },
        0.48,
      )
      .to(q('.ob-cap-a'), { autoAlpha: 0, duration: 0.08 }, 0.5)
      .to(q('.ob-cap-b'), { autoAlpha: 1, duration: 0.1 }, 0.6)
      .fromTo(
        q('.ob-story .lpx-own'),
        { autoAlpha: 0, y: 8 },
        { autoAlpha: 1, y: 0, duration: 0.1 },
        0.88,
      );
  },

  // the line draws, and the two stories drop onto their decades
  (q) =>
    gsap
      .timeline({ defaults: { ease: 'none' } })
      .fromTo(q('.ob-rod'), { drawSVG: '0%' }, { drawSVG: '100%', duration: 0.45 }, 0)
      .fromTo(
        q('.ob-decades li'),
        { autoAlpha: 0 },
        { autoAlpha: 1, stagger: 0.1, duration: 0.15 },
        0,
      )
      .fromTo(
        q('.ob-dot'),
        { scale: 0, y: -70 },
        { scale: 1, y: 0, stagger: 0.25, duration: 0.22, ease: 'power2.in' },
        0.42,
      )
      .fromTo(
        q('.ob-pin-title'),
        { autoAlpha: 0 },
        { autoAlpha: 1, stagger: 0.25, duration: 0.12 },
        0.62,
      ),

  // a question is typed and answered with its source; the second gets an honest no
  (q) =>
    gsap
      .timeline({ defaults: { ease: 'none' } })
      // each bubble appears as it starts to be typed, never empty
      .fromTo(q('.ob-q1'), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.01 }, 0.02)
      .fromTo(q('.ob-q1'), { text: '' }, { text: 'Where did Nell work?', duration: 0.25 }, 0.02)
      .fromTo(q('.ob-a1'), { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, duration: 0.15 }, 0.3)
      .fromTo(q('.ob-q2'), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.01 }, 0.52)
      .fromTo(q('.ob-q2'), { text: '' }, { text: 'Was she happy there?', duration: 0.22 }, 0.52)
      .fromTo(q('.ob-a2'), { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, duration: 0.15 }, 0.78),

  // the threads draw out from Nell to everyone she named
  (q) =>
    gsap
      .timeline({ defaults: { ease: 'none' } })
      .fromTo(
        q('.lpx-thread'),
        { drawSVG: '0%' },
        { drawSVG: '100%', stagger: 0.12, duration: 0.4 },
        0,
      )
      .fromTo(
        q('.lpx-node:not(.is-centre)'),
        { autoAlpha: 0, scale: 0.85 },
        { autoAlpha: 1, scale: 1, stagger: 0.12, duration: 0.25 },
        0.22,
      ),

  // the voice settles back into the bowl, still lit: the story is kept
  (q) =>
    gsap
      .timeline({ defaults: { ease: 'power2.inOut' } })
      .fromTo(q('.ob-flame'), { y: -58 }, { y: 0, duration: 0.8 }, 0)
      .fromTo(
        q('.ob-glow'),
        { morphSVG: VOICE_SHAPES[0]! },
        { morphSVG: MARK_GLOW, duration: 0.8 },
        0,
      ),
];
