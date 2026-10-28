import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { callName } from '../lib/keyterms';
import { gsap } from 'gsap';
import { Flip } from 'gsap/Flip';
import {
  linesNearNotes,
  noteTerms,
  respell,
  resolveVoices,
  speakerLabels,
  writeDraft,
  type Draft,
  type Mode,
  type Note,
  type Person,
  type Respelling,
  type Setup,
  type StartFailure,
} from '../lib/interview';
import type { LiveStatus, Segment } from '../lib/live';
import { coachSuggest, interviewCorrections, interviewTopics } from '../lib/api';
import { asks, nameIn, sameName, topicsIn, wordCount } from '../lib/listen';
import { labelScript, TOPICS } from '../lib/questions';
import { useRecording } from '../lib/useRecording';
import { Coach } from './Coach';
import { Notes } from './Notes';
import { FloatingTranscript } from './FloatingTranscript';
import { Avatar, Icon } from './ui';
import { Clock, Level } from './Transcript';

gsap.registerPlugin(Flip);

const STATUS: Record<LiveStatus, string> = {
  connecting: 'Connecting',
  live: 'Recording',
  paused: 'Paused',
  reconnecting: 'Reconnecting…',
  stopping: 'Finishing the last words…',
  stopped: 'Stopped',
};

type Phase = 'hello' | 'about' | 'label' | 'interview';

/**
 * seconds of quiet after Firepit has what it needs to finish a setup step, before it moves on by
 * itself (counted from SETTLE_FROM). Setup only: once the interview begins, nothing moves on
 * without the interviewer. Quiet is measured from when the last words were SAID, not from when
 * the transcription came back (a second or more later), so this is real silence in the room.
 */
const SETTLE = 1.5;
/** longer while people introduce themselves: there is a pause before each next one speaks */
const SETTLE_HELLO = 2.5;
const SETTLE_FROM = 0.5;
/** words still being worked out that are this short ("mm-hm", "yes") do not break a silence */
const NOT_TALK_WORDS = 3;
/** the answer to "what would you like to talk about?" has been given once it is this long */
const ABOUT_WORDS = 5;
/** the opening label has been read once the interviewer has said this much */
const LABEL_WORDS = 10;

const reduceMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The interview assistant. It leads: it asks the room to introduce themselves and learns each
 * voice's name from what is said, asks what today is about and picks the topics out of the
 * answer, then suggests one question at a time, noticing when it has been asked and when it
 * has been answered. Everything it does by listening can also be done by a click. The words
 * themselves sit in a small floating box; this page is about what to say next.
 */
