import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { TextPlugin } from 'gsap/TextPlugin';
import { Brand, Icon } from '../components/ui';

gsap.registerPlugin(ScrollTrigger, TextPlugin);

/**
 * The first page, for someone who is not signed in. It shows the app working rather than
 * describing it: a conversation becomes memories in the speaker's own words, the memories land
 * on a timeline, a question is answered from them (or not at all), and the people in them link
 * up. Everything shown is an example archive, and the page says so.
 */

const LINES = [
  { who: 'Theo', text: 'Where did you work, back then?' },
  {
    who: 'Nell',
    text: 'At the telephone exchange.',
    hl: 'The board lit up like a Christmas tree.',
  },
  { who: 'Theo', text: 'Who sat next to you?' },
  { who: 'Nell', text: 'Dorothy.', hl: 'We passed notes along the board all night.' },
];

const MEMORIES = [
  {
    when: '1959',
    title: 'The board lit up like a Christmas tree',
    quote: 'The board lit up like a Christmas tree.',
  },
  {
    when: '~1960',
    title: 'Notes along the board',
    quote: 'We passed notes along the board all night.',
  },
];

const DECADES = ['1930s', '1940s', '1950s', '1960s', '1970s', '1980s'];

const GRAPH = [
  { label: 'Grandma Nell', x: 18, y: 9, kind: 'person' },
  { label: 'Park Point', x: 82, y: 8, kind: 'place' },
  { label: 'Summers at the bait shop', x: 20, y: 33, kind: 'story' },
  { label: 'Seattle', x: 82, y: 32, kind: 'place' },
  { label: 'Agnes', x: 50, y: 39, kind: 'person' },
];

