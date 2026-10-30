import { useEffect, useRef, useState } from 'react';
import {
  interviewCorrections,
  transcribeRecording,
  type Correction,
  type ImportRequest,
} from '../lib/api';
import {
  alignRecorded,
  applyCorrections,
  clock,
  linesNearNotes,
  newSetup,
  noteTerms,
  respell,
  resolveVoices,
  speakerLabels,
  tellerVoices,
  turnsOf,
  unsettledVoices,
  writeDraft,
  type Draft,
} from '../lib/interview';
import type { Segment } from '../lib/live';
import { interviewName } from '../lib/interview-name';
import { Transcript } from './Transcript';

type Pass = 'working' | 'done' | 'failed' | 'none';

/** the answer for a voice that is none of the people introduced */
const OTHER = 'other';

/**
 * After the interview. First the whole recording is transcribed once more (the live words were
 * worked out a few at a time; the full file gives voices told apart from start to finish and
 * fewer misheard words), and the interviewer's notes are checked against what was heard near
 * them, for words the transcript got wrong. Then: confirm whose words are the memories, put any
 * voice or turn right, name it, and hand it to the import, where every memory is read before it
 * is kept. The import itself runs right here on the home page (onSubmit), not on a separate "add
 * a transcript" page: that one is for a transcript that wasn't made here.
 */
