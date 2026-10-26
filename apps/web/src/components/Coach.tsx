import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { coachSuggest, type CoachSuggestion } from '../lib/api';
import type { Setup } from '../lib/interview';
import type { Segment } from '../lib/live';
import { wordCount } from '../lib/listen';
import {
  CLOSING,
  fill,
  PROBE_ORDER,
  PROBES,
  THANKS,
  TIPS,
  TOPICS,
  topicOrder,
} from '../lib/questions';
import { Icon } from './ui';

type Move = CoachSuggestion['move'];

/** the question the interviewer is on: what was asked, and where it came from */
interface Ask {
  question: string;
  move: Move | 'open' | 'own' | 'thanks';
}

/** a suggested next move, and the length of the transcript when it was asked for */
interface Offer {
  s: CoachSuggestion;
  at: number;
  /** the interviewer asked for this move: show it at once, no pause needed */
  chosen: boolean;
  /** it has been on screen: it stays there, even while the interviewer reads it aloud */
  shown?: boolean;
  from: 'ai' | 'bank';
}

/** the narrator has answered once they have said this much */
const ANSWERED_WORDS = 8;
/** seconds of quiet before asking for a suggestion (it is ready by the time it is shown) */
const FETCH_AFTER = 1.5;
/** seconds of quiet before showing it: the silent question comes first */
const SHOW_AFTER = 4;
/** never more often than this, whatever happens */
const MIN_GAP_MS = 8000;

const MOVE_LABEL: Record<Move, string> = {
  wait: 'Wait',
  follow_up: 'Follow up',
  change_topic: 'Change topic',
  break: 'Take a break',
  close: 'Close the interview',
};

const reduceMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The interview itself. After each answer the coach suggests the interviewer's next move, the way
 * an oral historian would: give it a moment first (the silent question), then follow up on what
 * was just said, change the topic or go back to something mentioned earlier, suggest a break, or
 * close with a reflective question and thanks. The suggestion is written by an AI from the
 * narrator's own words (server/api/src/interview-coach.ts), with a question bank to fall back on.
 * Nothing moves on by itself: the interviewer asks, and the coach notices.
 */
