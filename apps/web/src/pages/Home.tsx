import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Flip } from 'gsap/Flip';
import {
  cancelImport,
  createNote,
  listPeople,
  putPersonProfile,
  type ImportRequest,
  type PersonSummary,
} from '../lib/api';
import { inArchive, useArchive } from '../lib/archive';
import {
  FAILURE,
  readDraft,
  SHARE_HOW,
  writeDraft,
  type Draft,
  type Mode,
  type StartFailure,
} from '../lib/interview';
import { liveSupported } from '../lib/live';
import { ArchiveLayout } from '../components/ArchiveLayout';
import { InterviewReview } from '../components/InterviewReview';
import { Review, Running, Saved, useImportRun, WhoIsTelling } from '../components/ImportRun';
import { Studio } from '../components/Studio';
import { WhoAndWhere } from '../components/WhoAndWhere';
import { Avatar, Failed, Icon, useAccountName } from '../components/ui';
import { readProfileDraft } from '../components/ProfileInputs';

type Phase =
  | { kind: 'idle' }
  | {
      kind: 'studio';
      /** who is being interviewed: the project's person, or one of its family */
      narrator: string;
      mode: Mode;
      startedAt: string;
      flip: Flip.FlipState | null;
    }
  /** `audio`: the whole recording, held in memory for the second transcription; gone on reload */
  | { kind: 'review'; narrator: string; draft: Draft; audio?: Blob[] }
  /** "Write the stories" is running right here: leaving and coming back resumes the same job. */
  | { kind: 'processing'; narrator: string; draft: Draft };

const flipFrom = (el: Element | null) =>
  el ? Flip.getState(el, { props: 'borderRadius,backgroundColor' }) : null;

/** who a saved interview was with: its narrator, as set up, or the project's person */
const narratorOf = (d: Draft, fallback: string) =>
  d.setup?.people.find((p) => p.role === 'teller')?.name ?? fallback;

/**
 * A project, and one thing to do: sit down and talk. In a personal project Start interview turns
 * straight into the interview (components/Studio.tsx); in a family one it first asks who you are
 * talking with, from the family recorded so far or someone new, who then becomes one of its
 * people. Ending an interview leads to reading it over.
 */
