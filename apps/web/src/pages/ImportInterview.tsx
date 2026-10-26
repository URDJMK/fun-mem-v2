import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import {
  ApiError,
  cancelImport,
  getImport,
  listNotes,
  saveImport,
  startImport,
  type ImportJob,
  type ImportMemory,
  type ImportOutcome,
  type ImportRequest,
  type MemoryPatch,
  type NoteSummary,
} from '../lib/api';
import { inArchive, noteHref, useArchive } from '../lib/archive';
import { writeDraft } from '../lib/interview';
import { ArchiveLayout } from '../components/ArchiveLayout';
import { Linked, splitNote } from '../components/NoteText';
import { count, Failed, Icon, whenLabel } from '../components/ui';

/** What went wrong, in words a person can act on (docs/ingest/api.md, Errors). */
function importFailure(code: string | null | undefined): string {
  switch (code) {
    case 'empty':
      return 'The transcript is empty.';
    case 'unreadable':
      return 'That transcript could not be read. Plain text with a speaker’s name before each line works best.';
    case 'no_speech':
      return 'No one’s words were found in that transcript.';
    case 'too_long':
    case 'too_large':
      return 'That transcript is too long for one import. Split it in two and bring in each part.';
    case 'too_many_segments':
      return 'That transcript has too many pieces for one import. Split it in two.';
    case 'busy':
      return 'The server is busy with other imports. Wait a minute and try again.';
    case 'forbidden':
      return 'In this project you can read, but not bring in interviews.';
    case 'timeout':
      return 'It took too long and was stopped. Try a shorter part of the interview.';
    case 'cancelled':
      return 'The import was stopped. Nothing was saved.';
    default:
      return 'Something went wrong with the import. Nothing was saved. Try again in a moment.';
  }
}

const STAGE: Record<ImportJob['stage'], string> = {
  reading: 'Reading the transcript',
  organizing: 'Sorting it into memories',
  checking: 'Checking each memory against what was said, and against the project',
  saving: 'Saving',
  done: 'Done',
};

type Step =
  | { kind: 'form' }
  | { kind: 'running'; job: ImportJob }
  | { kind: 'failed'; text: string }
  | { kind: 'confirm'; jobId: string; outcome: ImportOutcome }
  | { kind: 'duplicate'; outcome: ImportOutcome }
  | { kind: 'review'; jobId: string; outcome: ImportOutcome }
  | { kind: 'saved'; outcome: ImportOutcome };