export function Landing() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      const mm = gsap.matchMedia();

      mm.add('(prefers-reduced-motion: no-preference)', () => {
        heroLoop();
        askScene();
        graphScene();
        gsap.from('.lp-trust > div', {
          y: 24,
          opacity: 0,
          stagger: 0.12,
          duration: 0.6,
          ease: 'power2.out',
          scrollTrigger: { trigger: '.lp-trust', start: 'top 85%' },
        });
      });

      // no motion: every scene shown in its finished state
      mm.add('(prefers-reduced-motion: reduce)', () => {
        gsap.set('.lp-line, .lp-mem, .lp-dot, .lp-a1, .lp-a2, .lp-node', { opacity: 1, scale: 1 });
        gsap.set('.lp-hl', { backgroundSize: '100% 100%' });
        gsap.set('.lp-q1', { text: 'Where did Nell work?' });
        gsap.set('.lp-q2', { text: 'Was she happy there?' });
        gsap.set('.lp-edge', { strokeDashoffset: 0 });
      });
    }, root);
    return () => ctx.revert();
  }, []);

  return (
    <div ref={root} className="lp">
      <title>Firepit — keep their stories, in their own words</title>
      <header className="public-header">
        <Brand />
        <div className="row">
          <Link to="/sign-in" className="btn btn-quiet" style={{ color: 'var(--ink)' }}>
            Sign in
          </Link>
          <Link to="/sign-in" className="btn btn-primary" data-testid="get-started">
            Get started
          </Link>
        </div>
      </header>

      <section className="lp-hero">
        <h1 className="display">Their stories, in their own words.</h1>
        <Link to="/sign-in" className="btn btn-primary btn-lg">
          Start a project
        </Link>

        <div
          className="lp-stage"
          role="img"
          aria-label="An example conversation becoming memories on a timeline"
        >
          <div className="lp-panel lp-transcript" aria-hidden="true">
            <span className="lp-panel-label">
              <span className="lp-rec" /> Conversation
            </span>
            {LINES.map((l, i) => (
              <p key={i} className="lp-line">
                <b>{l.who}</b> {l.text}
                {l.hl && (
                  <>
                    {' '}
                    <span className="lp-hl">{l.hl}</span>
                  </>
                )}
              </p>
            ))}
          </div>

          <div className="lp-arrow" aria-hidden="true">
            <Icon name="next" size={20} stroke={2.4} />
          </div>

          <div className="lp-panel lp-memories" aria-hidden="true">
            <span className="lp-panel-label">Memories</span>
            {MEMORIES.map((m) => (
              <div key={m.title} className="lp-mem">
                <span className="lp-when">{m.when}</span>
                <span className="lp-mem-title">{m.title}</span>
                <span className="lp-mem-quote">“{m.quote}”</span>
                <span className="pill pill-sage">Nell’s own words</span>
              </div>
            ))}
          </div>

          <ol className="lp-decades" aria-hidden="true">
            {DECADES.map((d) => (
              <li key={d}>
                <span className="lp-dots">
                  {d === '1950s' && <span className="lp-dot" />}
                  {d === '1960s' && <span className="lp-dot" />}
                </span>
                <span className="lp-bar" />
                <span className="lp-decade">{d}</span>
              </li>
            ))}
          </ol>
        </div>
        <p className="small muted">An example project.</p>
      </section>

      <section className="lp-scene">
        <h2 className="lp-word">Ask.</h2>
        <div className="lp-ask" role="img" aria-label="Two questions asked of the example project">
          <div className="ask-box" aria-hidden="true">
            <span className="lp-typed lp-q1" />
            <span className="icon-btn lp-send">
              <Icon name="arrowUp" size={16} stroke={2.4} />
            </span>
          </div>
          <div className="card lp-a1" aria-hidden="true">
            <p>
              At the telephone exchange, from 1959.{' '}
              <span className="quote">“The board lit up like a Christmas tree.”</span>
            </p>
            <span className="pill pill-sage lp-src">
              The board lit up like a Christmas tree · 1959
            </span>
          </div>
          <div className="ask-box" aria-hidden="true">
            <span className="lp-typed lp-q2" />
            <span className="icon-btn lp-send">
              <Icon name="arrowUp" size={16} stroke={2.4} />
            </span>
          </div>
          <div className="lp-a2" aria-hidden="true">
            <b>Not in the records.</b> Nothing Nell said answers this.
          </div>
        </div>
      </section>

      <section className="lp-scene">
        <h2 className="lp-word">Everyone, connected.</h2>
        <div
          className="lp-graph"
          role="img"
          aria-label="Uncle Joe linked to Grandma Nell, Park Point, Seattle, Agnes and a story"
        >
          <svg viewBox="0 0 100 42" aria-hidden="true">
            {GRAPH.map((n) => (
              <path
                key={n.label}
                className="lp-edge"
                pathLength={1}
                d={`M50 21 C ${(50 + n.x) / 2} 21, ${(50 + n.x) / 2} ${n.y}, ${n.x} ${n.y}`}
              />
            ))}
          </svg>
          <span
            className="lp-node lp-center"
            style={{ left: '50%', top: '50%' }}
            aria-hidden="true"
          >
            Uncle Joe
          </span>
          {GRAPH.map((n) => (
            <span
              key={n.label}
              className={`lp-node lp-${n.kind}`}
              style={{ left: `${n.x}%`, top: `${(n.y / 42) * 100}%` }}
              aria-hidden="true"
            >
              {n.label}
            </span>
          ))}
        </div>
      </section>

      <section className="lp-trust">
        {[
          { icon: 'person' as const, label: 'Members only' },
          { icon: 'check' as const, label: 'Never sold or trained on' },
          { icon: 'timeline' as const, label: 'Nothing overwritten' },
        ].map((t) => (
          <div key={t.label}>
            <span className="lp-trust-icon">
              <Icon name={t.icon} size={18} />
            </span>
            {t.label}
          </div>
        ))}
      </section>

      <section className="lp-final">
        <h2 className="h-section">Start with one afternoon.</h2>
        <Link to="/sign-in" className="btn btn-primary btn-lg">
          Get started
        </Link>
      </section>

      <footer className="footer">
        <div className="footer-inner">
          <span>Firepit</span>
          <span>Terms · Privacy</span>
        </div>
      </footer>
    </div>
  );
}