export function Home() {
  const archive = useArchive();
  const name = archive.subjectName;
  const family = archive.kind === 'family';
  const account = useAccountName();
  const interviewer = account.includes('@') ? '' : (account.split(' ')[0] ?? '');
  const [left, setLeft] = useState(() => readDraft(archive.id));
  const [phase, setPhase] = useState<Phase>(() =>
    left?.submittedJobId
      ? { kind: 'processing', narrator: narratorOf(left, name), draft: left }
      : { kind: 'idle' },
  );
  const [mode, setMode] = useState<Mode>('room');
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const start = useRef<HTMLButtonElement>(null);
  // which draft the running job belongs to, read fresh (never stale) when the job starts
  const activeDraft = useRef<Draft | null>(left?.submittedJobId ? left : null);
  const resumed = useRef(false);

  const importRun = useImportRun(archive.id, {
    onStarted: (jobId) => {
      if (activeDraft.current)
        writeDraft(archive.id, { ...activeDraft.current, submittedJobId: jobId });
    },
    onSaved: () => {
      writeDraft(archive.id, null);
      setLeft(null);
    },
  });

  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    if (phase.kind === 'processing' && phase.draft.submittedJobId) {
      void importRun.resume(phase.draft.submittedJobId);
    }
    // mount only: a draft already marked submitted is resumed once, never restarted
  }, []);

  function onSubmit(request: ImportRequest) {
    if (phase.kind !== 'review') return;
    activeDraft.current = phase.draft;
    setPhase({ kind: 'processing', narrator: phase.narrator, draft: phase.draft });
    void importRun.run(request);
  }

  function begin(narrator: string, from: Element | null) {
    setError(null);
    setChoosing(false);
    setPhase({
      kind: 'studio',
      narrator,
      mode,
      startedAt: new Date().toISOString(),
      flip: flipFrom(from),
    });
  }

  const studio = phase.kind === 'studio';
  return (
    <ArchiveLayout title="Home" wide focus={studio}>
      {phase.kind === 'idle' && (
        <section className="home-start">
          <header className="home-caption">
            <Avatar name={name} size={28} />
            <h1 className="home-name">{name}</h1>
          </header>

          <div className="home-middle">
            {error && <Failed>{error}</Failed>}
            {left && (
              <div className="notice notice-wonder spread home-left">
                <span>
                  An interview from {new Date(left.startedAt).toLocaleString()} wasn’t finished.
                </span>
                <span className="row">
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={() =>
                      setPhase({ kind: 'review', narrator: narratorOf(left, name), draft: left })
                    }
                  >
                    Pick it up
                  </button>
                  <button
                    type="button"
                    className="btn btn-quiet btn-sm"
                    onClick={() => {
                      writeDraft(archive.id, null);
                      setLeft(null);
                    }}
                  >
                    Discard
                  </button>
                </span>
              </div>
            )}
          </div>

          {archive.writer ? (
            <div className="home-bottom">
              {choosing ? (
                <ChooseNarrator
                  archiveId={archive.id}
                  family={name}
                  onPick={begin}
                  onCancel={() => setChoosing(false)}
                />
              ) : (
                <button
                  ref={start}
                  type="button"
                  className="btn btn-primary home-start-btn"
                  data-flip-id="start"
                  data-testid="start-interview"
                  // one unfinished interview is kept per project: pick it up or discard it first,
                  // so a new one never takes its place unasked
                  disabled={!liveSupported() || left !== null}
                  title={left ? 'Pick up or discard the unfinished interview first' : undefined}
                  onClick={() => (family ? setChoosing(true) : begin(name, start.current))}
                >
                  <Icon name="mic" size={20} />
                  Start interview
                </button>
              )}
              <div className="home-mode" role="radiogroup" aria-label="Where are you talking?">
                {(['room', 'call'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={mode === m}
                    onClick={() => setMode(m)}
                  >
                    <Icon name={m === 'room' ? 'mic' : 'phone'} size={14} />
                    {m === 'room' ? 'In the room' : 'On a call'}
                  </button>
                ))}
              </div>
              {mode === 'call' && <p className="home-hint">{SHARE_HOW}</p>}
              {!liveSupported() && <p className="home-hint">{FAILURE.unsupported}</p>}
              <Link to={inArchive(archive.id, '/interviews/new')} className="small muted tap">
                or bring in a recorded transcript
              </Link>
            </div>
          ) : (
            <div className="home-bottom">
              <Link to={inArchive(archive.id, '/stories')} className="btn btn-outline">
                {family ? 'Read the family’s stories' : `Read ${name}’s stories`}
              </Link>
            </div>
          )}
        </section>
      )}
      {phase.kind === 'idle' && (
        <div className="home-graph">
          <WhoAndWhere archiveId={archive.id} />
        </div>
      )}

      {phase.kind === 'studio' && (
        <Studio
          archiveId={archive.id}
          name={phase.narrator}
          project={family ? name : null}
          interviewer={interviewer}
          mode={phase.mode}
          startedAt={phase.startedAt}
          flipFrom={phase.flip}
          onEnd={(draft, failed: StartFailure | null, audio) => {
            setError(failed ? FAILURE[failed] : null);
            if (draft.segments.length > 0)
              setPhase({ kind: 'review', narrator: phase.narrator, draft, audio });
            else setPhase({ kind: 'idle' });
          }}
        />
      )}

      {phase.kind === 'review' && (
        <InterviewReview
          archiveId={archive.id}
          name={phase.narrator}
          draft={phase.draft}
          audio={phase.audio}
          onDiscard={() => {
            writeDraft(archive.id, null);
            setLeft(null);
            setPhase({ kind: 'idle' });
          }}
          onSubmit={onSubmit}
        />
      )}

      {phase.kind === 'processing' && importRun.step && (
        <div className="page" style={{ maxWidth: 640 }}>
          {(() => {
            const runStep = importRun.step;
            if (!runStep) return null;
            if (runStep.kind === 'running')
              return (
                <Running
                  job={runStep.job}
                  onCancel={async () => {
                    try {
                      await cancelImport(archive.id, runStep.job.id);
                    } catch {
                      /* too late to stop: it finishes, and can be undone */
                    }
                  }}
                />
              );
            if (runStep.kind === 'failed')
              return (
                <div className="stack" style={{ gap: 6 }}>
                  <h1 className="page-title">That didn’t work</h1>
                  <Failed>{runStep.text}</Failed>
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => {
                        // the transcript isn't lost: drop only the job id, so it goes back to
                        // "wasn't finished" and can be picked up and sent again
                        if (activeDraft.current) {
                          const rest: Draft = { ...activeDraft.current };
                          delete rest.submittedJobId;
                          writeDraft(archive.id, rest);
                          setLeft(rest);
                        }
                        setPhase({ kind: 'idle' });
                      }}
                    >
                      Back home
                    </button>
                  </div>
                </div>
              );
            if (runStep.kind === 'confirm')
              return (
                <WhoIsTelling
                  outcome={runStep.outcome}
                  onChoose={(ids) =>
                    void importRun.run({ ...importRun.req!, interviewees: ids, confirm: true })
                  }
                  onBack={() => {
                    const d = activeDraft.current;
                    setPhase(
                      d
                        ? { kind: 'review', narrator: narratorOf(d, name), draft: d }
                        : { kind: 'idle' },
                    );
                  }}
                />
              );
            if (runStep.kind === 'duplicate')
              return (
                <div className="stack" style={{ gap: 6 }}>
                  <h1 className="page-title">This interview is already here</h1>
                  <p className="notice notice-wonder">
                    The same words were brought in
                    {runStep.outcome.duplicateOf
                      ? ` on ${new Date(runStep.outcome.duplicateOf.createdAt).toLocaleDateString()}`
                      : ' before'}
                    {runStep.outcome.duplicateOf?.source
                      ? `, as “${runStep.outcome.duplicateOf.source}”`
                      : ''}
                    . Bringing it in again makes a second copy of every memory.
                  </p>
                  <div className="row">
                    <Link to={inArchive(archive.id, '/interviews')} className="btn btn-primary">
                      See the interviews
                    </Link>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void importRun.run({ ...importRun.req!, force: true })}
                    >
                      Bring it in again anyway
                    </button>
                  </div>
                </div>
              );
            if (runStep.kind === 'review')
              return (
                <Review
                  archiveId={archive.id}
                  jobId={runStep.jobId}
                  outcome={runStep.outcome}
                  name={name}
                  onSaved={importRun.saved}
                  onRetry={importRun.req ? () => void importRun.run(importRun.req!) : undefined}
                />
              );
            return (
              <Saved
                archiveId={archive.id}
                outcome={runStep.outcome}
                onRestart={() => {
                  importRun.reset();
                  setPhase({ kind: 'idle' });
                }}
              />
            );
          })()}
        </div>
      )}
    </ArchiveLayout>
  );
}