/** Bringing in one interview: a transcript in, a preview of memories to read over, then saved. */
export function ImportInterview() {
  const archive = useArchive();
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [req, setReq] = useState<ImportRequest>({ transcript: '' });
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // a recorded interview arrives with its transcript (components/InterviewReview.tsx) and starts at once;
  // the state is cleared so a reload shows the form instead of importing it twice
  const handedState = useLocation().state as { request?: ImportRequest; fromLive?: boolean } | null;
  const handed = handedState?.request;
  const navigate = useNavigate();
  const started = useRef(false);
  /** it came from a live interview, whose draft is let go once its memories are saved */
  const fromLive = useRef(false);
  useEffect(() => {
    if (!handed || started.current) return;
    started.current = true;
    fromLive.current = handedState?.fromLive === true;
    void navigate('.', { replace: true, state: null });
    void run(handed);
  }, []);

  /** Saved: the live interview it came from has done its work, and is let go. */
  function saved(outcome: ImportOutcome) {
    if (fromLive.current) writeDraft(archive.id, null);
    setStep({ kind: 'saved', outcome });
  }

  /** Start, then follow the job until it finishes: a long interview takes a few minutes. */
  async function run(request: ImportRequest) {
    setReq(request);
    let job: ImportJob;
    try {
      job = await startImport(archive.id, request);
    } catch (e) {
      setStep({ kind: 'failed', text: importFailure(e instanceof ApiError ? e.code : null) });
      return;
    }
    while (live.current) {
      setStep({ kind: 'running', job });
      if (job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 1500));
      try {
        job = await getImport(archive.id, job.id);
      } catch {
        setStep({
          kind: 'failed',
          text: 'Lost track of the import. Check Interviews to see whether it finished.',
        });
        return;
      }
    }
    if (!live.current) return;
    if (job.status !== 'succeeded' || !job.outcome) {
      setStep({ kind: 'failed', text: importFailure(job.error?.code ?? job.status) });
      return;
    }
    const o = job.outcome;
    if (o.status === 'needs_confirmation') setStep({ kind: 'confirm', jobId: job.id, outcome: o });
    else if (o.status === 'duplicate') setStep({ kind: 'duplicate', outcome: o });
    else if (o.status === 'saved') saved(o);
    else setStep({ kind: 'review', jobId: job.id, outcome: o });
  }

  return (
    <ArchiveLayout title="Add an interview">
      {step.kind === 'form' && (
        <TranscriptForm name={archive.subjectName} initial={req} onStart={(r) => void run(r)} />
      )}
      {step.kind === 'running' && (
        <Running
          job={step.job}
          onCancel={async () => {
            try {
              await cancelImport(archive.id, step.job.id);
            } catch {
              /* too late to stop: it finishes, and can be undone */
            }
          }}
        />
      )}
      {step.kind === 'failed' && (
        <div className="stack" style={{ gap: 6 }}>
          <h1 className="page-title">That didn’t work</h1>
          <Failed>{step.text}</Failed>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setStep({ kind: 'form' })}
            >
              Back to the transcript
            </button>
          </div>
        </div>
      )}
      {step.kind === 'confirm' && (
        <WhoIsTelling
          outcome={step.outcome}
          onChoose={(ids) => void run({ ...req, interviewees: ids, confirm: true })}
          onBack={() => setStep({ kind: 'form' })}
        />
      )}
      {step.kind === 'duplicate' && (
        <div className="stack" style={{ gap: 6 }}>
          <h1 className="page-title">This interview is already here</h1>
          <p className="notice notice-wonder">
            The same words were brought in
            {step.outcome.duplicateOf
              ? ` on ${new Date(step.outcome.duplicateOf.createdAt).toLocaleDateString()}`
              : ' before'}
            {step.outcome.duplicateOf?.source ? `, as “${step.outcome.duplicateOf.source}”` : ''}.
            Bringing it in again makes a second copy of every memory.
          </p>
          <div className="row">
            <Link to={inArchive(archive.id, '/interviews')} className="btn btn-primary">
              See the interviews
            </Link>
            <button type="button" className="btn" onClick={() => void run({ ...req, force: true })}>
              Bring it in again anyway
            </button>
          </div>
        </div>
      )}
      {step.kind === 'review' && (
        <Review
          archiveId={archive.id}
          jobId={step.jobId}
          outcome={step.outcome}
          name={archive.subjectName}
          onSaved={saved}
        />
      )}
      {step.kind === 'saved' && <Saved archiveId={archive.id} outcome={step.outcome} />}
    </ArchiveLayout>
  );
}

function TranscriptForm({
  name,
  initial,
  onStart,
}: {
  name: string;
  initial: ImportRequest;
  onStart: (r: ImportRequest) => void;
}) {
  const [transcript, setTranscript] = useState(initial.transcript);
  const [teller, setTeller] = useState(initial.teller ?? name);
  const [source, setSource] = useState(initial.source ?? '');
  const [fileError, setFileError] = useState<string | null>(null);

  async function openFile(file: File) {
    setFileError(null);
    try {
      setTranscript(await file.text());
      if (!source.trim()) setSource(file.name.replace(/\.[^.]+$/, ''));
    } catch {
      setFileError('That file could not be opened.');
    }
  }

  return (
    <>
      <div className="stack" style={{ gap: 3 }}>
        <h1 className="page-title">Add an interview</h1>
        <p className="muted" style={{ fontSize: 13 }}>
          Bring in the transcript of a conversation with {name}. It becomes memories in their own
          words, and you read every one before it joins the project.
        </p>
      </div>
      <form
        className="stack"
        style={{ gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          onStart({
            transcript,
            ...(teller.trim() ? { teller: teller.trim() } : {}),
            ...(source.trim() ? { source: source.trim() } : {}),
          });
        }}
      >
        <label className="field">
          The transcript
          <textarea
            className="textarea"
            data-testid="import-transcript"
            rows={12}
            required
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            placeholder={`Theo: Where did you grow up?\n${name}: On Garfield Avenue, in a house with a green door…`}
          />
          <span className="hint">
            Paste it here, or open the file. Plain text, subtitles (SRT, VTT) and WhisperX JSON all
            work. A name before each line helps tell who is speaking.
          </span>
        </label>
        <div className="row">
          <label className="btn btn-outline btn-sm" style={{ cursor: 'pointer' }}>
            Open a file…
            <input
              type="file"
              className="visually-hidden"
              accept=".txt,.srt,.vtt,.json,.md,text/plain,application/json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void openFile(f);
              }}
            />
          </label>
          {fileError && (
            <span role="alert" className="small" style={{ color: 'var(--danger)' }}>
              {fileError}
            </span>
          )}
        </div>
        <div className="grid-auto" style={{ '--min': '240px', gap: 8 } as CSSProperties}>
          <label className="field">
            Who is telling?
            <input className="input" value={teller} onChange={(e) => setTeller(e.target.value)} />
            <span className="hint">The person whose memories these are.</span>
          </label>
          <label className="field">
            What should we call this interview?
            <input
              className="input"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="The lake house summers"
            />
            <span className="hint">Written under each memory, so you know where it came from.</span>
          </label>
        </div>
        <div className="row">
          <button
            type="submit"
            className="btn btn-primary btn-lg"
            data-testid="import-start"
            disabled={transcript.trim() === ''}
          >
            Read it
          </button>
        </div>
      </form>
    </>
  );
}