export function Studio({
  archiveId,
  name,
  interviewer,
  mode,
  startedAt,
  flipFrom,
  onEnd,
  project = null,
}: {
  archiveId: string;
  /** the person being interviewed */
  name: string;
  /** a family project's name, when the person is one of its family */
  project?: string | null;
  interviewer: string;
  mode: Mode;
  startedAt: string;
  flipFrom: Flip.FlipState | null;
  /** `audio` is each source's whole recording, for the second transcription at the end */
  onEnd: (d: Draft, failed: StartFailure | null, audio: Blob[]) => void;
}) {
  const [setup, setSetup] = useState<Setup>(() => ({
    about: '',
    topics: [],
    people: [
      { id: 'teller', name, role: 'teller' },
      ...(interviewer ? [{ id: 'asker', name: interviewer, role: 'asker' as const }] : []),
    ],
    // on a call the two channels already say who is who
    voices: (mode === 'call' ? { mic: 'asker', call: 'teller' } : {}) as Record<string, string>,
  }));
  const [phase, setPhase] = useState<Phase>(mode === 'call' ? 'about' : 'hello');
  const [phaseFrom, setPhaseFrom] = useState(0);
  const setupRef = useRef(setup);
  setupRef.current = setup;
  const [notes, setNotes] = useState<Note[]>([]);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  // what the notes showed the transcript mishears, made right everywhere from then on
  const [respellings, setRespellings] = useState<Respelling[]>([]);
  const respellRef = useRef(respellings);
  respellRef.current = respellings;
  const failure = useRef<StartFailure | null>(null);
  const ended = useRef(false);

  const draft = (): Draft => ({
    mode,
    startedAt,
    segments: recording.rec?.segments ?? [],
    setup: setupRef.current,
    notes: notesRef.current,
    keyterms: [...(recording.rec?.keyterms ?? [])],
    respell: respellRef.current,
  });

  /**
   * A new note with a name or acronym in it is checked at once against what was just said: if
   * the transcript misheard it ("THCL" for "NLCS"), the coach and the transcript use the notes'
   * spelling from here on.
   */
  function changeNotes(next: Note[]) {
    const added = next.length > notes.length ? next[next.length - 1] : undefined;
    setNotes(next);
    if (!added || noteTerms([added.text]).length === 0) return;
    const lines = linesNearNotes([added], segments);
    if (lines.length === 0) return;
    interviewCorrections(archiveId, { notes: next.map((n) => n.text), lines })
      .then(({ fixes }) =>
        setRespellings((r) => {
          const out = [...r];
          for (const { from, to } of fixes)
            if (!out.some((x) => x.from === from)) out.push({ from, to });
          return out;
        }),
      )
      .catch(() => undefined);
  }
  const recording = useRecording({
    archiveId,
    subjectName: name,
    mode,
    onWords: () => writeDraft(archiveId, draft()),
    onFail: (f) => {
      failure.current = f;
      void finish();
    },
  });
  const rec = recording.rec;
  const segments = rec?.segments ?? [];
  const partials = (rec?.partials ?? []).filter((p) => p !== null);

  async function finish() {
    if (ended.current) return;
    ended.current = true;
    const audio = await recording.finish();
    const d = draft();
    writeDraft(archiveId, d);
    onEnd(d, failure.current, audio);
  }

  useEffect(() => writeDraft(archiveId, draft()), [setup, notes, respellings]);

  // Wake the coach's model while setup goes on. On NVIDIA's free service the first call after a
  // quiet spell takes up to nine seconds (measured), every later one about one; without this the
  // first suggestion of every interview would miss its pause. The answer is not used.
  useEffect(() => {
    const ctrl = new AbortController();
    coachSuggest(
      archiveId,
      {
        narrator: name,
        interviewer: interviewer || null,
        topics: [],
        minutes: 0,
        transcript: [{ who: interviewer || 'Interviewer', text: 'Tell me about your childhood.' }],
        threads: [],
        asked: [],
      },
      ctrl.signal,
    ).catch(() => undefined);
    return () => ctrl.abort();
  }, []);

  // the names of the people in the room, and the names and acronyms in the notes, for Deepgram
  // to spell right from here on
  const peopleKey = setup.people.map((p) => p.call ?? p.name).join('|');
  const terms = noteTerms(notes.map((n) => n.text));
  const termsKey = terms.join('|');
  useEffect(() => {
    recording.addNames(setup.people.flatMap((p) => [p.name, p.call ?? '']).filter(Boolean), terms);
  }, [peopleKey, termsKey]);

  /* ── quiet: how long since anyone said anything ───────── */
  // A finished sentence comes back a second or more after it was said; its own end time says
  // when the talking stopped. Words still being worked out mean someone is talking now, unless
  // they are only an "mm-hm".
  const lastSound = useRef(performance.now());
  const talking = partials.filter((p) => wordCount(p.text) >= NOT_TALK_WORDS);
  const soundKey = `${segments.length}:${talking.map((p) => p.text).join('|')}`;
  useEffect(() => {
    const now = performance.now();
    const last = segments[segments.length - 1];
    const heardAt =
      talking.length > 0 || !last || !rec
        ? now
        : now - Math.max(0, rec.elapsed() - last.end) * 1000;
    lastSound.current = Math.min(now, Math.max(lastSound.current, heardAt));
  }, [soundKey]);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);
  const quiet = (performance.now() - lastSound.current) / 1000;
  const [held, setHeld] = useState(false);

  function goTo(p: Phase) {
    setPhase(p);
    setPhaseFrom(segments.length);
    setHeld(false);
  }

  const since = segments.slice(phaseFrom);
  const teller = setup.people.find((p) => p.role === 'teller')!;
  // what the coach calls them: their given name, never the surname alone
  const call = teller.call ?? callName(teller.name);

  /* ── hello: learn who is here from what they say ──────── */
  useEffect(() => {
    if (phase !== 'hello') return;
    // the finished sentences, and what is still being said: a name is caught as it is spoken
    setSetup((s) => learnNames(s, [...since, ...partials], name, interviewer));
  }, [phase, segments.length, partials.map((p) => p.text).join('|')]);

  /* ── about: pick the topics out of the answer ─────────── */
  // The AI reads the topics out of the interviewer's own words, whatever they are ("his years at
  // NLCS"); the bank's word lists stand in when it cannot be reached. Nothing named, as in "her
  // life in general", is a life story: the whole bank, in order.
  const [dismissed, setDismissed] = useState<string[]>([]);
  const aboutSaid = since.map((s) => s.text).join(' ');
  const aboutWords = wordCount(aboutSaid);
  useEffect(() => {
    if (phase !== 'about') return;
    const heard = topicsIn(aboutSaid).filter((t) => !dismissed.includes(t));
    setSetup((s) => ({
      ...s,
      topics: [...new Set([...s.topics, ...heard])],
      about: s.about || firstSentence(since[0]?.text ?? ''),
    }));
  }, [phase, segments.length]);
  const [reading, setReading] = useState<string | null>(null);
  const [read, setRead] = useState('');
  const [removedFree, setRemovedFree] = useState<string[]>([]);
  useEffect(() => {
    if (phase !== 'about' || aboutWords < ABOUT_WORDS || quiet < SETTLE_FROM) return;
    if (reading !== null || read === aboutSaid) return;
    const asked = aboutSaid;
    setReading(asked);
    interviewTopics(archiveId, { narrator: name, about: asked })
      .then(({ topics }) =>
        setSetup((s) => ({
          ...s,
          free: topics.filter((t) => !removedFree.includes(t.label)),
          // the AI's topics replace the word lists' guesses, which it has read the same words for
          topics: topics.length ? s.topics.filter((id) => !topicsIn(asked).includes(id)) : s.topics,
        })),
      )
      .catch(() => undefined)
      .finally(() => {
        setRead(asked);
        setReading(null);
      });
  });

  /* ── when to move on by itself ────────────────────────── */
  const bound = setup.people.filter((p) => Object.values(setup.voices).includes(p.id));
  const free = setup.free ?? [];
  // the audio label: who is speaking, when, and who is being interviewed, read by the interviewer
  const script = labelScript(
    setup.people.find((p) => p.role === 'asker')?.call ?? interviewer,
    name,
    [
      ...free.map((t) => t.label),
      ...TOPICS.filter((t) => setup.topics.includes(t.id)).map((t) => t.label),
    ],
    project,
  );
  // the interviewer's voice, once known; until then anyone's words count
  const askerVoices = Object.entries(setup.voices)
    .filter(([, id]) => setup.people.find((p) => p.id === id)?.role === 'asker')
    .map(([v]) => v);
  const byAsker = (s: Segment) => askerVoices.length === 0 || askerVoices.includes(s.speaker);
  const ready =
    phase === 'hello'
      ? bound.some((p) => p.role === 'teller') && bound.length >= Math.min(2, setup.people.length)
      : phase === 'about'
        ? // any answer will do: what it names is read out of it, and nothing named is a life story
          (setup.topics.length > 0 || free.length > 0 || aboutWords >= ABOUT_WORDS) &&
          reading === null
        : phase === 'label'
          ? since.some((s) => asks(s.text, script)) ||
            wordCount(
              since
                .filter(byAsker)
                .map((s) => s.text)
                .join(' '),
            ) >= LABEL_WORDS
          : false;
  const counting = ready && !held && quiet >= SETTLE_FROM && recording.status === 'live';
  const settle = phase === 'hello' ? SETTLE_HELLO : SETTLE;
  const progress = counting ? Math.min(1, (quiet - SETTLE_FROM) / settle) : 0;
  useEffect(() => {
    if (progress < 1) return;
    if (phase === 'hello') goTo('about');
    else if (phase === 'about') goTo('label');
    else if (phase === 'label') goTo('interview');
  }, [progress >= 1]);
  const [ending, setEnding] = useState(false);
  // "End interview" asks first, with keep-recording ready to press; the recording goes on meanwhile
  const [confirmEnd, setConfirmEnd] = useState(false);
  const endButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const askedEnd = useRef(false);
  useEffect(() => {
    if (confirmEnd) keepButton.current?.focus();
    else if (askedEnd.current) endButton.current?.focus();
    askedEnd.current = confirmEnd;
  }, [confirmEnd]);

  /* ── the button becomes the assistant ─────────────────── */
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!flipFrom || !card.current || reduceMotion()) return;
    const ctx = gsap.context(() => {
      Flip.from(flipFrom, {
        targets: card.current,
        duration: 0.9,
        ease: 'power3.inOut',
        scale: false,
        props: 'borderRadius,backgroundColor',
      });
      gsap.from('.assist-inner > *', {
        opacity: 0,
        y: 14,
        duration: 0.6,
        ease: 'power3.out',
        stagger: 0.07,
        delay: 0.55,
      });
      gsap.from('.studio-bar-live > *, .float-transcript', {
        opacity: 0,
        y: 8,
        duration: 0.5,
        stagger: 0.05,
        delay: 0.7,
      });
    }, root);
    return () => ctx.revert();
  }, []);

  // each new prompt arrives, rather than replacing the last
  const promptKey = phase;
  const prompt = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (!prompt.current || reduceMotion()) return;
    gsap.fromTo(
      prompt.current,
      { opacity: 0, y: 12, filter: 'blur(4px)' },
      { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.6, ease: 'power3.out' },
    );
  }, [promptKey]);

  // once everyone is introduced, a voice nobody owns is one of the known ones (lib/interview.ts)
  // and a word the notes showed was misheard is spelled their way
  const heard = respell(
    phase === 'interview' && mode === 'room' ? resolveVoices(segments, setup) : segments,
    respellings,
  );
  const labels = speakerLabels(heard, mode, setup, name);
  const pending = phase === 'hello' ? unnamedVoices(since, setup) : [];
  const stepLabel = `Getting started · ${
    phase === 'hello' ? 'who’s here' : phase === 'about' ? 'today’s topic' : 'the opening'
  }`;

  return (
    <div className="studio" ref={root}>
      <header className="studio-bar">
        <div className="studio-caption">
          <Avatar name={project ?? name} size={28} />
          <span>{project ?? name}</span>
          {project && <small className="studio-with">with {name}</small>}
        </div>
        <div className="row studio-bar-live">
          <span className={`live-dot live-dot-${recording.status}`} aria-hidden="true" />
          {rec && <Clock elapsed={() => rec.elapsed()} />}
          <span className="small muted">{STATUS[recording.status]}</span>
          {recording.mic && <Level stream={recording.mic} />}
          <button
            type="button"
            className="btn btn-outline btn-sm"
            disabled={!rec || recording.status === 'connecting' || recording.status === 'stopping'}
            onClick={() => (rec?.paused() ? rec.resume() : rec?.pause())}
          >
            <Icon name={rec?.paused() ? 'play' : 'pause'} size={14} />
            {rec?.paused() ? 'Resume' : 'Pause'}
          </button>
        </div>
        {/* apart from Pause, so one can't be pressed for the other */}
        <div className="row studio-bar-end">
          {confirmEnd ? (
            <div
              className="row studio-end-confirm"
              role="group"
              aria-labelledby="end-question"
              onKeyDown={(e) => {
                if (e.key === 'Escape') setConfirmEnd(false);
              }}
            >
              <span id="end-question" className="small">
                End the interview?
              </span>
              <button
                ref={keepButton}
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => setConfirmEnd(false)}
              >
                Keep recording
              </button>
              <button
                type="button"
                className="btn btn-ink btn-sm"
                disabled={recording.status === 'stopping'}
                onClick={() => void finish()}
              >
                <Icon name="stop" size={12} /> End and review
              </button>
            </div>
          ) : (
            <button
              ref={endButton}
              type="button"
              className={ending ? 'btn btn-primary btn-sm coach-end' : 'btn btn-ink btn-sm'}
              disabled={recording.status === 'stopping'}
              onClick={() => setConfirmEnd(true)}
            >
              <Icon name="stop" size={12} /> End interview
            </button>
          )}
        </div>
      </header>

      <main className="assist">
        {phase === 'interview' ? (
          <Coach
            archiveId={archiveId}
            call={call}
            interviewer={setup.people.find((p) => p.role === 'asker')?.call ?? interviewer}
            setup={setup}
            segments={heard}
            partials={partials}
            labels={labels}
            quiet={quiet}
            elapsed={() => rec?.elapsed() ?? 0}
            onEnding={setEnding}
            notes={notes.map((n) => n.text)}
            notesPanel={
              <Notes
                notes={notes}
                at={() => rec?.elapsed() ?? 0}
                terms={terms}
                onChange={changeNotes}
              />
            }
          />
        ) : (
          <section className="assist-card" data-flip-id="start" ref={card} aria-live="polite">
            <div className="assist-inner">
              <div className="assist-step">
                <span>{stepLabel}</span>
                <button
                  type="button"
                  className="btn btn-quiet btn-sm"
                  onClick={() => goTo('interview')}
                >
                  Skip setup
                </button>
              </div>

              {phase === 'hello' && (
                <>
                  <h2 className="assist-prompt" ref={prompt}>
                    Let’s go round the room. Each of you, say your name
                    {interviewer ? `, starting with you, ${interviewer}.` : '.'}
                  </h2>
                  <Hearing quiet={quiet} what="names" />
                  <ul className="assist-learned" aria-label="Who’s here">
                    {setup.people.map((p) => (
                      <PersonChip key={p.id} person={p} heard={bound.includes(p)} />
                    ))}
                    {pending.map(([voice, text], i) => (
                      <WhoIsThis
                        key={voice}
                        n={i + 1}
                        text={text}
                        choices={setup.people.filter((p) => !bound.includes(p))}
                        onPick={(personId) =>
                          setSetup((s) => ({ ...s, voices: { ...s.voices, [voice]: personId } }))
                        }
                        onName={(n) =>
                          setSetup((s) => {
                            const id = `p${Date.now()}`;
                            return {
                              ...s,
                              people: [...s.people, { id, name: n, role: 'listener', call: n }],
                              voices: { ...s.voices, [voice]: id },
                            };
                          })
                        }
                      />
                    ))}
                  </ul>
                  <p className="assist-note">
                    {bound.length} of {setup.people.length}{' '}
                    {setup.people.length === 1 ? 'person' : 'people'} heard
                  </p>
                </>
              )}

              {phase === 'about' && (
                <>
                  <h2 className="assist-prompt" ref={prompt}>
                    What would you like to talk about with {call} today?
                  </h2>
                  <Hearing quiet={quiet} what="topics" />
                  {setup.about && <p className="assist-quote">“{setup.about}”</p>}
                  <div className="assist-topics" role="group" aria-label="Topics">
                    {free.map((t) => (
                      <button
                        key={`free:${t.label}`}
                        type="button"
                        className="chip"
                        aria-pressed="true"
                        title="Named by you. Tap to leave it out."
                        onClick={() => {
                          setSetup((s) => ({
                            ...s,
                            free: (s.free ?? []).filter((x) => x.label !== t.label),
                          }));
                          setRemovedFree((r) => [...r, t.label]);
                          setHeld(false);
                        }}
                      >
                        {t.label}
                      </button>
                    ))}
                    {TOPICS.map((t) => {
                      const on = setup.topics.includes(t.id);
                      return (
                        <button
                          key={t.id}
                          type="button"
                          className="chip"
                          aria-pressed={on}
                          onClick={() => {
                            setSetup((s) => ({
                              ...s,
                              topics: on ? s.topics.filter((x) => x !== t.id) : [...s.topics, t.id],
                            }));
                            if (on) setDismissed((d) => [...d, t.id]);
                            setHeld(false);
                          }}
                        >
                          {t.label}
                        </button>
                      );
                    })}
                  </div>
                  {reading !== null ? (
                    <p className="assist-note">Reading the topics out of what you said…</p>
                  ) : (
                    aboutWords >= ABOUT_WORDS &&
                    free.length === 0 &&
                    setup.topics.length === 0 && (
                      <p className="assist-note">
                        Nothing in particular: a life story, from childhood on. Tap a topic to
                        choose one.
                      </p>
                    )
                  )}
                </>
              )}

              {phase === 'label' && (
                <>
                  <span className="assist-eyebrow">Read this aloud to begin</span>
                  <h2 className="assist-prompt assist-label" ref={prompt}>
                    “{script}”
                  </h2>
                  <Hearing quiet={quiet} what="the opening" />
                  <p className="assist-note">
                    Oral historians start every recording this way: who is speaking, when, and who
                    is being interviewed, said by you, so {call} is not quizzed for it.
                  </p>
                </>
              )}

              <div className="assist-actions">
                {phase === 'hello' && (
                  <button type="button" className="btn btn-primary" onClick={() => goTo('about')}>
                    Everyone’s here
                  </button>
                )}
                {phase === 'about' && (
                  <button type="button" className="btn btn-primary" onClick={() => goTo('label')}>
                    That’s it
                  </button>
                )}
                {phase === 'label' && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => goTo('interview')}
                  >
                    Begin the interview
                  </button>
                )}
                {counting && (
                  <button
                    type="button"
                    className="btn btn-quiet btn-sm"
                    onClick={() => setHeld(true)}
                  >
                    Wait
                  </button>
                )}
              </div>
            </div>
            {/* fills while Firepit waits for a pause before moving on by itself */}
            <span
              className="assist-progress"
              style={{ transform: `scaleX(${progress})` }}
              aria-hidden="true"
            />
          </section>
        )}
      </main>

      <FloatingTranscript
        segments={heard}
        names={labels}
        partials={partials}
        live={recording.status === 'live'}
      />
    </div>
  );
}