export function Coach({
  archiveId,
  call,
  interviewer,
  setup,
  segments,
  partials,
  labels,
  quiet,
  elapsed,
  onEnding,
}: {
  archiveId: string;
  /** the narrator, as they called themselves */
  call: string;
  interviewer: string;
  setup: Setup;
  segments: Segment[];
  partials: Array<{ speaker: string; text: string }>;
  labels: Map<string, string>;
  quiet: number;
  elapsed: () => number;
  /** the interview has reached its thanks: the End button should stand out */
  onEnding: (on: boolean) => void;
}) {
  const order = topicOrder(setup.topics);
  const [opened, setOpened] = useState<string[]>(() => (order[0] ? [order[0].id] : []));
  const [current, setCurrent] = useState<Ask>(() => ({
    question: order[0]?.opener ?? 'Tell me about your life.',
    move: 'open',
  }));
  const [qFrom, setQFrom] = useState(segments.length);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [threads, setThreads] = useState<string[]>([]);
  const [asked, setAsked] = useState<string[]>(() => (order[0] ? [order[0].opener] : []));
  const [followUps, setFollowUps] = useState(0);
  const [closing, setClosing] = useState<'no' | 'asked' | 'thanks'>('no');
  const [picking, setPicking] = useState(false);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const lastAt = useRef({ seg: -1, time: 0 });
  const aiDownUntil = useRef(0);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
      inFlight.current?.abort();
    },
    [],
  );

  /* ── who is speaking, and how far the answer has got ────── */
  const narratorVoices = Object.entries(setup.voices)
    .filter(([, id]) => setup.people.find((p) => p.id === id)?.role === 'teller')
    .map(([v]) => v);
  const known = narratorVoices.length > 0;
  const isNarrator = (sp: string) => (known ? narratorVoices.includes(sp) : true);
  const after = segments.slice(qFrom);
  // asked: the interviewer has spoken since this question came up (with no voices known, anyone)
  const askedIdx = known
    ? after.findIndex((s) => !isNarrator(s.speaker) && wordCount(s.text) >= 3)
    : after.length
      ? 0
      : -1;
  const answer = askedIdx < 0 ? [] : after.slice(askedIdx + 1).filter((s) => isNarrator(s.speaker));
  const answerWords = answer.reduce((n, s) => n + wordCount(s.text), 0);
  const answered = answerWords >= ANSWERED_WORDS;
  const narratorTalking = partials.some((p) => isNarrator(p.speaker));
  // the narrator went on after the suggestion was made: it no longer fits
  const stale =
    !!offer &&
    !offer.chosen &&
    segments.slice(offer.at).some((s) => isNarrator(s.speaker) && wordCount(s.text) >= 4);
  const showing = !!offer && !stale && (offer.chosen || !!offer.shown || quiet >= SHOW_AFTER);
  useEffect(() => {
    if (offer && showing && !offer.shown) setOffer({ ...offer, shown: true });
  });
  const minutes = elapsed() / 60;

  /* ── a new question asked: the interviewer spoke after an answer ── */
  useEffect(() => {
    if (!answered) return;
    // where the narrator last spoke: a new question is the interviewer speaking after that
    let lastAnswer = qFrom + askedIdx;
    for (let i = lastAnswer + 1; i < segments.length; i++)
      if (isNarrator(segments[i]!.speaker)) lastAnswer = i;
    const next = segments.findIndex(
      (s, i) => i > lastAnswer && !isNarrator(s.speaker) && wordCount(s.text) >= 3,
    );
    if (next < 0) return;
    // what they asked: the suggestion on screen if there was one, else their own question
    // the move is the suggestion's when one was on screen; the question is what was really said
    const used = showing && offer && offer.s.move !== 'wait' ? offer.s : null;
    const question = segments[next]!.text;
    const move: Ask['move'] = used ? used.move : 'own';
    setCurrent({ question, move });
    setAsked((a) => [...a, question].slice(-30));
    setQFrom(next);
    setOffer(null);
    setPicking(false);
    if (move === 'follow_up' || move === 'own') setFollowUps((n) => n + 1);
    if (move === 'change_topic') setFollowUps(0);
    if (move === 'close') setClosing('asked');
  }, [segments.length]);

  /* ── asking for the next move ───────────────────────────── */
  function bank(want: Exclude<Move, 'wait'> | null): CoachSuggestion {
    const fallback = 'From the question bank (AI suggestions unavailable)';
    if (want === 'close' || (!want && minutes >= 75)) {
      return {
        move: 'close',
        kind: 'reflect',
        question: CLOSING[0]!,
        reason: 'A reflective question to close',
        threads: [],
        topic: null,
      };
    }
    if (want === 'change_topic' || (!want && followUps >= 3)) {
      const t = order.find((x) => !opened.includes(x.id));
      if (t)
        return {
          move: 'change_topic',
          kind: null,
          question: t.opener,
          reason: fallback,
          threads: [],
          topic: t.label,
        };
      if (threads[0]) {
        return {
          move: 'change_topic',
          kind: null,
          question: `Earlier you mentioned ${threads[0]}. Tell me more about that.`,
          reason: 'Going back to something they mentioned',
          threads: [],
          topic: threads[0],
        };
      }
    }
    const kind = PROBE_ORDER[followUps % PROBE_ORDER.length]!;
    const options = PROBES[kind];
    return {
      move: 'follow_up',
      kind,
      question: options[followUps % options.length]!,
      reason: fallback,
      threads: [],
      topic: null,
    };
  }

  function request(want: Exclude<Move, 'wait'> | null) {
    inFlight.current?.abort();
    const at = segments.length;
    lastAt.current = { seg: at, time: Date.now() };
    const chosen = want !== null;
    if (Date.now() < aiDownUntil.current) {
      setOffer({ s: bank(want), at, chosen, from: 'bank' });
      return;
    }
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    setLoading(true);
    const transcript = segments
      .slice(-120)
      .map((s) => ({ who: labels.get(s.speaker) ?? 'Someone', text: s.text }));
    coachSuggest(
      archiveId,
      {
        narrator: call,
        interviewer: interviewer || null,
        topics: order.map((t) => t.label),
        minutes: Math.round(minutes),
        transcript,
        threads,
        asked,
        want,
      },
      ctrl.signal,
    )
      .then((s) => {
        if (!live.current || ctrl.signal.aborted) return;
        setOffer({ s, at, chosen, from: 'ai' });
        if (s.threads.length) setThreads((t) => [...new Set([...t, ...s.threads])].slice(-8));
      })
      .catch(() => {
        if (!live.current || ctrl.signal.aborted) return;
        // no AI for a minute: the question bank stands in
        aiDownUntil.current = Date.now() + 60_000;
        setOffer({ s: bank(want), at, chosen, from: 'bank' });
      })
      .finally(() => {
        if (inFlight.current === ctrl) inFlight.current = null;
        if (live.current) setLoading(false);
      });
  }

  // after an answer and a short pause, ask quietly, so it is ready when the pause has lasted
  useEffect(() => {
    if (closing === 'thanks' || !answered || narratorTalking || quiet < FETCH_AFTER) return;
    if (inFlight.current || (offer && !stale)) return;
    if (segments.length <= lastAt.current.seg || Date.now() - lastAt.current.time < MIN_GAP_MS)
      return;
    if (closing === 'asked') {
      // the closing question has been answered: all that is left is to say thank you
      setOffer({
        s: {
          move: 'close',
          kind: null,
          question: fill(THANKS, call),
          reason: 'Then end the recording',
          threads: [],
          topic: null,
        },
        at: segments.length,
        chosen: false,
        from: 'bank',
      });
      setClosing('thanks');
      onEnding(true);
      return;
    }
    request(null);
  });

  // each new suggestion arrives, rather than replacing the last
  const card = useRef<HTMLDivElement>(null);
  const offerKey = showing ? offer!.s.question : current.question;
  useLayoutEffect(() => {
    if (!card.current || reduceMotion()) return;
    gsap.fromTo(
      card.current,
      { opacity: 0, y: 10, filter: 'blur(3px)' },
      { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.5, ease: 'power3.out' },
    );
  }, [offerKey]);

  /* ── what the card says ─────────────────────────────────── */
  const waitNote = showing && offer!.s.move === 'wait';
  const big = showing && !waitNote ? offer!.s.question : current.question;
  const state = showing
    ? waitNote
      ? 'wait'
      : 'offer'
    : askedIdx < 0
      ? 'ask'
      : narratorTalking || !answered || quiet < 1
        ? 'listening'
        : 'moment';
  const eyebrow = {
    ask: current.move === 'open' ? `Begin with an open question for ${call}` : `Ask ${call}`,
    listening: `Listening to ${call}`,
    moment: 'Give it a moment…',
    wait: 'Wait',
    offer: `Suggested next · ${MOVE_LABEL[offer?.s.move ?? 'follow_up']}`,
  }[state];
  const suggested = showing ? offer!.s.move : null;

  const remaining = order.filter((t) => !opened.includes(t.id));
  function choose(question: string, topicId: string | null, reason: string) {
    if (topicId) setOpened((o) => [...o, topicId]);
    setOffer({
      s: { move: 'change_topic', kind: null, question, reason, threads: [], topic: null },
      at: segments.length,
      chosen: true,
      from: 'bank',
    });
    setPicking(false);
  }

  return (
    <>
      <section className="assist-card coach-card" aria-live="polite">
        <div className="assist-inner" ref={card}>
          <div className="assist-step">
            <span>Interview{order.length ? ` · ${order.map((t) => t.label).join(', ')}` : ''}</span>
            {loading && <span className="coach-thinking">Thinking…</span>}
          </div>

          <span className="assist-eyebrow coach-eyebrow" data-state={state}>
            {(state === 'listening' || state === 'moment') && (
              <span className="assist-pulse" aria-hidden="true" />
            )}
            {eyebrow}
          </span>
          <h2
            className="assist-prompt assist-question"
            data-dim={state === 'listening' || state === 'moment'}
          >
            {fill(big, call)}
          </h2>
          {waitNote && <p className="coach-reason">{offer!.s.question}</p>}
          {showing && !waitNote && offer!.s.reason && (
            <p className="coach-reason">
              <span className="coach-source">{offer!.from === 'ai' ? 'AI' : 'Bank'}</span>
              {offer!.s.reason}
            </p>
          )}
          {state === 'ask' && current.move === 'open' && (
            <p className="coach-reason">Read it out, then let {call} take it wherever they like.</p>
          )}

          <div className="coach-moves" role="group" aria-label="Next move">
            <MoveButton
              label="Follow up"
              icon="pen"
              on={suggested === 'follow_up'}
              onClick={() => (suggested === 'follow_up' ? undefined : request('follow_up'))}
            />
            <MoveButton
              label="Change topic"
              icon="next"
              on={suggested === 'change_topic'}
              onClick={() => setPicking((p) => !p)}
            />
            <MoveButton
              label={closing === 'no' ? 'Close' : 'Closing'}
              icon="stop"
              on={suggested === 'close' || suggested === 'break'}
              onClick={() => request('close')}
            />
          </div>

          {picking && (
            <div className="coach-topics">
              {offer?.s.move === 'change_topic' && (
                <button
                  type="button"
                  className="chip"
                  aria-pressed="true"
                  onClick={() => setPicking(false)}
                >
                  Suggested: {offer.s.topic ?? 'next topic'}
                </button>
              )}
              {threads.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="chip coach-thread"
                  onClick={() =>
                    choose(
                      `Earlier you mentioned ${t}. Tell me more about that.`,
                      null,
                      'Going back to something they mentioned',
                    )
                  }
                >
                  ↩ {t}
                </button>
              ))}
              {remaining.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="chip"
                  onClick={() => choose(t.opener, t.id, `On to ${t.label.toLowerCase()}`)}
                >
                  {t.label}
                </button>
              ))}
              {TOPICS.filter((t) => !order.includes(t) && !opened.includes(t.id)).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="chip coach-extra"
                  onClick={() => choose(t.opener, t.id, `On to ${t.label.toLowerCase()}`)}
                >
                  + {t.label}
                </button>
              ))}
            </div>
          )}

          <p className="coach-privacy">
            Suggestions use AI: the recent words go to NVIDIA to write them, and are not stored.
          </p>
        </div>
      </section>

      <aside className="assist-aside">
        <section className="assist-next">
          <h3 className="label-heading">To come back to</h3>
          {threads.length ? (
            <ul className="coach-threads">
              {threads.map((t) => (
                <li key={t}>
                  <button
                    type="button"
                    onClick={() =>
                      choose(
                        `Earlier you mentioned ${t}. Tell me more about that.`,
                        null,
                        'Going back to something they mentioned',
                      )
                    }
                  >
                    {t}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">Things {call} mentions in passing collect here.</p>
          )}
        </section>
        <div className="stack" style={{ gap: 10 }}>
          {minutes >= 60 && (
            <p className="coach-time" data-strong={minutes >= 75}>
              {minutes >= 75
                ? `${Math.floor(minutes)} minutes. Think about closing soon; ${call} may be tiring.`
                : 'An hour in. Watch for tiredness: sixty to ninety minutes is a good length.'}
            </p>
          )}
          <Tip />
        </div>
      </aside>
    </>
  );
}

function MoveButton({
  label,
  icon,
  on,
  onClick,
}: {
  label: string;
  icon: 'pen' | 'next' | 'stop';
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={on ? 'btn btn-primary' : 'btn btn-outline'}
      aria-pressed={on}
      onClick={onClick}
    >
      <Icon name={icon} size={14} />
      {label}
    </button>
  );
}

function Tip() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % TIPS.length), 40_000);
    return () => clearInterval(id);
  }, []);
  return (
    <p className="assist-tip" key={i}>
      <span className="label-heading">Tip</span>
      {TIPS[i]}
    </p>
  );
}