function Running({ job, onCancel }: { job: ImportJob; onCancel: () => Promise<void> }) {
  const [stopping, setStopping] = useState(false);
  const { done, total } = job.progress;
  const pct = total > 0 ? Math.round((done / total) * 100) : 5;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <h1 className="page-title">Reading the interview…</h1>
      <p className="muted" style={{ fontSize: 15 }}>
        A long conversation takes a few minutes. You can leave this page open; nothing is saved
        until you’ve read it over.
      </p>
      <div className="card stack" style={{ gap: 8 }} role="status">
        <span style={{ fontWeight: 600 }}>{STAGE[job.stage]}</span>
        <div className="progress" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </div>
        {total > 0 && (
          <span className="small muted">
            {done} of {total}
          </span>
        )}
      </div>
      {job.canCancel && (
        <div className="row">
          <button
            type="button"
            className="btn btn-quiet"
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              void onCancel();
            }}
          >
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        </div>
      )}
    </div>
  );
}

function WhoIsTelling({
  outcome,
  onChoose,
  onBack,
}: {
  outcome: ImportOutcome;
  onChoose: (ids: string[]) => void;
  onBack: () => void;
}) {
  const [chosen, setChosen] = useState<string[]>(outcome.interviewees);
  const speakers = [...outcome.speakers].sort((a, b) => b.turns - a.turns);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="stack" style={{ gap: 5 }}>
        <h1 className="page-title">Who is telling?</h1>
        <p className="muted" style={{ fontSize: 15 }}>
          It wasn’t clear whose memories these are. Choose the people whose words should be kept as
          testimony; the others are the ones asking.
        </p>
      </div>
      <fieldset className="card stack" style={{ gap: 3, margin: 0 }}>
        <legend className="visually-hidden">Speakers</legend>
        {speakers.map((s) => (
          <label key={s.id} className="row" style={{ minHeight: 32, gap: 8 }}>
            <input
              type="checkbox"
              style={{ width: 22, height: 22, margin: 0, accentColor: 'var(--sage)' }}
              checked={chosen.includes(s.id)}
              onChange={(e) =>
                setChosen((c) => (e.target.checked ? [...c, s.id] : c.filter((x) => x !== s.id)))
              }
            />
            <span style={{ fontWeight: 600 }}>{s.id}</span>
            <span className="small muted">{count(s.turns, 'turn', 'turns')}</span>
          </label>
        ))}
      </fieldset>
      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={chosen.length === 0}
          onClick={() => onChoose(chosen)}
        >
          Go on
        </button>
        <button type="button" className="btn btn-quiet" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}

type Decision = 'ok' | 'out';

interface Edit {
  title: string;
  body: string;
  occurred: string;
}

