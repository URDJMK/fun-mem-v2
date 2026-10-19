import { useNavigate, useSearchParams } from 'react-router';
import { createNote } from '../lib/api';
import { useArchive } from '../lib/archive';
import { Header } from '../components/Header';
import { NoteForm } from '../components/NoteForm';

/** A new memory. `?title=` comes from a `[[link]]` to a memory that is not written yet. */
export function NewNote() {
  const archive = useArchive();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  return (
    <>
      <title>기억 남기기 · 별의 기록</title>
      <Header />
      <main>
        <p>Leave a memory</p>
        <h1>기억을 남깁니다</h1>
        {archive.writer ? (
          <NoteForm
            initial={{ title: params.get('title') ?? '', type: 'event', body: '', occurred: null }}
            withType
            onSave={async (v) => {
              const note = await createNote(archive.id, v);
              void navigate(`/note/${note.id}`, { replace: true });
            }}
            onCancel={() => void navigate(-1)}
          />
        ) : (
          <p>이 기록에서는 읽기만 할 수 있습니다.</p>
        )}
      </main>
    </>
  );
}