/**
 * Who you are talking with today, in a family project: someone already in it (most talked about
 * first), or someone new, who is added to the project as a person before the interview starts.
 */
function ChooseNarrator({
  archiveId,
  family,
  onPick,
  onCancel,
}: {
  archiveId: string;
  family: string;
  onPick: (name: string, from: Element | null) => void;
  onCancel: () => void;
}) {
  const [people, setPeople] = useState<PersonSummary[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [born, setBorn] = useState('');
  const [bornWrong, setBornWrong] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    listPeople(archiveId)
      .then((p) => live && setPeople([...p].sort((a, b) => b.backlinks - a.backlinks)))
      .catch(() => live && setPeople([]));
    return () => {
      live = false;
    };
  }, [archiveId]);

  async function addAndStart(el: Element | null) {
    const name = newName.trim();
    if (!name) return;
    // a birth year lets "when I was seven" in their stories become a year (PRD D13)
    const profile = readProfileDraft({ born, died: '', aliases: '' });
    if (typeof profile === 'string') return setBornWrong(profile);
    setSaving(true);
    try {
      // the new narrator becomes one of the family's people; if that fails (a note by that
      // name already exists), the interview still goes ahead
      const note = await createNote(archiveId, {
        title: name,
        type: 'person',
        body: `Part of ${family}. First interviewed ${new Date().toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })}.`,
        occurred: null,
      });
      if (profile.born) await putPersonProfile(archiveId, note.id, profile);
    } catch {
      /* already a person here, or the save failed: either way, talk to them */
    }
    onPick(name, el);
  }

  return (
    <div className="narrator-pick" data-flip-id="start">
      <div className="spread" style={{ gap: 8 }}>
        <span className="narrator-title">Who are you talking with today?</span>
        <button type="button" className="btn btn-quiet btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {people === null ? (
        <p className="small muted">Finding the family…</p>
      ) : (
        <div className="narrator-people">
          {people.map((p) => (
            <button
              key={p.id}
              type="button"
              className="narrator-person"
              onClick={(e) => onPick(p.title, e.currentTarget.closest('.narrator-pick'))}
            >
              <Avatar name={p.title} size={24} />
              {p.title}
            </button>
          ))}
          {!adding && (
            <button
              type="button"
              className="narrator-person narrator-new"
              onClick={() => setAdding(true)}
            >
              <Icon name="plus" size={14} /> Someone new
            </button>
          )}
        </div>
      )}
      {adding && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void addAndStart(e.currentTarget.closest('.narrator-pick'));
          }}
        >
          <input
            id="narrator-new-name"
            className="input"
            style={{ flex: '1 1 200px' }}
            autoFocus
            placeholder="Their name, e.g. Aunt Carol"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <input
            id="narrator-new-born"
            className="input"
            style={{ flex: '0 1 150px' }}
            aria-label="Born (optional)"
            placeholder="Born, e.g. 1952"
            autoComplete="off"
            value={born}
            onChange={(e) => {
              setBorn(e.target.value);
              setBornWrong(null);
            }}
          />
          <button type="submit" className="btn btn-primary" disabled={!newName.trim() || saving}>
            <Icon name="mic" size={16} /> Start interview
          </button>
        </form>
      )}
      {bornWrong && <Failed>{bornWrong}</Failed>}
      {people?.length === 0 && !adding && (
        <p className="small muted">
          Nobody is in this project yet. Add the first person you are talking with.
        </p>
      )}
    </div>
  );
}
