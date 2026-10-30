import { useEffect, useRef, useState } from 'react';
import { GraphReview, keptCount, NO_CHOICES, patchOf, type GraphChoices } from './GraphReview';
import { Link, useNavigate } from 'react-router';
import {
  ApiError,
  getImport,
  listEntities,
  listNotes,
  saveImport,
  startImport,
  type ImportJob,
  type EntitySummary,
  type ImportMemory,
  type ImportOutcome,
  type ImportRequest,
  type MemoryPatch,
  type NoteSummary,
  startGraphBuild,
} from '../lib/api';
import { inArchive, noteHref } from '../lib/archive';
import { previewStory } from '../lib/graph-review';
import { Linked, splitNote } from './NoteText';
import { count, Failed, Icon, whenLabel } from './ui';

/** What went wrong, in words a person can act on (docs/ingest/api.md, Errors). */
export function importFailure(code: string | null | undefined): string {
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

/** Why starting was refused, when it wasn't handed off to the job already in the way. */
function busyText(reason: string | null): string {
  switch (reason) {
    case 'user':
      return 'You already have two interviews being brought in elsewhere. Wait for one to finish, then try again.';
    case 'previews':
      return 'This project is holding too many unsaved interviews already. Save or let one go, then try again.';
    case 'archive':
      return 'Someone else is already bringing in an interview for this project. Wait a minute and try again.';
    default:
      return 'The server is busy with other imports. Wait a minute and try again.';
  }
}

const STAGE: Record<ImportJob['stage'], string> = {
  reading: 'Reading the transcript',
  organizing: 'Finding the stories and writing them',
  checking: 'Checking each story against what was said, and against the project',
  saving: 'Saving',
  done: 'Done',
};

export type RunStep =
  | { kind: 'running'; job: ImportJob }
  | { kind: 'failed'; text: string }
  | { kind: 'confirm'; jobId: string; outcome: ImportOutcome }
  | { kind: 'duplicate'; outcome: ImportOutcome }
  | { kind: 'review'; jobId: string; outcome: ImportOutcome }
  | { kind: 'saved'; outcome: ImportOutcome };

/**
 * Starts an import, or resumes watching one already running, and follows it until it finishes:
 * a long interview takes a few minutes, and the job outlives whatever page is looking at it.
 * Shared by the manual "Add an interview" page and the live interview's "Write the stories",
 * so leaving and coming back never loses track of it or starts a second one by mistake.
 */
export function useImportRun(
  archiveId: string,
  opts: { onStarted?: (jobId: string) => void; onSaved?: (o: ImportOutcome) => void } = {},
): {
  step: RunStep | null;
  req: ImportRequest | null;
  run: (request: ImportRequest) => Promise<void>;
  /** "Find people, places and things": the graph from the saved stories (graph design 4.4) */
  build: () => Promise<void>;
  resume: (jobId: string) => Promise<void>;
  /** `<Review>` saves directly (outside the poll loop) and reports the outcome here. */
  saved: (outcome: ImportOutcome) => void;
  reset: () => void;
} {
  const [step, setStep] = useState<RunStep | null>(null);
  const [req, setReq] = useState<ImportRequest | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  function saved(outcome: ImportOutcome) {
    opts.onSaved?.(outcome);
    setStep({ kind: 'saved', outcome });
  }

  async function poll(initial: ImportJob) {
    let job = initial;
    while (live.current) {
      setStep({ kind: 'running', job });
      if (job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 1500));
      try {
        job = await getImport(archiveId, job.id);
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

  async function resume(jobId: string) {
    let job: ImportJob;
    try {
      job = await getImport(archiveId, jobId);
    } catch {
      setStep({
        kind: 'failed',
        text: 'Lost track of the import. Check Interviews to see whether it finished.',
      });
      return;
    }
    await poll(job);
  }

  async function run(request: ImportRequest | null) {
    setReq(request);
    let job: ImportJob;
    try {
      job = request ? await startImport(archiveId, request) : await startGraphBuild(archiveId);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'busy') {
        // the server names the job already in the way when it is this same person's own: follow
        // that one instead of a dead end (ingest-jobs.ts: "the id is only worth giving to...")
        if (e.jobId) {
          opts.onStarted?.(e.jobId);
          await resume(e.jobId);
          return;
        }
        setStep({ kind: 'failed', text: busyText(e.reason) });
        return;
      }
      setStep({ kind: 'failed', text: importFailure(e instanceof ApiError ? e.code : null) });
      return;
    }
    opts.onStarted?.(job.id);
    await poll(job);
  }

  function reset() {
    setStep(null);
    setReq(null);
  }

  return { step, req, run, build: () => run(null), resume, saved, reset };
}

export function Running({
  job,
  onCancel,
  graph = false,
}: {
  job: ImportJob;
  onCancel: () => Promise<void>;
  /** the button's run: reading the saved stories, not an interview */
  graph?: boolean;
}) {
  const [stopping, setStopping] = useState(false);
  const { done, total } = job.progress;
  const pct = total > 0 ? Math.round((done / total) * 100) : 5;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <h1 className="page-title">{graph ? 'Reading the stories…' : 'Reading the interview…'}</h1>
      <p className="muted t-small">
        A few minutes. You can leave this page; nothing is saved until you’ve read it over.
      </p>
      <div className="card stack" style={{ gap: 8 }} role="status">
        <span>
          {graph && job.stage === 'organizing'
            ? 'Finding the people, places and things'
            : STAGE[job.stage]}
        </span>
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

export function WhoIsTelling({
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
        <p className="muted t-small">
          It wasn’t clear whose memories these are. Choose the people whose words should be kept as
          testimony; the others are the ones asking.
        </p>
      </div>
      <fieldset className="card stack" style={{ gap: 3, margin: 0 }}>
        <legend className="visually-hidden">Speakers</legend>
        {speakers.map((s) => (
          <label key={s.id} className="row" style={{ minHeight: 44, gap: 8 }}>
            <input
              type="checkbox"
              style={{ width: 22, height: 22, margin: 0, accentColor: 'var(--ink)' }}
              checked={chosen.includes(s.id)}
              onChange={(e) =>
                setChosen((c) => (e.target.checked ? [...c, s.id] : c.filter((x) => x !== s.id)))
              }
            />
            <span>{s.id}</span>
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
export function Review({
  archiveId,
  jobId,
  outcome,
  name,
  onSaved,
  onRetry,
}: {
  archiveId: string;
  jobId: string;
  outcome: ImportOutcome;
  name: string;
  onSaved: (o: ImportOutcome) => void;
  /** write the stories again from the same transcript (when they could not be written) */
  onRetry?: () => void;
}) {
  const memories = outcome.memories;
  const stories = memories.some((x) => x.method === 'story');
  const unit: [string, string] = stories ? ['story', 'stories'] : ['memory', 'memories'];
  const [at, setAt] = useState(0);
  const [decided, setDecided] = useState<Record<number, Decision>>({});
  const [edits, setEdits] = useState<Record<number, Edit>>({});
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [knownEntities, setKnownEntities] = useState<EntitySummary[]>([]);
  const [graphChoices, setGraphChoices] = useState<GraphChoices>(NO_CHOICES);

  useEffect(() => {
    listNotes(archiveId)
      .then(setNotes)
      .catch(() => {
        /* links in a preview simply show as written */
      });
    listEntities(archiveId)
      .then(setKnownEntities)
      .catch(() => {
        /* the proposal still carries its matched notes */
      });
  }, [archiveId]);

  if (outcome.pending) {
    return (
      <div className="stack" style={{ gap: 10 }} data-testid="stories-pending">
        <h1 className="page-title">Stories not written yet</h1>
        <p className="muted">{PENDING[outcome.pending.reason] ?? PENDING.unavailable}</p>
        <p className="muted">
          The transcript is kept with the interview, so nothing is lost. You can write its stories
          again from here, or later from Interviews.
        </p>
        {onRetry && (
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={onRetry}>
              Try again
            </button>
          </div>
        )}
      </div>
    );
  }

  // the button's run: only people, places and things, in stories already saved
  if (outcome.format === 'graph' && outcome.graph) {
    const g = outcome.graph;
    const kept = keptCount(g, graphChoices, () => true);
    return (
      <div className="stack" style={{ gap: 14 }}>
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="page-title">People, places and things in your stories</h1>
          <p className="muted">Nothing joins the graph until you save it.</p>
        </div>
        {!g.pending && g.entities.length === 0 ? (
          <p className="notice notice-sage" role="status">
            Nothing new: everyone and everything the stories name is in the graph already.
          </p>
        ) : (
          <GraphReview
            archiveId={archiveId}
            graph={g}
            storyTitle={(id) => notes.find((n) => n.id === id)?.title ?? 'a story'}
            storyKept={() => true}
            choices={graphChoices}
            onChange={setGraphChoices}
            knownEntities={knownEntities}
            noteTitles={new Map(notes.map((n) => [n.id, n.title]))}
            standalone
          />
        )}
        {error && <Failed>{error}</Failed>}
        {!g.pending && g.entities.length > 0 && (
          <div className="spread card" style={{ padding: '10px 13px' }}>
            <span className="muted">
              Saving keeps {count(kept, 'person, place or thing', 'people, places and things')}.
            </span>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="import-save"
              disabled={saving || kept === 0}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save them'}
            </button>
          </div>
        )}
      </div>
    );
  }

  if (memories.length === 0) {
    return (
      <div className="stack" style={{ gap: 10 }}>
        <h1 className="page-title">No stories in this one</h1>
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
  const storyKept = (id: string) => {
    const i = memories.findIndex((x) => x.id === id);
    return i >= 0 && decided[i] !== 'out';
  };
  const preview = outcome.graph
    ? previewStory(shown.body, outcome.graph, graphChoices, storyKept, knownEntities, notes)
    : undefined;

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
      onSaved(
        await saveImport(
          archiveId,
          jobId,
          patches,
          outcome.graph ? patchOf(graphChoices) : undefined,
        ),
      );
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
          {count(memories.length, ...unit)} from this interview. Nothing joins {name}’s project
          until you save it.
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
              aria-label={`${stories ? 'Story' : 'Memory'} ${i + 1}${d === 'ok' ? ', looks right' : d === 'out' ? ', left out' : ''}`}
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
          {m.method === 'story'
            ? 'Written by Firepit from what was said, checked that nothing is made up'
            : m.method === 'verbatim'
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
          <MemoryView
            memory={m}
            shown={{ ...shown, body: preview?.body ?? shown.body }}
            notes={notes}
            archiveId={archiveId}
            proposed={preview?.proposed}
          />
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
          <p role="status" style={{ color: 'var(--ink)' }}>
            {decided[at] === 'ok' ? 'Kept' : 'Left out'}
          </p>
        )}
      </article>

      {outcome.graph && (
        <GraphReview
          archiveId={archiveId}
          graph={outcome.graph}
          storyTitle={(id) => memories.find((x) => x.id === id)?.title ?? 'a story'}
          storyKept={storyKept}
          choices={graphChoices}
          onChange={setGraphChoices}
          knownEntities={knownEntities}
          noteTitles={new Map(notes.map((n) => [n.id, n.title]))}
        />
      )}

      {error && <Failed>{error}</Failed>}
      <div className="spread card" style={{ padding: '10px 13px' }}>
        <span className="muted">
          {left > 0 ? `${count(left, ...unit)} still to read.` : 'All read.'} Saving keeps{' '}
          {count(keeping, ...unit)}.
        </span>
        <button
          type="button"
          className="btn btn-primary"
          data-testid="import-save"
          disabled={saving || keeping === 0}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : `Save ${count(keeping, ...unit)}`}
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
  proposed,
}: {
  memory: ImportMemory;
  shown: { title: string; body: string; occurred: string };
  notes: NoteSummary[];
  archiveId: string;
  proposed?: ReadonlyMap<string, boolean>;
}) {
  const parts = splitNote(shown.body);
  const [showSources, setShowSources] = useState(false);
  const told = memory.tellers?.length ? `told by ${memory.tellers.join(' and ')}` : null;
  const span = clockSpan(memory.startSec ?? null, memory.endSec ?? null);
  // a date worked out from an age ("Around 1964 (Sunja was 18; born about 1946)"), while it stands
  const when = whenLabel(shown.occurred);
  const basis =
    memory.dateBasis && shown.occurred === (memory.occurred ?? '') ? memory.dateBasis : null;
  const meta = [when ? (basis ? `${when} (${basis})` : when) : null, told, span]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      {meta && <span className="small muted">{meta}</span>}
      <h2 className="t-body">{shown.title}</h2>
      <div className="prose" style={{ gap: 9 }}>
        {parts.paragraphs.map((p, i) => (
          <p key={i}>
            <Linked text={p} notes={notes} archiveId={archiveId} proposed={proposed} />
          </p>
        ))}
      </div>
      {parts.provenance.length > 0 && (
        <div className="said">
          <span className="small" style={{ color: 'var(--ink)' }}>
            Where it came from
          </span>
          {parts.provenance.map((line, i) => (
            <span key={i} className="t-small">
              {line}
            </span>
          ))}
        </div>
      )}
      {(memory.sources?.length ?? 0) > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <button
            type="button"
            className="btn btn-quiet btn-sm"
            style={{ alignSelf: 'flex-start' }}
            aria-expanded={showSources}
            onClick={() => setShowSources((v) => !v)}
          >
            {showSources ? 'Hide where this comes from' : 'Where this comes from'}
          </button>
          {showSources && (
            <ol className="stack" style={{ gap: 8, paddingLeft: 18, margin: 0 }}>
              {memory.sources!.map((s, i) => (
                <li key={i} className="small">
                  <span>{s.sentence}</span>
                  <span
                    className="said"
                    style={{ display: 'block', whiteSpace: 'pre-line', marginTop: 3 }}
                  >
                    {clockSpan(s.start, s.end) ? `${clockSpan(s.start, s.end)} · ` : ''}
                    {s.text}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {memory.notes.map((n, i) => (
        <p key={i} className="notice notice-wonder" style={{ color: 'var(--ink)' }}>
          {n}
        </p>
      ))}
      {(memory.conflicts ?? []).map((c, i) => (
        <div
          key={i}
          className="stack"
          style={{ background: 'var(--canvas)', borderRadius: 8, padding: '9px 12px', gap: 3 }}
        >
          <span className="small" style={{ color: 'var(--ink)' }}>
            {c.source
              ? `May disagree with “${c.source.title}”`
              : 'May disagree with another memory'}
          </span>
          <span className="t-small">That says “{c.existing}”. Both will be kept, and marked.</span>
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

export function Saved({
  archiveId,
  outcome,
  onRestart,
}: {
  archiveId: string;
  outcome: ImportOutcome;
  /** "Add another interview": defaults to reloading the page (the manual import form's reset) */
  onRestart?: () => void;
}) {
  const navigate = useNavigate();
  const saved = outcome.saved ?? [];
  if (outcome.format === 'graph' && outcome.graph) {
    return (
      <div className="stack" style={{ gap: 12 }}>
        <h1 className="page-title">Added to the graph</h1>
        <p role="status" className="notice notice-sage">
          {count(
            outcome.graph.entities.length,
            'person, place or thing',
            'people, places and things',
          )}{' '}
          from your stories, with how they relate. If something’s not right, you can change it on
          its page, or undo the whole lot from Interviews.
        </p>
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => (onRestart ? onRestart() : void navigate(inArchive(archiveId)))}
          >
            See them
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: 12 }}>
      <h1 className="page-title">Added to the project</h1>
      <p role="status" className="notice notice-sage">
        {count(
          saved.length,
          ...((outcome.memories.some((m) => m.method === 'story')
            ? ['story was', 'stories were']
            : ['memory was', 'memories were']) as [string, string]),
        )}{' '}
        saved
        {outcome.graph && outcome.graph.entities.length > 0
          ? `, with ${count(outcome.graph.entities.length, 'person, place or thing', 'people, places and things')} for the graph`
          : ''}
        . Thank you! If something’s not right, you can fix it on its page, or undo the whole
        interview from Interviews.
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
        <button
          type="button"
          className="btn"
          onClick={onRestart ?? (() => window.location.reload())}
        >
          Add another interview
        </button>
      </div>
    </div>
  );
}

/** Why the stories could not be written yet (server/api/src/ingest-pipeline.ts, StoriesPendingReason). */
const PENDING: Record<string, string> = {
  no_model: 'Writing stories needs the AI, and it is not set up here yet.',
  auth: 'The AI service refused our key. Whoever runs Firepit needs to renew it.',
  unavailable: 'The AI service did not answer just now.',
  deadline: 'Writing the stories took too long and was stopped.',
  budget: 'This interview needed more AI work than one import may use. Try a shorter part of it.',
  bad_plan: 'The AI could not make sense of this interview just now.',
};

/** "0:03–1:56" in the recording, or one time, or nothing when the transcript had no times. */
function clockSpan(start: number | null, end: number | null): string | null {
  if (start === null) return null;
  const c = (sec: number) => {
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
    return `${h ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
  };
  return end === null || c(end) === c(start) ? c(start) : `${c(start)}–${c(end)}`;
}