export function InterviewReview({
  archiveId,
  name,
  draft,
  audio,
  onDiscard,
  onSubmit,
}: {
  archiveId: string;
  name: string;
  draft: Draft;
  /** each source's whole recording, held in memory; none after a reload */
  audio?: Blob[];
  onDiscard: () => void;
  onSubmit: (request: ImportRequest) => void;
}) {
  const notes = draft.notes ?? [];
  // the mishearings the notes showed while recording are made right in whichever transcript
  const fixed = (segs: Segment[]) =>
    respell(draft.mode === 'room' ? resolveVoices(segs, draft.setup) : segs, draft.respell ?? []);
  const [segments, setSegments] = useState<Segment[]>(() => fixed(draft.segments));
  const retranscribed = useRef(!!draft.retranscribed);
  const [pass, setPass] = useState<Pass>(() =>
    !draft.retranscribed && audio?.some((b) => b.size > 0) ? 'working' : 'none',
  );
  const passing = useRef<AbortController | null>(null);
  const [fixes, setFixes] = useState<Correction[] | null>(null);
  // who each voice the introductions didn't settle is, as the interviewer says: a person's id, or
  // OTHER for someone who isn't one of them. Nothing is chosen for them; kept with the draft.
  const [answers, setAnswers] = useState<Record<string, string>>(() => draft.voiceAnswers ?? {});

  function keep(segs: Segment[], said: Record<string, string>) {
    writeDraft(archiveId, {
      ...draft,
      segments: segs,
      retranscribed: retranscribed.current,
      voiceAnswers: said,
    });
  }

  function save(next: Segment[]) {
    setSegments(next);
    keep(next, answers);
  }

  function answer(voice: string, id: string) {
    const next = { ...answers, [voice]: id };
    setAnswers(next);
    keep(segments, next);
  }

  /* ── the whole recording, transcribed once more ───────── */
  useEffect(() => {
    if (pass !== 'working' || !audio) return;
    const ctrl = new AbortController();
    passing.current = ctrl;
    const keyterms = [
      ...new Set([...noteTerms(notes.map((n) => n.text)), ...(draft.keyterms ?? [])]),
    ].slice(0, 60);
    // the order the recordings were made in: the microphone, then the call's own sound
    const sources: Array<string | null> = draft.mode === 'call' ? ['mic', 'call'] : [null];
    Promise.all(
      audio.map(async (blob, i) => {
        const source = sources[i] ?? null;
        if (blob.size === 0) return { source, segments: [] };
        const got = await transcribeRecording(
          archiveId,
          blob,
          { diarize: source === null, keyterms },
          ctrl.signal,
        );
        return { source, segments: got };
      }),
    )
      .then((recorded) => {
        const aligned = alignRecorded(recorded, segments);
        if (aligned.length === 0) return setPass('failed');
        retranscribed.current = true;
        save(fixed(aligned));
        setPass('done');
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setPass('failed');
      });
    return () => ctrl.abort();
    // once, when the review opens: the recording does not change
  }, []);

  /* ── the notes' spellings, against what was heard near them ── */
  useEffect(() => {
    if (pass === 'working' || fixes !== null) return;
    const lines = linesNearNotes(notes, segments);
    if (notes.length === 0 || lines.length === 0) return setFixes([]);
    const ctrl = new AbortController();
    interviewCorrections(archiveId, { notes: notes.map((n) => n.text), lines }, ctrl.signal)
      .then((r) => setFixes(r.fixes))
      .catch(() => {
        if (!ctrl.signal.aborted) setFixes([]);
      });
    return () => ctrl.abort();
  }, [pass]);

  function fix(chosen: Correction[]) {
    save(applyCorrections(segments, chosen));
    setFixes((f) => (f ?? []).filter((x) => !chosen.includes(x)));
  }

  const labels = speakerLabels(segments, draft.mode, draft.setup, name);
  const speakers = [...new Set(segments.map((s) => s.speaker))];
  const people = draft.setup?.people ?? newSetup(name, 'The interviewer').people;
  const voices: Record<string, string> = { ...(draft.setup?.voices ?? {}) };
  for (const [sp, id] of Object.entries(answers)) if (id !== OTHER) voices[sp] = id;
  const asked = unsettledVoices(draft.mode, segments, draft.setup?.voices ?? {});
  const open = asked.filter((sp) => !(sp in answers));
  const tellers = tellerVoices(draft.mode, people, voices);
  const ready = open.length === 0 && (speakers.length === 0 || tellers.length > 0);
  // the date and the topics chosen at the start: never the first words said ("Hi.")
  const [source, setSource] = useState(() =>
    interviewName(draft.startedAt, draft.setup?.topics ?? []),
  );

  // the archive's own name for the person being remembered, so memories say who told them
  const finalName = (sp: string) =>
    tellers.includes(sp)
      ? name
      : (people.find((p) => p.id === voices[sp])?.name ?? labels.get(sp) ?? sp);
  // a line long enough to recognise the voice by
  const sample = (sp: string) => {
    const own = segments.filter((s) => s.speaker === sp);
    return (own.find((s) => s.text.split(' ').length >= 6) ?? own[0])?.text ?? '';
  };

  function bringIn() {
    const transcript = JSON.stringify({
      language: 'en',
      interviewee: name,
      segments: segments.map((s) => ({
        start: Math.round(s.start * 100) / 100,
        end: Math.round(s.end * 100) / 100,
        text: s.text,
        speaker: finalName(s.speaker),
      })),
    });
    const request: ImportRequest = { transcript, teller: name, source: source.trim() || undefined };
    onSubmit(request);
  }

  function download() {
    const text = turnsOf(segments)
      .map((t) => `[${clock(t.start)}] ${finalName(t.speaker)}: ${t.text}`)
      .join('\n\n');
    const written = notes.length
      ? `\n\n---\nNotes\n${notes.map((n) => `[${clock(n.at)}] ${n.text}`).join('\n')}`
      : '';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text + written], { type: 'text/plain' }));
    a.download = `${source.trim() || 'interview'}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const lineOf = (id: number) => segments.find((s) => s.id === id);

  return (
    <div className="review">
      <div className="stack" style={{ gap: 4 }}>
        <h1 className="page-title">Interview with {name}</h1>
        <p className="muted">{clock(segments[segments.length - 1]?.end ?? 0)} recorded</p>
      </div>

      {pass !== 'none' && pass !== 'done' && (
        <p className="review-pass" data-state={pass}>
          {pass === 'working' && (
            <>
              <span className="assist-pulse" aria-hidden="true" />
              Transcribing the whole recording once more, for cleaner words and voices told apart.
              The live transcript is below until it is done.
              <button
                type="button"
                className="btn btn-quiet btn-sm"
                onClick={() => {
                  passing.current?.abort();
                  setPass('none');
                }}
              >
                Use the live transcript
              </button>
            </>
          )}
          {pass === 'failed' &&
            'The full recording couldn’t be transcribed again, so this is the live transcript.'}
        </p>
      )}

      {fixes && fixes.length > 0 && (
        <section className="stack review-fixes" style={{ gap: 8 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 className="label-heading">From your notes</h2>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => fix(fixes)}>
              Fix all {fixes.length}
            </button>
          </div>
          <ul className="review-fix-list">
            {fixes.map((f) => {
              const line = lineOf(f.id);
              return (
                <li key={`${f.id}:${f.from}`}>
                  <span className="review-fix-words">
                    <s>{f.from}</s> → <strong>{f.to}</strong>
                  </span>
                  {line && (
                    <span className="small muted live-sample">
                      {clock(line.start)} “{line.text}”
                    </span>
                  )}
                  <span className="row" style={{ gap: 6 }}>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => fix([f])}
                    >
                      Fix
                    </button>
                    <button
                      type="button"
                      className="btn btn-quiet btn-sm"
                      onClick={() => setFixes(fixes.filter((x) => x !== f))}
                    >
                      Leave it
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* asked once the voices are final: the second transcription numbers them afresh */}
      {asked.length > 0 && pass !== 'working' && (
        <section className="stack" style={{ gap: 12 }}>
          <div className="stack" style={{ gap: 4 }}>
            <h2 className="label-heading">Who is speaking?</h2>
            <p className="small muted">
              The introductions didn’t say who every voice is. Say who said each line below; the
              stories are written from what {name} said. One person heard as two can be named twice.
            </p>
          </div>
          {asked.map((sp) => (
            <fieldset key={sp} className="stack live-who-pick" style={{ gap: 8 }}>
              <legend className="row-title">Who is {labels.get(sp)}?</legend>
              <p className="small muted live-sample">“{sample(sp)}”</p>
              {[
                ...people.map((p) => ({ id: p.id, label: p.name })),
                { id: OTHER, label: 'Someone else' },
              ].map((choice) => (
                <label key={choice.id} className="live-mode" data-on={answers[sp] === choice.id}>
                  <input
                    type="radio"
                    name={`voice-${sp}`}
                    checked={answers[sp] === choice.id}
                    onChange={() => answer(sp, choice.id)}
                  />
                  <span className="row-title">{choice.label}</span>
                </label>
              ))}
            </fieldset>
          ))}
        </section>
      )}

      <label className="field" style={{ maxWidth: 420 }}>
        Name this interview
        <input
          id="interview-source"
          className="input"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
      </label>

      <div className="row">
        <button
          type="button"
          className="btn btn-primary btn-lg"
          disabled={pass === 'working' || !ready}
          aria-describedby={ready ? undefined : 'write-waits'}
          onClick={bringIn}
        >
          Write the stories
        </button>
        <button type="button" className="btn btn-outline" onClick={download}>
          Download transcript
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            if (window.confirm('Throw away this interview’s transcript? It can’t be brought back.'))
              onDiscard();
          }}
        >
          Discard
        </button>
      </div>
      {!ready && pass !== 'working' && (
        <p id="write-waits" className="small muted">
          {open.length > 0
            ? `Say who is speaking above first (${open.length} left).`
            : `Choose which voice is ${name} above: the stories are written from what they said.`}
        </p>
      )}

      {notes.length > 0 && (
        <section className="stack" style={{ gap: 8 }}>
          <h2 className="label-heading">Your notes</h2>
          <ul className="review-notes">
            {notes.map((n, i) => (
              <li key={i}>
                <span className="coach-notes-time">{clock(n.at)}</span> {n.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="stack" style={{ gap: 8 }}>
        <h2 className="label-heading">Transcript</h2>
        <div className="review-box">
          <Transcript
            segments={segments}
            names={new Map(speakers.map((sp) => [sp, finalName(sp)]))}
            partials={[]}
            empty="Nothing was heard."
            onReassign={
              speakers.length > 1
                ? (ids, to) =>
                    save(segments.map((s) => (ids.includes(s.id) ? { ...s, speaker: to } : s)))
                : undefined
            }
          />
        </div>
      </section>
    </div>
  );
}
