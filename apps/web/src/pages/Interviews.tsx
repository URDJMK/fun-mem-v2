import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { listImports, undoImport, type ImportRun } from '../lib/api';
import { inArchive, useArchive } from '../lib/archive';
import { ArchiveLayout } from '../components/ArchiveLayout';
import { count, Failed, Icon, Loading } from '../components/ui';

const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Every interview brought into this archive, newest first, and a way to take one back. */
export function Interviews() {
  const archive = useArchive();
  const [runs, setRuns] = useState<ImportRun[] | null | 'failed'>(null);
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
  }, [archive.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function undo(run: ImportRun) {
    const name = run.source ? `“${run.source}”` : 'this interview';
    if (
      !window.confirm(
        `Take ${name} back out of the archive? Its memories are erased, except any someone has worked on since.`,
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
          <span className="muted">
            Every conversation brought into {archive.subjectName}’s archive
          </span>
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

      {runs === null ? (
        <Loading what="Opening the interviews…" />
      ) : runs === 'failed' ? (
        <Failed>Could not load the interviews. Reload the page.</Failed>
      ) : runs.length === 0 ? (
        <div className="empty stack" style={{ gap: 4 }}>
          <span className="title" style={{ fontSize: 15, color: 'var(--ink)' }}>
            No interviews yet
          </span>
          <span>
            Record a conversation with {archive.subjectName}, make a transcript of it, and bring it
            in here. You’ll read every memory before it’s kept.
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
                    {!gone && ` · ${count(r.notes, 'memory', 'memories')}`}
                    {r.mine && ' · brought in by you'}
                  </span>
                </span>
                {gone ? (
                  <span className="pill pill-soft">
                    {r.undone ? 'Taken back' : 'Its memories are gone'}
                  </span>
                ) : (
                  <span className="row">
                    <span className="pill pill-sage">In the archive</span>
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