/* ── the parts ─────────────────────────────────────────── */

function Hearing({ quiet, what }: { quiet: number; what: string }) {
  return (
    <p className="assist-hearing" data-talking={quiet < 1.2}>
      <span className="assist-wave" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {quiet < 1.2 ? 'Listening…' : `Firepit is listening for ${what}.`}
    </p>
  );
}

function PersonChip({ person, heard }: { person: Person; heard: boolean }) {
  return (
    <li className="assist-person" data-heard={heard}>
      <span className="assist-person-dot" aria-hidden="true">
        {heard && <Icon name="check" size={11} stroke={3} />}
      </span>
      {person.call ?? person.name}
      {!heard && <span className="assist-person-wait">waiting</span>}
    </li>
  );
}

/** A voice that spoke without giving a name: one tap says whose it is. */
function WhoIsThis({
  n,
  text,
  choices,
  onPick,
  onName,
}: {
  n: number;
  text: string;
  choices: Person[];
  onPick: (personId: string) => void;
  onName: (name: string) => void;
}) {
  const [typing, setTyping] = useState(false);
  const [value, setValue] = useState('');
  // someone we are waiting for whose name this voice said is the likely answer: offered first
  const said = (p: Person) =>
    text
      .split(/[^\p{L}'’]+/u)
      .some((w) => w.length > 1 && /^\p{Lu}/u.test(w) && sameName(w, p.call ?? p.name));
  const likely = choices.filter(said);
  const ordered = [...likely, ...choices.filter((p) => !likely.includes(p))];
  return (
    <li className="assist-who">
      <span className="small muted">
        New voice {n}: “{text.slice(0, 70)}
        {text.length > 70 ? '…' : ''}” Who’s this?
      </span>
      <span className="row">
        {ordered.map((p) => (
          <button
            key={p.id}
            type="button"
            className={likely.includes(p) ? 'btn btn-primary btn-sm' : 'chip'}
            onClick={() => onPick(p.id)}
          >
            {likely.includes(p) ? `It’s ${p.call ?? p.name}` : (p.call ?? p.name)}
          </button>
        ))}
        {typing ? (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (value.trim()) onName(value.trim());
            }}
          >
            <input
              id={`who-${n}`}
              className="input"
              style={{ width: 140, minHeight: 28 }}
              autoFocus
              placeholder="Their name"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <button type="submit" className="btn btn-outline btn-sm">
              Add
            </button>
          </form>
        ) : (
          <button type="button" className="chip" onClick={() => setTyping(true)}>
            Someone else
          </button>
        )}
      </span>
    </li>
  );
}

