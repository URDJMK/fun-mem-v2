import { useNavigate, useSearchParams } from 'react-router';
import { ENTITY_TYPES, type EntityType } from '@funmem/core';
import { createNote } from '../lib/api';
import { noteHref, useArchive } from '../lib/archive';
import { ArchiveLayout } from '../components/ArchiveLayout';
import { NoteForm } from '../components/NoteForm';

/**
 * A new memory. `?title=` comes from a `[[link]]` to a memory that is not written yet, and
 * `?type=` from the page it was started on (a person from People & places).
 */
export function NewNote() {
  const archive = useArchive();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const asked = params.get('type') ?? '';
  const type: EntityType = (ENTITY_TYPES as readonly string[]).includes(asked)
    ? (asked as EntityType)
    : 'event';

  return (
    <ArchiveLayout title="Write a memory">
      <div className="stack" style={{ gap: 4 }}>
        <h1 className="page-title">Write a memory</h1>
        <p className="muted">
          {archive.kind === 'family'
            ? 'Something you remember about the family, or something one of them told you.'
            : `Something you remember about ${archive.subjectName}, or something they told you.`}
        </p>
      </div>
      {archive.writer ? (
        <div className="card" style={{ borderRadius: 8 }}>
          <NoteForm
            initial={{ title: params.get('title') ?? '', type, body: '', occurred: null }}
            withType
            onSave={async (v) => {
              const note = await createNote(archive.id, v);
              void navigate(noteHref(archive.id, note), { replace: true });
            }}
            onCancel={() => void navigate(-1)}
          />
        </div>
      ) : (
        <p className="notice notice-wonder">In this project you can read, but not write.</p>
      )}
    </ArchiveLayout>
  );
}