/** Each memory, one at a time: it looks right, it needs a change, or it is left out. */
function Review({
  archiveId,
  jobId,
  outcome,
  name,
  onSaved,
}: {
  archiveId: string;
  jobId: string;
  outcome: ImportOutcome;
  name: string;
  onSaved: (o: ImportOutcome) => void;
}) {
  const memories = outcome.memories;
  const [at, setAt] = useState(0);
  const [decided, setDecided] = useState<Record<number, Decision>>({});
  const [edits, setEdits] = useState<Record<number, Edit>>({});
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<NoteSummary[]>([]);

  useEffect(() => {
    listNotes(archiveId)
      .then(setNotes)
      .catch(() => {
        /* links in a preview simply show as written */
      });
  }, [archiveId]);

  if (memories.length === 0) {
    return (
      <div className="stack" style={{ gap: 10 }}>
        <h1 className="page-title">No memories in this one</h1>
        <p className="muted">
          Nothing in the transcript could be kept as a memory. Nothing was saved.
        </p>
      </div>
    );
  }

  const m = memories[at]!;
  const edit = edits[at];
  const shown = {
    title: edit?.title ?? m.title,
    body: edit?.body ?? m.body,
    occurred: edit ? edit.occurred : (m.occurred ?? ''),
  };
  const left = memories.filter((_, i) => !decided[i]).length;
  const keeping = memories.filter((_, i) => decided[i] !== 'out').length;

  function decide(d: Decision) {
    const next = { ...decided, [at]: d };
    setDecided(next);
    setEditing(false);
    const open = memories.findIndex((_, i) => !next[i]);
    if (open >= 0) setAt(open);
  }

  async function save() {
    setSaving(true);
    setError(null);
    const patches: MemoryPatch[] = memories.map((mem, index) => {
      if (decided[index] === 'out') return { index, skip: true };
      const e = edits[index];
      if (!e) return { index };
      return {
        index,
        ...(e.title !== mem.title ? { title: e.title } : {}),
        ...(e.body !== mem.body ? { body: e.body } : {}),
        ...(e.occurred !== (mem.occurred ?? '') ? { occurred: e.occurred.trim() || null } : {}),
      };
    });
    try {
      onSaved(await saveImport(archiveId, jobId, patches));
    } catch (e) {
      const code = e instanceof ApiError ? e.code : null;
      setError(
        code === 'cannot_save'
          ? 'One of the memories could not be saved as it is: check its title and date (like 1987, 1987-03 or ~1948).'
          : e instanceof ApiError && e.status === 404
            ? 'This preview has expired. Bring the interview in again.'
            : 'Could not save. Try again in a moment.',
      );
      setSaving(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="stack" style={{ gap: 4 }}>
        <h1 className="page-title">A few things to read over</h1>
        <p className="muted">
          {count(memories.length, 'memory', 'memories')} from this interview. Nothing joins {name}’s
          project until you save it.
        </p>
      </div>

      <div className="review-dots" role="group" aria-label="Memories">
        {memories.map((mem, i) => {
          const d = decided[i];
          return (
            <button
              key={mem.id}
              type="button"
              className={`review-dot${d ? ` ${d}` : ''}`}
              aria-current={i === at}
              aria-label={`Memory ${i + 1}${d === 'ok' ? ', looks right' : d === 'out' ? ', left out' : ''}`}
              onClick={() => {
                setAt(i);
                setEditing(false);
              }}
            >
              {d === 'ok' ? '✓ ' : ''}
              {i + 1}
            </button>
          );
        })}
      </div>

      <article
        className="card stack"
        data-testid="review-memory"
        style={{ borderRadius: 8, padding: 'clamp(14px, 4vw, 23px)', gap: 12 }}
      >
        <span
          className={m.method === 'verbatim' ? 'pill pill-sage' : 'pill pill-keep'}
          style={{ alignSelf: 'flex-start' }}
        >
          {m.method === 'verbatim'
            ? m.speakerName
              ? `${m.speakerName}’s own words`
              : 'Their own words'
            : 'Tidied up by Firepit, checked against what was said'}
        </span>
        {editing ? (
          <MemoryEditor
            value={shown}
            onSave={(v) => {
              setEdits({ ...edits, [at]: v });
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <MemoryView memory={m} shown={shown} notes={notes} archiveId={archiveId} />
        )}

        {!editing && (
          <div className="row" style={{ paddingTop: 3, gap: 6 }}>
            <button type="button" className="btn btn-primary" onClick={() => decide('ok')}>
              <Icon name="check" stroke={2.6} />
              Looks right
            </button>
            <button type="button" className="btn" onClick={() => setEditing(true)}>
              Make a change
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => decide('out')}>
              Leave it out
            </button>
          </div>
        )}
        {decided[at] && !editing && (
          <p role="status" style={{ fontWeight: 600, color: 'var(--sage-ink)' }}>
            {decided[at] === 'ok'
              ? 'This one will be kept.'
              : 'Left out. You can change your mind until you save.'}
          </p>
        )}
      </article>

      {error && <Failed>{error}</Failed>}
      <div className="spread card" style={{ padding: '10px 13px' }}>
        <span className="muted">
          {left > 0 ? `${count(left, 'memory', 'memories')} still to read.` : 'All read.'} Saving
          keeps {count(keeping, 'memory', 'memories')}.
        </span>
        <button
          type="button"
          className="btn btn-primary"
          data-testid="import-save"
          disabled={saving || keeping === 0}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : `Save ${count(keeping, 'memory', 'memories')}`}
        </button>
      </div>
    </div>
  );
}

function MemoryView({
  memory,
  shown,
  notes,
  archiveId,
}: {
  memory: ImportMemory;
  shown: { title: string; body: string; occurred: string };
  notes: NoteSummary[];
  archiveId: string;
}) {
  const parts = splitNote(shown.body);
  return (
    <>
      {shown.occurred && <span className="small muted">{whenLabel(shown.occurred)}</span>}
      <h2 style={{ fontSize: 18, lineHeight: 1.15 }}>{shown.title}</h2>
      <div className="prose" style={{ fontSize: 16, gap: 9 }}>
        {parts.paragraphs.map((p, i) => (
          <p key={i}>
            <Linked text={p} notes={notes} archiveId={archiveId} />
          </p>
        ))}
      </div>
      {parts.provenance.length > 0 && (
        <div className="said">
          <span className="small" style={{ fontWeight: 600, color: 'var(--sage-ink)' }}>
            Where it came from
          </span>
          {parts.provenance.map((line, i) => (
            <span key={i} style={{ fontSize: 13 }}>
              {line}
            </span>
          ))}
        </div>
      )}
      {memory.notes.map((n, i) => (
        <p key={i} className="notice notice-wonder" style={{ color: 'var(--wonder-ink)' }}>
          {n}
        </p>
      ))}
      {(memory.conflicts ?? []).map((c, i) => (
        <div
          key={i}
          className="stack"
          style={{ background: 'var(--family)', borderRadius: 8, padding: '9px 12px', gap: 3 }}
        >
          <span className="small" style={{ fontWeight: 600, color: 'var(--family-ink)' }}>
            {c.source
              ? `May disagree with “${c.source.title}”`
              : 'May disagree with another memory'}
          </span>
          <span style={{ fontSize: 13 }}>
            That says “{c.existing}”. Both will be kept, and marked.
          </span>
        </div>
      ))}
    </>
  );
}

function MemoryEditor({
  value,
  onSave,
  onCancel,
}: {
  value: Edit;
  onSave: (v: Edit) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(value.title);
  const [occurred, setOccurred] = useState(value.occurred);
  const [body, setBody] = useState(value.body);
  return (
    <form
      className="stack"
      style={{ gap: 10 }}
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ title: title.trim() || value.title, occurred, body });
      }}
    >
      <label className="field">
        Title
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="field">
        When
        <input
          className="input"
          style={{ maxWidth: 320 }}
          value={occurred}
          onChange={(e) => setOccurred(e.target.value)}
          placeholder="1987 · 1987-03 · ~1948"
        />
        <span className="hint">If they weren’t sure, leave it empty or write ~ for “around”.</span>
      </label>
      <label className="field">
        Text
        <textarea
          className="textarea textarea-serif"
          rows={10}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <div className="row">
        <button type="submit" className="btn btn-primary">
          Done
        </button>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Saved({ archiveId, outcome }: { archiveId: string; outcome: ImportOutcome }) {
  const navigate = useNavigate();
  const saved = outcome.saved ?? [];
  return (
    <div className="stack" style={{ gap: 12 }}>
      <h1 className="page-title">Added to the project</h1>
      <p role="status" className="notice notice-sage">
        {count(saved.length, 'memory was', 'memories were')} saved. Thank you! If something’s not
        right, you can fix it on its page, or undo the whole interview from Interviews.
      </p>
      <ul className="list">
        {saved.map((s) => (
          <li key={s.id}>
            <Link to={noteHref(archiveId, { id: s.id, type: 'event' })} className="list-row">
              <span className="row-title" style={{ flex: 1 }}>
                {s.title}
              </span>
              <Icon name="next" />
            </Link>
          </li>
        ))}
      </ul>
      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void navigate(inArchive(archiveId, '/stories'))}
        >
          Read the stories
        </button>
        <button type="button" className="btn" onClick={() => window.location.reload()}>
          Add another interview
        </button>
      </div>
    </div>
  );
}
