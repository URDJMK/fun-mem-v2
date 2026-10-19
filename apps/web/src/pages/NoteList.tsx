import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { listNotes, type NoteSummary } from '../lib/api';
import { useArchive } from '../lib/archive';
import { typeLabel } from '../lib/words';
import { Header } from '../components/Header';

/** The archive's home: every memory the reader can see, newest change first. */
export function NoteList() {
  const archive = useArchive();
  const [notes, setNotes] = useState<NoteSummary[] | null | 'failed'>(null);

  useEffect(() => {
    let live = true;
    listNotes(archive.id)
      .then((n) => live && setNotes(n))
      .catch(() => live && setNotes('failed'));
    return () => {
      live = false;
    };
  }, [archive.id]);

  return (
    <>
      <title>Memories · fun-mem</title>
      <Header />
      <main>
        <h1>{archive.subjectName}</h1>
        <section data-testid="note-list" aria-label="Memories">
          {notes === null ? (
            <p>Opening the memories…</p>
          ) : notes === 'failed' ? (
            <p role="alert">Could not load the memories. Reload the page.</p>
          ) : notes.length === 0 ? (
            <p>No memories yet.</p>
          ) : (
            <>
              <p>{notes.length === 1 ? '1 memory' : `${notes.length} memories`}</p>
              <ul>
                {notes.map((n) => (
                  <li key={n.id}>
                    <Link to={`/note/${n.id}`}>{n.title}</Link>
                    {' — '}
                    {typeLabel(n.type)}
                    {n.occurred ? ` · ${n.occurred}` : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </main>
    </>
  );
}
