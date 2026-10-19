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
      <title>기억 목록 · 별의 기록</title>
      <Header />
      <main>
        <h1>{archive.subjectName}</h1>
        <section data-testid="note-list" aria-label="기억 목록">
          {notes === null ? (
            <p>기억을 여는 중입니다</p>
          ) : notes === 'failed' ? (
            <p role="alert">기억을 불러오지 못했습니다. 새로 고침해 주세요.</p>
          ) : notes.length === 0 ? (
            <p>아직 남긴 기억이 없습니다.</p>
          ) : (
            <>
              <p>{notes.length}개의 기억</p>
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