/** The hero: the conversation types itself in, her words light up and become memories on the timeline. */
function heroLoop() {
  const lines = gsap.utils.toArray<HTMLElement>('.lp-line');
  const mems = gsap.utils.toArray<HTMLElement>('.lp-mem');
  const dots = gsap.utils.toArray<HTMLElement>('.lp-dot');

  const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.6, defaults: { ease: 'power2.out' } });
  tl.set(lines, { opacity: 0, clipPath: 'inset(0 100% 0 0)' })
    .set('.lp-hl', { backgroundSize: '0% 100%' })
    .set(mems, { opacity: 0, x: -24, scale: 0.96 })
    .set(dots, { scale: 0, opacity: 0 });

  let told = 0;
  lines.forEach((line, i) => {
    tl.to(
      line,
      { opacity: 1, clipPath: 'inset(0 0% 0 0)', duration: 0.9, ease: 'none' },
      i === 0 ? 0.3 : '+=0.25',
    );
    const hl = line.querySelector('.lp-hl');
    if (!hl) return;
    tl.to(hl, { backgroundSize: '100% 100%', duration: 0.5 })
      .to('.lp-arrow', { x: 6, color: 'var(--sage)', duration: 0.2, yoyo: true, repeat: 1 }, '<')
      .to(mems[told] ?? [], { opacity: 1, x: 0, scale: 1, duration: 0.6 }, '-=0.1')
      .to(dots[told] ?? [], { opacity: 1, scale: 1, duration: 0.4, ease: 'back.out(3)' }, '-=0.2');
    told += 1;
  });
  tl.to({}, { duration: 2.4 }).to([lines, mems, dots], {
    opacity: 0,
    duration: 0.5,
    ease: 'power1.in',
  });
}

/** Ask: a question types itself, the answer arrives with its quote and source; a second is declined. */
function askScene() {
  const tl = gsap.timeline({
    defaults: { ease: 'power2.out' },
    scrollTrigger: { trigger: '.lp-ask', start: 'top 75%', toggleActions: 'play none none reset' },
  });
  tl.set('.lp-q1, .lp-q2', { text: '' })
    .set('.lp-a1, .lp-a2', { opacity: 0, y: 16 })
    .set('.lp-src', { opacity: 0, scale: 0.9 })
    .to('.lp-q1', { text: 'Where did Nell work?', duration: 1.1, ease: 'none' })
    .to('.lp-ask .lp-send', { scale: 0.85, duration: 0.12, yoyo: true, repeat: 1 })
    .to('.lp-a1', { opacity: 1, y: 0, duration: 0.6 })
    .to('.lp-src', { opacity: 1, scale: 1, duration: 0.4, ease: 'back.out(2)' })
    .to('.lp-q2', { text: 'Was she happy there?', duration: 1, ease: 'none' }, '+=0.6')
    .to('.lp-a2', { opacity: 1, y: 0, duration: 0.6 }, '+=0.3');
}

/** People: the links draw out from one name, and the names they reach appear. */
function graphScene() {
  const tl = gsap.timeline({
    defaults: { ease: 'power2.out' },
    scrollTrigger: {
      trigger: '.lp-graph',
      start: 'top 75%',
      toggleActions: 'play none none reset',
    },
  });
  tl.set('.lp-edge', { strokeDashoffset: 1 })
    .set('.lp-node', { opacity: 0, scale: 0.6 })
    .to('.lp-center', { opacity: 1, scale: 1, duration: 0.5, ease: 'back.out(2)' })
    .to('.lp-edge', { strokeDashoffset: 0, duration: 0.8, stagger: 0.12, ease: 'power1.inOut' })
    .to(
      '.lp-node:not(.lp-center)',
      { opacity: 1, scale: 1, duration: 0.45, stagger: 0.12, ease: 'back.out(2)' },
      '-=0.7',
    );
}
