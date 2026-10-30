import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  getInterview,
  listImports,
  listInterviews,
  undoImport,
  type ImportRun,
  type InterviewSummary,
} from '../lib/api';
import { inArchive, useArchive } from '../lib/archive';
import { ArchiveLayout } from '../components/ArchiveLayout';
import { count, Failed, Icon, Loading } from '../components/ui';

const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Every interview brought into this archive, newest first, and a way to take one back. */
export function Interviews() {
  const archive = useArchive();
  const navigate = useNavigate();
  const [runs, setRuns] = useState<ImportRun[] | null | 'failed'>(null);
  // interviews whose stories are not written yet: their transcript is kept, waiting
  const [waiting, setWaiting] = useState<InterviewSummary[]>([]);
  const [opening, setOpening] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  // the server decides who may undo whose import; this only hides a button that would be refused
  const mayUndoAny = archive.role === 'owner' || archive.role === 'steward';

  const load = useCallback(async () => {
    try {
      setRuns(await listImports(archive.id));
    } catch {
      setRuns('failed');
    }
    // the older memory import keeps no interviews: an empty list is normal
    listInterviews(archive.id)
      .then((all) => setWaiting(all.filter((i) => i.status === 'pending')))
      .catch(() => setWaiting([]));
  }, [archive.id]);

  /** write the stories of a waiting interview, from its kept transcript */
  async function writeStories(i: InterviewSummary) {
    setOpening(i.id);
    setSaid(null);
    try {
      const it = await getInterview(archive.id, i.id);
      void navigate(inArchive(archive.id, '/interviews/new'), {
        state: {
          request: {
            transcript: it.transcript,
            source: it.name,
            ...(it.options.teller ? { teller: it.options.teller } : {}),
            ...(it.options.interviewees ? { interviewees: it.options.interviewees } : {}),
          },
        },
      });
    } catch {
      setSaid({ ok: false, text: 'Could not open that interview. Try again in a moment.' });
      setOpening(null);
    }
  }

  useEffect(() => {
    void load();
  }, [load]);

  async function undo(run: ImportRun) {
    const name = run.source ? `“${run.source}”` : 'this interview';
    if (
      !window.confirm(
        `Take ${name} back out of the project? Its memories are erased, except any someone has worked on since.`,
      )
    )
      return;
    setUndoing(run.id);
    setSaid(null);
    try {
      const r = await undoImport(archive.id, run.id);
      setSaid({
        ok: true,
        text:
          `Erased ${count(r.erased, 'memory', 'memories')}.` +
          (r.kept.length > 0
            ? ` Kept ${count(r.kept.length, 'memory', 'memories')} someone has worked on since: ${r.kept.map((k) => k.title).join(', ')}.`
            : ''),
      });
      await load();
    } catch {
      setSaid({ ok: false, text: 'Could not take it back. Try again in a moment.' });
    } finally {
      setUndoing(null);
    }
  }

  return (
    <ArchiveLayout title="Interviews">
      <div className="spread" style={{ alignItems: 'flex-end' }}>
        <div className="stack" style={{ gap: 3 }}>
          <h1 className="page-title">Interviews</h1>
          <span className="muted">Every conversation brought into {archive.subjectName}</span>
        </div>
        {archive.writer && (
          <Link to={inArchive(archive.id, '/interviews/new')} className="btn btn-primary">
            <Icon name="plus" />
            Add an interview
          </Link>
        )}
      </div>

      {said &&
        (said.ok ? (
          <p role="status" className="notice notice-sage">
            {said.text}
          </p>
        ) : (
          <Failed>{said.text}</Failed>
        ))}

      {waiting.length > 0 && (
        <section className="stack" style={{ gap: 6 }} aria-label="Waiting for their stories">
          <h2 className="label-heading">Waiting for their stories</h2>
          <ul className="list" data-testid="waiting-interviews">
            {waiting.map((i) => (
              <li key={i.id} className="list-row">
                <span className="stack" style={{ flex: '1 1 260px' }}>
                  <span className="row-title">{i.name}</span>
                  <span className="small muted">
                    {new Date(i.recordedAt).toLocaleDateString(undefined, {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })}
                    {' · '}Stories not written yet; the transcript is kept
                  </span>
                </span>
                {archive.writer && (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={opening !== null}
                    onClick={() => void writeStories(i)}
                  >
                    {opening === i.id ? 'Opening…' : 'Write the stories'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {runs === null ? (
        <Loading what="Opening the interviews…" />
      ) : runs === 'failed' ? (
        <Failed>Could not load the interviews. Reload the page.</Failed>
      ) : runs.length === 0 ? (
        <div className="empty stack" style={{ gap: 4 }}>
          <span className="title t-small" style={{ color: 'var(--ink)' }}>
            No interviews yet
          </span>
          <span>
            Record a conversation with{' '}
            {archive.kind === 'family' ? 'someone in the family' : archive.subjectName}, make a
            transcript of it, and bring it in here. You’ll read every memory before it’s kept.
          </span>
        </div>
      ) : (
        <ul className="list" data-testid="import-list">
          {runs.map((r) => {
            const d = new Date(r.createdAt);
            const gone = r.undone || r.source === null;
            return (
              <li key={r.id} className="list-row">
                <span aria-hidden="true" className="date-tile">
                  <span className="mon">{MON[d.getMonth()]}</span>
                  <span className="day">{d.getDate()}</span>
                </span>
                <span className="stack" style={{ flex: '1 1 260px' }}>
                  <span className="row-title">{r.source ?? 'An interview'}</span>
                  <span className="small muted">
                    {d.toLocaleDateString(undefined, {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })}
                    {!gone && ` · ${count(r.notes, 'note', 'notes')}`}
                    {r.mine && ' · brought in by you'}
                  </span>
                </span>
                {gone ? (
                  <span className="pill pill-soft">
                    {r.undone ? 'Taken back' : 'Its memories are gone'}
                  </span>
                ) : (
                  <span className="row">
                    <span className="pill pill-sage">In the project</span>
                    {archive.writer && (r.mine || mayUndoAny) && (
                      <button
                        type="button"
                        className="btn btn-quiet btn-sm"
                        disabled={undoing !== null}
                        onClick={() => void undo(r)}
                      >
                        {undoing === r.id ? 'Taking it back…' : 'Undo'}
                      </button>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </ArchiveLayout>
  );
}
