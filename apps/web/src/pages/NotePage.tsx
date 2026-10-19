import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { EntityType } from '@funmem/core';
import {
  ApiError,
  deleteNote,
  getBacklinks,
  getNote,
  listNotes,
  updateNote,
  type Backlinks,
  type Note,
  type NoteSummary,
} from '../lib/api';
import { useArchive } from '../lib/archive';
import { missingTargets, piecesOf } from '../lib/links';
import { Header } from '../components/Header';
import { NoteForm } from '../components/NoteForm';

interface Loaded {
  note: Note;
  backlinks: Backlinks;
  /** every note the reader can see: what the note's `[[links]]` resolve against */
  notes: NoteSummary[];
}

/** One memory: read it, follow its links, see what links to it, change it, delete it. */
export function NotePage({ noteId }: { noteId: string }) {
  const archive = useArchive();
  const navigate = useNavigate();
  const [data, setData] = useState<Loaded | 'loading' | 'missing' | 'failed'>('loading');
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const [note, backlinks, notes] = await Promise.all([
        getNote(archive.id, noteId),
        getBacklinks(archive.id, noteId),
        listNotes(archive.id),
      ]);
      setData({ note, backlinks, notes });
    } catch (e) {
      setData(e instanceof ApiError && e.status === 404 ? 'missing' : 'failed');
    }
  }, [archive.id, noteId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (data === 'loading') return <p>기억을 여는 중입니다</p>;
  if (data === 'missing' || data === 'failed') {
    return (
      <>
        <Header />
        <main>
          <p role="alert">
            {data === 'missing'
              ? '이 기억을 찾지 못했습니다. 지워졌거나, 볼 수 없는 기억입니다.'
              : '기억을 불러오지 못했습니다. 새로 고침해 주세요.'}
          </p>
          <p>
            <Link to="/">기억 목록으로</Link>
          </p>
        </main>
      </>
    );
  }

  const { note, backlinks, notes } = data;
  const missing = missingTargets(note.body, notes);

  async function remove() {
    if (!window.confirm(`“${note.title}” 기억을 지울까요? 지운 기억은 되돌릴 수 없습니다.`)) return;
    setDeleting(true);
    setDeleteFailed(false);
    try {
      await deleteNote(archive.id, note.id);
      void navigate('/', { replace: true });
    } catch {
      setDeleteFailed(true);
      setDeleting(false);
    }
  }

  return (
    <>
      <title>{`${note.title} · 별의 기록`}</title>
      <Header />
      <main>
        {editing ? (
          <NoteForm
            initial={{
              title: note.title,
              type: note.type as EntityType,
              body: note.body,
              occurred: note.occurred,
            }}
            withType={false}
            onSave={async (v) => {
              await updateNote(archive.id, note.id, {
                title: v.title,
                body: v.body,
                occurred: v.occurred,
              });
              setEditing(false);
              await load();
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <article data-testid="note">
            <h1 data-testid="note-heading">{note.title}</h1>
            <dl>
              <dt>type</dt>
              <dd>{note.type}</dd>
              {note.occurred && (
                <>
                  <dt>occurred</dt>
                  <dd>{note.occurred}</dd>
                </>
              )}
              {note.revised && (
                <>
                  <dt>revised</dt>
                  <dd>{note.revised}</dd>
                </>
              )}
            </dl>
            {/* line breaks are part of the words, so they are kept */}
            <div data-testid="note-text" style={{ whiteSpace: 'pre-wrap' }}>
              {piecesOf(note.body, notes).map((p, i) =>
                p.kind === 'text' ? (
                  p.text
                ) : (
                  <Link key={i} to={`/note/${p.noteId}`} data-testid="note-link">
                    {p.label}
                  </Link>
                ),
              )}
            </div>
            {archive.writer && missing.length > 0 && (
              <ul>
                {missing.map((t) => (
                  <li key={t}>
                    <Link to={`/new?title=${encodeURIComponent(t)}`} data-testid="create-note">
                      “{t}” 새로 만들기
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {archive.writer && (
              <p>
                <button type="button" data-testid="note-edit" onClick={() => setEditing(true)}>
                  고치기
                </button>{' '}
                <button
                  type="button"
                  data-testid="note-delete"
                  disabled={deleting}
                  onClick={() => void remove()}
                >
                  {deleting ? '지우는 중' : '지우기'}
                </button>
              </p>
            )}
            {deleteFailed && <p role="alert">지우지 못했습니다.</p>}
          </article>
        )}

        <aside data-testid="backlinks">
          <h2>Backlinks</h2>
          {backlinks.occurrences.length === 0 ? (
            <p>아직 이 기억을 부르는 곳이 없습니다.</p>
          ) : (
            <ul>
              {backlinks.occurrences.map((o, i) => (
                <li key={`${o.sourceId}-${i}`} data-testid="backlink-row">
                  <Link to={`/note/${o.sourceId}`}>{o.sourceTitle}</Link>
                  {o.sourceOccurred ? ` · ${o.sourceOccurred}` : ''}
                  <br />
                  {o.snippet}
                </li>
              ))}
            </ul>
          )}
          {/* say it was cut: a short list that looks complete is a quiet lie */}
          {backlinks.truncated && (
            <p data-testid="backlinks-truncated">
              {backlinks.total}개의 언급 중 {backlinks.occurrences.length}개를 보이고 있습니다.
            </p>
          )}
        </aside>
      </main>
    </>
  );
}