/* ── learning from speech ──────────────────────────────── */

/**
 * Each new voice that gives its name is tied to that name: to the person being remembered or
 * the interviewer when the name matches theirs, or to a new person in the room otherwise.
 * `since` may include words still being worked out: Deepgram sends them about a second after
 * they are said, with the speaker already known, where a finished sentence takes two or three.
 */
function learnNames(
  s: Setup,
  since: Array<Pick<Segment, 'speaker' | 'text'>>,
  subject: string,
  interviewer: string,
): Setup {
  let next = s;
  for (const seg of since) {
    if (next.voices[seg.speaker]) continue;
    const heard = nameIn(seg.text);
    if (!heard) continue;
    const taken = new Set(Object.values(next.voices));
    const match = next.people.find(
      (p) => !taken.has(p.id) && (sameName(heard, p.name) || sameName(heard, p.call ?? '')),
    );
    if (match) {
      next = {
        ...next,
        people: next.people.map((p) => (p.id === match.id ? { ...p, call: heard } : p)),
        voices: { ...next.voices, [seg.speaker]: match.id },
      };
    } else if (!next.people.some((p) => sameName(heard, p.name))) {
      // one person per voice, so the voice names them
      const id = `voice-${seg.speaker}`;
      const role = sameName(heard, subject)
        ? 'teller'
        : interviewer && sameName(heard, interviewer)
          ? 'asker'
          : 'listener';
      next = {
        ...next,
        people: [...next.people, { id, name: heard, call: heard, role }],
        voices: { ...next.voices, [seg.speaker]: id },
      };
    }
  }
  return next;
}

/** voices heard in this step that have not said who they are yet, with what they said */
function unnamedVoices(since: Segment[], s: Setup): Array<[string, string]> {
  const by = new Map<string, string>();
  for (const seg of since) {
    if (s.voices[seg.speaker]) continue;
    by.set(seg.speaker, `${by.get(seg.speaker) ?? ''} ${seg.text}`.trim());
  }
  return [...by.entries()];
}

function firstSentence(t: string): string {
  const s = t.split(/(?<=[.!?])\s/)[0]?.trim() ?? '';
  return s.length > 90 ? `${s.slice(0, 87)}…` : s;
}
